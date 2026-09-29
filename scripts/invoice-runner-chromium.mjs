import { chromium } from 'playwright';

const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);

chromium.launchPersistentContext = async (userDataDir, options = {}) => {
  const browserMode = String(process.env.INVOICE_BROWSER || 'chromium').toLowerCase();
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
    if (/Executable doesn't exist|browserType\.launchPersistentContext/i.test(message) && /playwright/i.test(message)) {
      console.error('Playwright Chromium is not installed. Run: npx playwright install chromium');
    }
    throw error;
  }
};

await import('./invoice-runner.mjs');
