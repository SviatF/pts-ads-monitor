import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';

const APP_BASE_URL = process.env.INVOICE_APP_BASE_URL;
const RUNNER_SECRET = process.env.INVOICE_RUNNER_SECRET;
const META_USER_DATA_DIR = process.env.META_USER_DATA_DIR || '';
const PROBE_KEY = String(process.env.INVOICE_PROBE_KEY || '').trim().toUpperCase();

if (!APP_BASE_URL || !RUNNER_SECRET) {
  throw new Error('INVOICE_APP_BASE_URL and INVOICE_RUNNER_SECRET are required');
}
if (!META_USER_DATA_DIR) {
  throw new Error('META_USER_DATA_DIR is required for the local network probe');
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

async function appApi(apiPath) {
  const response = await fetch(`${APP_BASE_URL.replace(/\/$/, '')}${apiPath}`, {
    headers: { Authorization: `Bearer ${RUNNER_SECRET}` },
  });
  if (!response.ok) throw new Error(`${apiPath} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function loadRows(page) {
  let previous = -1;
  let stable = 0;
  for (let i = 0; i < 40; i += 1) {
    const rows = page.locator('tr, [role="row"]').filter({ hasText: /FBADS-/i });
    const before = await rows.count().catch(() => 0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(700);
    const after = await rows.count().catch(() => 0);
    if (after <= before && after <= previous) stable += 1;
    else stable = 0;
    previous = Math.max(before, after);
    if (stable >= 3) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(300);
}

async function findAction(row) {
  const selectors = [
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
  for (const selector of selectors) {
    const item = row.locator(selector).first();
    if (await item.isVisible().catch(() => false)) return item;
  }
  const buttons = row.locator('button:visible, [role="button"]:visible');
  if ((await buttons.count().catch(() => 0)) === 1) return buttons.first();
  return null;
}

function interesting(url = '', postData = '', contentType = '') {
  return /invoice|receipt|pdf|billing|transaction|payment|fbads/i.test(`${url} ${postData} ${contentType}`);
}

function postHint(postData, key) {
  if (!postData) return '';
  const lower = postData.toLowerCase();
  const needles = [key.toLowerCase(), 'invoice', 'receipt', 'transaction', 'payment'];
  let index = -1;
  for (const needle of needles) {
    index = lower.indexOf(needle);
    if (index >= 0) break;
  }
  if (index < 0) return '';
  const start = Math.max(0, index - 120);
  const end = Math.min(postData.length, index + 260);
  return postData.slice(start, end).replace(/\s+/g, ' ').replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]');
}

const subscriptions = (await appApi('/api/invoices/subscriptions')).subscriptions || [];
if (!subscriptions.length) throw new Error('No active invoice subscriptions');

const first = subscriptions[0];
const accountId = String(first.meta_account_id).replace(/^act_/, '');
const accountRows = subscriptions.filter((row) => String(row.meta_account_id).replace(/^act_/, '') === accountId);
const startDate = accountRows.map((row) => row.start_date).sort()[0];
const profileDir = path.resolve(META_USER_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir()));

console.log(`Invoice network probe account=${accountId} range=${startDate} → ${isoToday()}`);
console.log(`Invoice network probe profile=${profileDir}`);

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  acceptDownloads: true,
});
const page = context.pages()[0] || await context.newPage();

let selectedKey = PROBE_KEY;
let requestCount = 0;
let responseCount = 0;

page.on('close', () => console.warn('PROBE PAGE CLOSED'));
context.on('close', () => console.warn('PROBE CONTEXT CLOSED'));

page.on('request', (request) => {
  const url = request.url();
  const postData = request.postData() || '';
  if (!interesting(url, postData, '')) return;
  requestCount += 1;
  const containsKey = selectedKey ? `${url}\n${postData}`.toUpperCase().includes(selectedKey) : false;
  console.log(`NET REQUEST #${requestCount} ${request.method()} key=${containsKey ? 'yes' : 'no'} ${url}`);
  const hint = postHint(postData, selectedKey || 'FBADS-');
  if (hint) console.log(`NET POST HINT #${requestCount}: ${hint}`);
});

page.on('response', (response) => {
  const type = response.headers()['content-type'] || '';
  const url = response.url();
  if (!interesting(url, '', type)) return;
  responseCount += 1;
  console.log(`NET RESPONSE #${responseCount} status=${response.status()} type=${type || '-'} ${url}`);
});

page.on('download', async (download) => {
  console.log(`NET DOWNLOAD filename=${download.suggestedFilename()}`);
  const failure = await download.failure().catch(() => null);
  if (failure) console.log(`NET DOWNLOAD failure=${failure}`);
});

await page.goto(billingUrl(accountId, startDate, isoToday()), { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(7000);
console.log(`Probe billing URL: ${page.url()}`);
await loadRows(page);

const rows = page.locator('tr, [role="row"]').filter({ hasText: /FBADS-/i });
const count = await rows.count().catch(() => 0);
console.log(`Probe loaded ${count} FBADS row(s)`);

let targetRow = null;
if (selectedKey) {
  targetRow = page.locator('tr, [role="row"]').filter({ hasText: selectedKey }).first();
  if (!(await targetRow.count().catch(() => 0))) throw new Error(`INVOICE_PROBE_KEY ${selectedKey} was not found in the visible billing range`);
} else {
  for (let i = 0; i < count; i += 1) {
    const text = await rows.nth(i).innerText().catch(() => '');
    const match = text.match(/\b(FBADS-[A-Z0-9-]+)\b/i);
    if (!match) continue;
    selectedKey = match[1].toUpperCase();
    targetRow = rows.nth(i);
    break;
  }
}

if (!targetRow || !selectedKey) throw new Error('Could not choose an invoice row for probing');
console.log(`Probe target invoice: ${selectedKey}`);

const action = await findAction(targetRow);
if (!action) throw new Error(`No invoice action found for ${selectedKey}`);

console.log('Probe clicking invoice action once; capturing network for 20 seconds...');
try {
  await action.click({ timeout: 15000 });
} catch (error) {
  console.error(`Probe click error: ${error instanceof Error ? error.message : String(error)}`);
}

await new Promise((resolve) => setTimeout(resolve, 20000));
console.log(`Probe summary: requests=${requestCount}, responses=${responseCount}, pageClosed=${page.isClosed()}`);
await context.close().catch(() => {});
