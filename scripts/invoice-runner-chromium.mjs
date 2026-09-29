import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);

async function prepareDedicatedProfile(userDataDir) {
  if (!userDataDir || process.platform === 'win32') return;

  // This is a dedicated automation profile. Previous browser crashes can leave
  // Chromium processes and Singleton* files behind, preventing the next scan.
  try {
    await execFileAsync('pkill', ['-f', userDataDir]);
    console.log('Invoice browser: stopped stale automation-profile process(es)');
  } catch (error) {
    // pkill exits non-zero when nothing matched, which is the normal case.
    if (error?.code !== 1) {
      console.warn(`Invoice browser: stale-process cleanup warning: ${error?.message || error}`);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await unlink(`${userDataDir}/${name}`).catch((error) => {
      if (error?.code !== 'ENOENT') {
        console.warn(`Invoice browser: could not remove ${name}: ${error?.message || error}`);
      }
    });
  }
}

chromium.launchPersistentContext = async (userDataDir, options = {}) => {
  const browserMode = String(process.env.INVOICE_BROWSER || 'chromium').toLowerCase();

  await prepareDedicatedProfile(userDataDir);

  if (browserMode === 'chrome') {
    console.log('Invoice browser: Google Chrome');
    return originalLaunchPersistentContext(userDataDir, options);
  }

  const { channel: _channel, ...chromiumOptions } = options;
  console.log('Invoice browser: Playwright Chromium');
  try {
    return await originalLaunchPersistentContext(userDataDir, chromiumOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Executable doesn't exist|executable.*not found/i.test(message)) {
      console.error('Playwright Chromium is not installed. Run: npx playwright install chromium');
    }
    throw error;
  }
};

await import('./invoice-runner.mjs');
