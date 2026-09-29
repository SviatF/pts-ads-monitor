import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const APP_BASE_URL = process.env.INVOICE_APP_BASE_URL;
const RUNNER_SECRET = process.env.INVOICE_RUNNER_SECRET;
const META_STORAGE_STATE = process.env.META_STORAGE_STATE || 'meta-storage-state.json';
const META_USER_DATA_DIR = process.env.META_USER_DATA_DIR || '';
const META_HEADLESS = process.env.META_HEADLESS === '1';

if (!APP_BASE_URL || !RUNNER_SECRET) throw new Error('INVOICE_APP_BASE_URL and INVOICE_RUNNER_SECRET are required');

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

function extractInvoiceKey(text = '', href = '') {
  const vat = text.match(/\b(FBADS-[A-Z0-9-]+)\b/i);
  if (vat) return vat[1].toUpperCase();
  const generic = text.match(/(?:invoice|receipt|document)\s*(?:no\.?|number|#|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i)
    || href.match(/(?:invoice|receipt|document)[^A-Z0-9]*([A-Z0-9][A-Z0-9-]{4,})/i);
  if (generic) return generic[1];
  return crypto.createHash('sha256').update(`${text}|${href}`).digest('hex').slice(0, 32);
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysInclusive(startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  return Math.floor((end - start) / 86400000) + 1;
}

function usDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function longDateLabels(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  const long = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
  const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
  return [long, short];
}

async function visibleDateRangeTrigger(page) {
  const monthPattern = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+20\d{2}\s*[–—-]\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+20\d{2}\b/i;
  const controls = page.locator('button, [role="button"]');
  const count = await controls.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 400); i += 1) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    const text = (await control.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (monthPattern.test(text)) return { control, text };
  }
  return null;
}

async function clickVisibleText(page, regex) {
  const candidates = page.getByText(regex, { exact: false });
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 60); i += 1) {
    const item = candidates.nth(i);
    if (await item.isVisible().catch(() => false)) {
      if (await item.click({ timeout: 5000 }).then(() => true).catch(() => false)) return true;
    }
  }
  return false;
}

async function clickCalendarDate(page, iso) {
  for (const label of longDateLabels(iso)) {
    const exact = page.getByRole('button', { name: label, exact: true });
    if (await exact.first().isVisible().catch(() => false)) {
      await exact.first().click({ timeout: 5000 });
      return true;
    }
    const loose = page.locator(`[aria-label*="${label.replaceAll('"', '\\"')}"]`).first();
    if (await loose.isVisible().catch(() => false)) {
      await loose.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

async function setBillingDateRange(page, startDate, endDate) {
  const trigger = await visibleDateRangeTrigger(page);
  if (!trigger) {
    console.warn(`Could not locate Meta Billing date-range control; requested ${startDate} → ${endDate}`);
    return false;
  }

  console.log(`Current Meta Billing range: ${trigger.text}`);
  await trigger.control.click({ timeout: 10000 });
  await page.waitForTimeout(800);

  const spanDays = daysInclusive(startDate, endDate);
  const presetPatterns = spanDays <= 30
    ? [/last\s*30\s*days/i, /past\s*30\s*days/i, /30\s*days/i]
    : spanDays <= 90
      ? [/last\s*90\s*days/i, /past\s*90\s*days/i, /90\s*days/i]
      : [];

  for (const preset of presetPatterns) {
    if (await clickVisibleText(page, preset)) {
      await page.waitForTimeout(2500);
      const updated = await visibleDateRangeTrigger(page);
      console.log(`Applied Meta Billing preset; range is now: ${updated?.text || 'updated'}`);
      return true;
    }
  }

  await clickVisibleText(page, /custom|custom range|date range/i);
  await page.waitForTimeout(800);

  const visibleInputs = [];
  const inputs = page.locator('input');
  const inputCount = await inputs.count().catch(() => 0);
  for (let i = 0; i < Math.min(inputCount, 120); i += 1) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    const placeholder = (await input.getAttribute('placeholder').catch(() => '')) || '';
    const aria = (await input.getAttribute('aria-label').catch(() => '')) || '';
    const type = (await input.getAttribute('type').catch(() => '')) || '';
    if (/date|mm|dd|yyyy|start|end/i.test(`${placeholder} ${aria} ${type}`)) visibleInputs.push(input);
  }

  if (visibleInputs.length >= 2) {
    const values = [usDate(startDate), usDate(endDate)];
    for (let i = 0; i < 2; i += 1) {
      await visibleInputs[i].fill(values[i]).catch(async () => {
        await visibleInputs[i].press('Meta+A').catch(() => {});
        await visibleInputs[i].type(values[i]).catch(() => {});
      });
    }
    if (await clickVisibleText(page, /apply|update|done|save/i)) {
      await page.waitForTimeout(2500);
      console.log(`Applied custom Meta Billing range ${startDate} → ${endDate}`);
      return true;
    }
  }

  const clickedStart = await clickCalendarDate(page, startDate);
  const clickedEnd = clickedStart ? await clickCalendarDate(page, endDate) : false;
  if (clickedStart && clickedEnd && await clickVisibleText(page, /apply|update|done|save/i)) {
    await page.waitForTimeout(2500);
    console.log(`Applied calendar Meta Billing range ${startDate} → ${endDate}`);
    return true;
  }

  const popupText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const hints = [...popupText.matchAll(/(?:Last|Past)\s+\d+\s+days/gi)].map((m) => m[0]).slice(0, 10);
  if (hints.length) console.warn(`Visible date presets: ${hints.join(', ')}`);

  await page.keyboard.press('Escape').catch(() => {});
  console.warn(`Could not automatically apply Meta Billing range ${startDate} → ${endDate}`);
  return false;
}

async function loadAllTransactionRows(page) {
  let previousCount = -1;
  let stablePasses = 0;

  for (let pass = 0; pass < 50; pass += 1) {
    const rows = page.locator('tr, [role="row"]');
    const before = await rows.count().catch(() => 0);

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

    if (!clickedMore) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});

    await page.waitForTimeout(1200);
    const after = await rows.count().catch(() => 0);

    if (after <= previousCount && after <= before) stablePasses += 1;
    else stablePasses = 0;
    previousCount = Math.max(after, before);
    if (stablePasses >= 3) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(400);
}

async function discoverInvoiceDownloads(page, account) {
  const billingUrl = `https://business.facebook.com/billing_hub/payment_activity?asset_id=${encodeURIComponent(account.accountId)}`;
  await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);
  if (/login|checkpoint|two_factor|security\/block/i.test(page.url())) throw new Error('META_SESSION_EXPIRED');

  const endDate = isoToday();
  const rangeApplied = await setBillingDateRange(page, account.earliestStartDate, endDate);
  if (!rangeApplied) console.warn('Continuing with currently visible Meta Billing date range');

  await loadAllTransactionRows(page);

  const candidates = [];
  const seen = new Set();
  const rows = page.locator('tr, [role="row"]').filter({ hasText: /FBADS-/i });
  const rowCount = await rows.count().catch(() => 0);
  console.log(`Loaded ${rowCount} row(s) containing FBADS invoice IDs`);

  for (let i = 0; i < Math.min(rowCount, 1000); i += 1) {
    const row = rows.nth(i);
    const contextText = await row.innerText().catch(() => '');
    if (!/\bFBADS-/i.test(contextText)) continue;
    const invoiceDate = parseInvoiceDate(contextText);
    if (!invoiceDate || invoiceDate < account.earliestStartDate) continue;
    const key = extractInvoiceKey(contextText);
    if (seen.has(key)) continue;

    let item = row.locator('[aria-label*="download" i], [title*="download" i], a[download]').first();
    if (!(await item.count().catch(() => 0))) item = row.locator('button').last();
    if (!(await item.count().catch(() => 0))) continue;

    seen.add(key);
    candidates.push({ item, href: '', key, contextText, invoiceDate });
  }

  return candidates;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function downloadCandidate(page, candidate) {
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await candidate.item.click({ timeout: 15000 });
  const download = await downloadPromise;
  if (!download) return null;

  const stream = await download.createReadStream().catch(() => null);
  if (!stream) return null;
  const buffer = await streamToBuffer(stream);
  if (!buffer.length || !buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) return null;

  return {
    buffer,
    filename: download.suggestedFilename() || `Meta_Invoice_${candidate.key}.pdf`,
  };
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

async function alreadyDelivered(account, candidate) {
  for (const subscription of account.subscriptions) {
    const result = await appApi(`/api/invoices/check?chat_id=${encodeURIComponent(subscription.telegram_chat_id)}&ad_account_id=${encodeURIComponent(account.accountId)}&invoice_key=${encodeURIComponent(candidate.key)}`);
    if (!result.delivered && candidate.invoiceDate >= subscription.start_date) return false;
  }
  return true;
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

async function main() {
  const subscriptions = await listSubscriptions();
  const accounts = groupSubscriptions(subscriptions);
  if (!accounts.length) return console.log('No active invoice subscriptions');

  const context = await openContext();
  const page = context.pages()[0] || await context.newPage();
  let sessionExpired = false;

  try {
    for (const account of accounts) {
      console.log(`Checking ${account.accountId} (${account.accountName}) from ${account.earliestStartDate}`);
      try {
        const candidates = await discoverInvoiceDownloads(page, account);
        console.log(`Found ${candidates.length} VAT invoice candidate(s)`);

        for (const candidate of candidates) {
          if (await alreadyDelivered(account, candidate)) continue;

          try {
            const file = await downloadCandidate(page, candidate);
            if (!file) {
              console.warn(`No PDF download for ${candidate.key}`);
              continue;
            }
            const result = await sendPdf(account, candidate, file);
            console.log(`Invoice ${candidate.key}: delivered=${result.delivered?.length || 0}, skipped=${result.skipped?.length || 0}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Invoice ${candidate.key}: ${message}`);
            if (page.isClosed()) throw new Error('BROWSER_CLOSED_DURING_DOWNLOAD');
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Account ${account.accountId}: ${message}`);
        if (message === 'META_SESSION_EXPIRED') {
          sessionExpired = true;
          break;
        }
        if (message === 'BROWSER_CLOSED_DURING_DOWNLOAD') break;
      }
    }
  } finally {
    await context.close().catch(() => {});
    if (context.__browser) await context.__browser.close().catch(() => {});
  }

  if (sessionExpired) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
