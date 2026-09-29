import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const outputPath = process.env.META_STORAGE_STATE || 'meta-storage-state.json';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto('https://business.facebook.com/billing_hub/payment_activity', {
  waitUntil: 'domcontentloaded',
  timeout: 90_000,
});

console.log('\nLog in to Meta in the opened browser and complete any 2FA/checkpoint.');
console.log('When Billing is visible and the session is fully authenticated, return here.\n');

const rl = createInterface({ input, output });
await rl.question('Press Enter to save the authenticated Meta session...');
rl.close();

await context.storageState({ path: outputPath });
console.log(`Saved Meta browser session to ${outputPath}`);

await browser.close();
