import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';

const APP_BASE_URL = process.env.INVOICE_APP_BASE_URL;
const RUNNER_SECRET = process.env.INVOICE_RUNNER_SECRET;
const META_STORAGE_STATE = process.env.META_STORAGE_STATE || 'meta-storage-state.json';
const META_USER_DATA_DIR = process.env.META_USER_DATA_DIR || '';
const META_HEADLESS = process.env.META_HEADLESS === '1';
const MAX_BROWSER_RECOVERIES = Number(process.env.INVOICE_BROWSER_RECOVERIES || 1);

if (!APP_BASE_URL || !RUNNER_SECRET) {
  throw new Error('INVOICE_APP_BASE_URL and INVOICE_RUNNER_SECRET are required');
}

async function appApi(apiPath) {
  const response = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}${apiPath}`, {
    headers: { Authorization: `Bearer ${RUNNER_SECRET}` },
  });
  if (!response.ok) throw new Error(`${apiPath} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function listSubscriptions() {
  const payload = await appApi('/api/invoices/subscriptions');
  return payload.subscriptions || [];
}

function groupSubscriptions(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const accountId = String(row.meta_account_id).replace(/^act_/, '');
    const current = grouped.get(accountId) || {
      accountId,
      accountName: row.account_name,
      currency: row.currency || null,
      earliestStartDate: row.start_date,
      subscriptions: [],
    };
    if (row.start_date < current.earliestStartDate) current.earliestStartDate = row.start_date;
    current.subscriptions.push(row);
    grouped.set(accountId, current);
  }
  return [...grouped.values()];
}

function normalizeDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseInvoiceDate(text = '') {
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return normalizeDate(iso[1], iso[2], iso[3]);
  const dmy = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (dmy) return normalizeDate(dmy[3], dmy[2], dmy[1]);
  const months = { jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12 };
  const named = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (named) return normalizeDate(named[3], months[named[1].toLowerCase()], named[2]);
  return null;
}

function parseMoney(text = '') {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/(?:USD|EUR|UAH|PLN|GBP|\$|€|£)\s*([\d.,]+(?:[.,]\d{2})?)/i)
    || cleaned.match(/([\d.,]+(?:[.,]\d{2})?)\s*(?:USD|EUR|UAH|PLN|GBP)/i);
  if (!match) return null;
  const normalized = match[1].replace(/,(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseCurrency(text = '', fallback = null) {
  if (/\bUSD\b|\$/i.test(text)) return 'USD';
  if (/\bEUR\b|€/i.test(text)) return 'EUR';
  if (/\bUAH\b|₴/i.test(text)) return 'UAH';
  if (/\bPLN\b/i.test(text)) return 'PLN';
  if (/\bGBP\b|£/i.test(text)) return 'GBP';
  return fallback;
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function unixRange(startIso, endIso) {
  const start = Math.floor(new Date(`${startIso}T00:00:00Z`).getTime() / 1000);
  const endExclusive = Math.floor(new Date(`${endIso}T00:00:00Z`).getTime() / 1000) + 86400;
  return `${start}_${endExclusive}`;
}

function billingUrl(accountId, startDate, endDate) {
  const query = new URLSearchParams({
    asset_id: accountId,
    payment_account_id: accountId,
    placement: 'BILLING',
    date: unixRange(startDate, endDate),
  });
  return `https://adsmanager.facebook.com/adsmanager/billing_hub/payment_activity/?${query.toString()}`;
}

async function visibleBillingRange(page) {
  const pattern = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+20\d{2}\s*[–—-]\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+20\d{2}\b/i;
  const controls = page.locator('button, [role="button"]');
  const count = await controls.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 500); i += 1) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    const text = (await control.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

async function loadAllTransactionRows(page) {
  let previousCount = -1;
  let stablePasses = 0;
  for (let pass = 0; pass < 60; pass += 1) {
    if (page.isClosed()) throw new Error('BROWSER_CLOSED');
    const fbRows = page.locator('tr, [role="row"]').filter({ hasText: /FBADS-/i });
    const before = await fbRows.count().catch(() => 0);

    let clickedMore = false;
    for (const re of [/see more/i, /show more/i, /load more/i]) {
      const controls = page.getByText(re, { exact: false });
      const count = await controls.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i -= 1) {
        const c = controls.nth(i);
        if (await c.isVisible().catch(() => false)) {
          if (await c.click({ timeout: 5000 }).then(() => true).catch(() => false)) {
            clickedMore = true;
            break;
          }
        }
      }
      if (clickedMore) break;
    }

    if (!clickedMore) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    }
    await page.waitForTimeout(1000);

    const after = await fbRows.count().catch(() => 0);
    if (after <= previousCount && after <= before) stablePasses += 1;
    else stablePasses = 0;
    previousCount = Math.max(before, after);
    if (stablePasses >= 3) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(300);
}

async function openBilling(page, account) {
  const endDate = isoToday();
  const url = billingUrl(account.accountId, account.earliestStartDate, endDate);
  console.log(`Opening Meta Billing range ${account.earliestStartDate} → ${endDate}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);
  if (/login|checkpoint|two_factor|security\/block/i.test(page.url())) throw new Error('META_SESSION_EXPIRED');
  console.log(`Meta Billing URL: ${page.url()}`);
  const actualRange = await visibleBillingRange(page);
  if (actualRange) console.log(`Meta UI range: ${actualRange}`);
  else console.warn('Meta UI range: could not detect visible range');
  await loadAllTransactionRows(page);
}

async function discoverCandidates(page, account) {
  const rows = page.locator('tr, [role="row"]').filter({ hasText: /FBADS-/i });
  const count = await rows.count().catch(() => 0);
  const candidates = [];
  const seen = new Set();

  for (let i = 0; i < Math.min(count, 2000); i += 1) {
    const text = await rows.nth(i).innerText().catch(() => '');
    const keyMatch = text.match(/\b(FBADS-[A-Z0-9-]+)\b/i);
    if (!keyMatch) continue;
    const key = keyMatch[1].toUpperCase();
    if (seen.has(key)) continue;
    const invoiceDate = parseInvoiceDate(text);
    if (!invoiceDate || invoiceDate < account.earliestStartDate) continue;
    seen.add(key);
    candidates.push({ key, invoiceDate, contextText: text });
  }

  console.log(`Loaded ${count} row(s) containing FBADS invoice IDs`);
  console.log(`Found ${candidates.length} VAT invoice candidate(s)`);
  return candidates;
}

async function alreadyDelivered(account, candidate) {
  for (const subscription of account.subscriptions) {
    const result = await appApi(`/api/invoices/check?chat_id=${encodeURIComponent(subscription.telegram_chat_id)}&ad_account_id=${encodeURIComponent(account.accountId)}&invoice_key=${encodeURIComponent(candidate.key)}`);
    if (!result.delivered && candidate.invoiceDate >= subscription.start_date) return false;
  }
  return true;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readDownload(download, candidate) {
  const stream = await download.createReadStream().catch(() => null);
  if (!stream) return null;
  const buffer = await streamToBuffer(stream);
  if (!buffer.length || !buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) return null;
  return {
    buffer,
    filename: download.suggestedFilename() || `Meta_Invoice_${candidate.key}.pdf`,
  };
}

async function readPdfResponse(response, candidate) {
  if (!response) return null;
  const buffer = await response.body().catch(() => null);
  if (!buffer?.length || !buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) return null;
  return { buffer, filename: `Meta_Invoice_${candidate.key}.pdf` };
}

async function describeRowControls(row) {
  const controls = row.locator('button, a, [role="button"]');
  const count = await controls.count().catch(() => 0);
  const descriptions = [];
  for (let i = 0; i < Math.min(count, 12); i += 1) {
    const item = controls.nth(i);
    const tag = await item.evaluate((el) => el.tagName.toLowerCase()).catch(() => '?');
    const aria = (await item.getAttribute('aria-label').catch(() => null)) || '';
    const title = (await item.getAttribute('title').catch(() => null)) || '';
    const href = (await item.getAttribute('href').catch(() => null)) || '';
    const text = (await item.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    descriptions.push(`#${i + 1} ${tag} aria="${aria}" title="${title}" text="${text}" href="${href}"`);
  }
  return descriptions;
}

async function findInvoiceButton(page, key, { logDiagnostics = true } = {}) {
  const row = page.locator('tr, [role="row"]').filter({ hasText: key }).first();
  if (!(await row.count().catch(() => 0))) return null;

  const safeSelectors = [
    '[aria-label*="download" i]',
    '[aria-label*="invoice" i]',
    '[aria-label*="receipt" i]',
    '[title*="download" i]',
    '[title*="invoice" i]',
    '[title*="receipt" i]',
    'a[download]',
    'a[href*="invoice" i]',
    'a[href*="receipt" i]',
    'a[href*="pdf" i]',
  ];

  for (const selector of safeSelectors) {
    const item = row.locator(selector).first();
    if (await item.isVisible().catch(() => false)) return item;
  }

  const buttons = row.locator('button:visible, [role="button"]:visible');
  const buttonCount = await buttons.count().catch(() => 0);
  if (buttonCount === 1) {
    const only = buttons.first();
    if (await only.isEnabled().catch(() => false)) return only;
  }

  if (logDiagnostics) {
    const details = await describeRowControls(row);
    console.warn(`No unambiguous invoice action for ${key}. Row controls: ${details.join(' | ') || 'none'}`);
  }
  return null;
}

async function downloadCandidate(context, page, candidate) {
  const button = await findInvoiceButton(page, candidate.key);
  if (!button) return null;

  const downloadPromise = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
  const responsePromise = page.waitForResponse((response) => {
    const type = response.headers()['content-type'] || '';
    return /application\/pdf/i.test(type) || /pdf|invoice|receipt/i.test(response.url());
  }, { timeout: 25000 }).catch(() => null);
  const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);

  try {
    await button.click({ timeout: 15000 });
  } catch (error) {
    if (page.isClosed()) throw new Error('BROWSER_CLOSED');
    throw error;
  }

  const download = await downloadPromise;
  if (download) {
    const file = await readDownload(download, candidate);
    if (file) return file;
  }

  const response = await responsePromise;
  if (response) {
    const file = await readPdfResponse(response, candidate);
    if (file) return file;
  }

  const popup = await popupPromise;
  if (popup && !popup.isClosed()) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    const popupUrl = popup.url();
    if (/^https?:/i.test(popupUrl)) {
      const fetched = await context.request.get(popupUrl, { timeout: 30000 }).catch(() => null);
      if (fetched?.ok()) {
        const buffer = await fetched.body().catch(() => null);
        if (buffer?.length && buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) {
          await popup.close().catch(() => {});
          return { buffer, filename: `Meta_Invoice_${candidate.key}.pdf` };
        }
      }
    }
    await popup.close().catch(() => {});
  }

  if (page.isClosed()) throw new Error('BROWSER_CLOSED');
  return null;
}

async function sendPdf(account, candidate, file) {
  const form = new FormData();
  form.set('meta_account_id', account.accountId);
  form.set('invoice_key', candidate.key);
  form.set('invoice_date', candidate.invoiceDate);
  const amount = parseMoney(candidate.contextText);
  if (amount != null) form.set('amount', String(amount));
  const currency = parseCurrency(candidate.contextText, account.currency);
  if (currency) form.set('currency', currency);
  form.set('pdf', new Blob([file.buffer], { type: 'application/pdf' }), file.filename);

  const response = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}/api/invoices/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RUNNER_SECRET}` },
    body: form,
  });
  if (!response.ok) throw new Error(`ingest failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function openContext() {
  if (META_USER_DATA_DIR) {
    const profileDir = META_USER_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir());
    return chromium.launchPersistentContext(path.resolve(profileDir), {
      channel: 'chrome',
      headless: META_HEADLESS,
      acceptDownloads: true,
    });
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: META_STORAGE_STATE, acceptDownloads: true });
  context.__browser = browser;
  return context;
}

async function closeContext(context) {
  if (!context) return;
  await context.close().catch(() => {});
  if (context.__browser) await context.__browser.close().catch(() => {});
}

async function createBrowserSession(account) {
  const context = await openContext();
  const page = context.pages()[0] || await context.newPage();
  await openBilling(page, account);
  return { context, page };
}

async function recoverSession(account, session, reason) {
  console.warn(`Recovering browser: ${reason}`);
  await closeContext(session?.context);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return createBrowserSession(account);
}

async function processAccount(account) {
  let session = await createBrowserSession(account);
  let candidates;
  try {
    candidates = await discoverCandidates(session.page, account);
  } catch (error) {
    await closeContext(session.context);
    throw error;
  }

  for (const candidate of candidates) {
    if (await alreadyDelivered(account, candidate)) continue;

    let completed = false;
    for (let attempt = 0; attempt <= MAX_BROWSER_RECOVERIES && !completed; attempt += 1) {
      try {
        if (session.page.isClosed()) throw new Error('BROWSER_CLOSED');
        const file = await downloadCandidate(session.context, session.page, candidate);
        if (!file) {
          console.warn(`No PDF download for ${candidate.key}; skipping without crashing the scan`);
          completed = true;
          break;
        }
        const result = await sendPdf(account, candidate, file);
        console.log(`Invoice ${candidate.key}: delivered=${result.delivered?.length || 0}, skipped=${result.skipped?.length || 0}`);
        completed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Invoice ${candidate.key}: ${message}`);
        const browserClosed = /BROWSER_CLOSED|Target page, context or browser has been closed/i.test(message) || session.page.isClosed();
        if (!browserClosed) {
          completed = true;
          break;
        }

        if (attempt < MAX_BROWSER_RECOVERIES) {
          session = await recoverSession(account, session, `crash on ${candidate.key} (${attempt + 1}/${MAX_BROWSER_RECOVERIES})`);
          continue;
        }

        console.warn(`Skipping crash-prone invoice ${candidate.key} after ${attempt + 1} attempt(s); continuing with remaining invoices`);
        session = await recoverSession(account, session, `continue after skipping ${candidate.key}`);
        completed = true;
      }
    }
  }

  await closeContext(session.context);
}

async function main() {
  const subscriptions = await listSubscriptions();
  const accounts = groupSubscriptions(subscriptions);
  if (!accounts.length) return console.log('No active invoice subscriptions');

  for (const account of accounts) {
    console.log(`Checking ${account.accountId} (${account.accountName}) from ${account.earliestStartDate}`);
    try {
      await processAccount(account);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Account ${account.accountId}: ${message}`);
      if (message === 'META_SESSION_EXPIRED') process.exitCode = 2;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
