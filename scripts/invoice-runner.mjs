import { chromium } from 'playwright';

const APP_BASE_URL = process.env.INVOICE_APP_BASE_URL;
const RUNNER_SECRET = process.env.INVOICE_RUNNER_SECRET;
const META_STORAGE_STATE = process.env.META_STORAGE_STATE || 'meta-storage-state.json';

if (!APP_BASE_URL || !RUNNER_SECRET) {
  throw new Error('INVOICE_APP_BASE_URL and INVOICE_RUNNER_SECRET are required');
}

async function api(path, init = {}) {
  const response = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${RUNNER_SECRET}`,
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function parseMoney(text = '') {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/(?:USD|EUR|UAH|PLN|GBP|\$|€|£)?\s?([\d.,]+(?:[.,]\d{2})?)/);
  return match?.[1] || null;
}

function extractInvoiceKey(text = '', href = '') {
  const invoiceMatch = text.match(/(?:invoice|receipt|document)\s*(?:no\.?|#|id)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i);
  if (invoiceMatch) return invoiceMatch[1];
  const urlMatch = href.match(/(?:invoice|receipt|document)[^A-Z0-9]*([A-Z0-9-]{5,})/i);
  if (urlMatch) return urlMatch[1];
  return Buffer.from(`${text}|${href}`).toString('base64url').slice(0, 48);
}

async function discoverInvoiceDownloads(page, accountId, startDate) {
  const billingUrl = `https://business.facebook.com/billing_hub/payment_activity?asset_id=${encodeURIComponent(accountId)}`;
  await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);

  if (/login|checkpoint/i.test(page.url())) {
    throw new Error('META_SESSION_EXPIRED');
  }

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
    for (let i = 0; i < Math.min(count, 100); i += 1) {
      const item = items.nth(i);
      const text = (await item.innerText().catch(() => '')) || '';
      const href = (await item.getAttribute('href').catch(() => null)) || '';
      const key = extractInvoiceKey(text, href);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ item, text, href, key });
    }
  }

  return { billingUrl, startDate, candidates };
}

async function downloadCandidate(page, candidate) {
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  await candidate.item.click({ timeout: 15000 }).catch(async () => {
    if (candidate.href) await page.goto(candidate.href, { waitUntil: 'domcontentloaded' });
  });
  const download = await downloadPromise;
  if (!download) return null;
  const buffer = await require('node:fs/promises').then(async fs => {
    const path = await download.path();
    return path ? fs.readFile(path) : null;
  });
  if (!buffer) return null;
  const suggested = download.suggestedFilename() || `${candidate.key}.pdf`;
  return { buffer, filename: suggested };
}

async function sendPdf(subscription, candidate, file) {
  const form = new FormData();
  form.set('chat_id', String(subscription.chat_id));
  form.set('ad_account_id', subscription.meta_account_id);
  form.set('invoice_key', candidate.key);
  form.set('invoice_date', new Date().toISOString().slice(0, 10));
  const amount = parseMoney(candidate.text);
  if (amount) form.set('amount', amount);
  form.set('pdf', new Blob([file.buffer], { type: 'application/pdf' }), file.filename);

  const response = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}/api/invoices/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RUNNER_SECRET}` },
    body: form,
  });
  if (!response.ok) throw new Error(`ingest failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function main() {
  const payload = await api('/api/invoices/subscriptions');
  const subscriptions = payload.subscriptions || [];
  if (!subscriptions.length) {
    console.log('No active invoice subscriptions');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: META_STORAGE_STATE });
  const page = await context.newPage();

  try {
    for (const subscription of subscriptions) {
      console.log(`Checking ${subscription.meta_account_id} for chat ${subscription.chat_id}`);
      try {
        const { candidates } = await discoverInvoiceDownloads(page, subscription.meta_account_id, subscription.start_date);
        for (const candidate of candidates) {
          const duplicate = await api(`/api/invoices/check?chat_id=${encodeURIComponent(subscription.chat_id)}&ad_account_id=${encodeURIComponent(subscription.meta_account_id)}&invoice_key=${encodeURIComponent(candidate.key)}`);
          if (duplicate.delivered) continue;
          const file = await downloadCandidate(page, candidate);
          if (!file) continue;
          await sendPdf(subscription, candidate, file);
          console.log(`Delivered ${candidate.key}`);
        }
      } catch (error) {
        console.error(`Account ${subscription.meta_account_id}:`, error instanceof Error ? error.message : error);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
