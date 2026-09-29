import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const profileDir = process.env.META_USER_DATA_DIR || path.join(os.homedir(), '.pts-ads-monitor', 'meta-profile');
await mkdir(profileDir, { recursive: true });

console.log(`Opening persistent Meta browser profile: ${profileDir}`);
console.log('Log in to Meta, open Billing & payments → Payment activity, then return here and press ENTER.');

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome',
  headless: false,
  acceptDownloads: true,
  viewport: null,
});

const pages = context.pages();
const page = pages[0] || await context.newPage();
await page.goto('https://business.facebook.com/billing_hub/payment_activity', {
  waitUntil: 'domcontentloaded',
  timeout: 90000,
}).catch(() => {});

process.stdin.resume();
await new Promise((resolve) => process.stdin.once('data', resolve));
await context.close();
console.log('Meta persistent profile saved.');
