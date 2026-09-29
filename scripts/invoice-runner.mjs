import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const APP_BASE_URL = process.env.INVOICE_APP_BASE_URL;
const RUNNER_SECRET = process.env.INVOICE_RUNNER_SECRET;
const META_STORAGE_STATE = process.env.META_STORAGE_STATE || 'meta-storage-state.json';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!APP_BASE_URL || !RUNNER_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('INVOICE_APP_BASE_URL, INVOICE_RUNNER_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

async function appApi(path) {
  const response = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${RUNNER_SECRET}` },
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function listSubscriptions() {
  const url = new URL('/rest/v1/invoice_subscriptions', SUPABASE_URL);
  url.searchParams.set('select', 'telegram_chat_id,meta_account_id,account_name,currency,start_date,enabled');
  url.searchParams.set('enabled', 'eq.true');
  url.searchParams.set('order', 'start_date.asc');

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) throw new Error(`Supabase subscriptions failed: ${response.status} ${await response.text()}`);
  return response.json();
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
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseInvoiceDate(text = '') {
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return normalizeDate(iso[1], iso[2], iso[3]);

  const dmy = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (dmy) return normalizeDate(dmy[3], dmy[2], dmy[1]);

  const monthNames = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  };
  const named = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i)
    || text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (named) {
    const monthFirst = /^[A-Za-z]/.test(named[1]);
    const monthToken = (monthFirst ? named[1] : named[2]).toLowerCase();
    const day = monthFirst ? named[2] : named[1];
    const year = named[3];
    return normalizeDate(year, monthNames[monthToken], day);
  }
  return null;
}

function extractInvoiceKey(text = '', href = '') {
  const match = text.match(/(?:invoice|receipt|document)\s*(?:no\.?|number|#|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i)
    || href.match(/(?:invoice|receipt|document)[^A-Z0-9]*([A-Z0-9][A-Z0-9-]{4,})/i);
  if (match) return match[1];
  return crypto.createHash('sha256').update(`${text}|${href}`).digest('hex').slice(0, 32);
}

async function candidateContext(locator) {
  const row = locator.locator('xpath=ancestor-or-self::*[self::tr or @role="row"][1]');
  if (await row.count().catch(() => 0)) {
    const text = await row.first().innerText().catch(() => '');
    if (text) return text;
  }
  const parent = locator.locator('xpath=ancestor::*[self::div or self::li][1]');
  return (await parent.first().innerText().catch(() => '')) || (await locator.innerText().catch(() => '')) || '';
}

async function discoverInvoiceDownloads(page, account) {
  const billingUrl = `https://business.facebook.com/billing_hub/payment_activity?asset_id=${encodeURIComponent(account.accountId)}`;
  await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);

  if (/login|checkpoint|two_factor/i.test(page.url())) throw new Error('META_SESSION_EXPIRED');

  const selectors = [
    'a:has-text("Download")',
    'button:has-text("Download")',
    'a:has-text("Invoice")',
    'button:has-text("Invoice")',
    'a:has-text("Receipt")',
    'button:has-text("Receipt")',
  ];

  const seen = new Set();
  const candidates = [];
  for (const selector of selectors) {
    const items = page.locator(selector);
    const count = await items.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 150); i += 1) {
      const item = items.nth(i);
      const href = (await item.getAttribute('href').catch(() => null)) || '';
      const contextText = await candidateContext(item);
      const invoiceDate = parseInvoiceDate(contextText);
      if (!invoiceDate || invoiceDate < account.earliestStartDate) continue;
      const key = extractInvoiceKey(contextText, href);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ item, href, key, contextText, invoiceDate });
    }
  }
  return candidates;
}

async function downloadCandidate(page, candidate) {
  const downloadPromise = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
  await candidate.item.click({ timeout: 15000 }).catch(async () => {
    if (candidate.href) await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  });
  const download = await downloadPromise;
  if (!download) return null;
  const filePath = await download.path();
  if (!filePath) return null;
  const buffer = await readFile(filePath);
  if (!buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) return null;
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
  if (candidate.href) form.set('source_url', candidate.href);
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

async function main() {
  const subscriptions = await listSubscriptions();
  const accounts = groupSubscriptions(subscriptions);
  if (!accounts.length) {
    console.log('No active invoice subscriptions');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: META_STORAGE_STATE, acceptDownloads: true });
  const page = await context.newPage();

  let sessionExpired = false;
  try {
    for (const account of accounts) {
      console.log(`Checking ${account.accountId} (${account.accountName})`);
      try {
        const candidates = await discoverInvoiceDownloads(page, account);
        for (const candidate of candidates) {
          if (await alreadyDelivered(account, candidate)) continue;
          const file = await downloadCandidate(page, candidate);
          if (!file) {
            console.warn(`No PDF download for ${candidate.key}`);
            continue;
          }
          const result = await sendPdf(account, candidate, file);
          console.log(`Invoice ${candidate.key}: delivered=${result.delivered?.length || 0}, skipped=${result.skipped?.length || 0}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Account ${account.accountId}: ${message}`);
        if (message === 'META_SESSION_EXPIRED') {
          sessionExpired = true;
          break;
        }
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (sessionExpired) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
