import { spawn } from 'node:child_process';

const minutes = Number(process.env.INVOICE_POLL_MINUTES || 15);
const intervalMs = Math.max(5, Number.isFinite(minutes) ? minutes : 15) * 60_000;
let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/invoice-runner.mjs'], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
    child.on('error', (error) => {
      console.error('Invoice runner spawn failed:', error);
      resolve({ code: 1, signal: null });
    });
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    console.log(`Received ${signal}; invoice daemon will stop after the current cycle.`);
  });
}

console.log(`Invoice daemon started; poll interval=${intervalMs / 60_000} minutes`);

while (!stopping) {
  const startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] Starting invoice scan`);
  const result = await runOnce();
  if (result.code === 2) {
    console.error('Meta session expired. Refresh META_STORAGE_STATE before invoice delivery can resume.');
  } else if (result.code !== 0) {
    console.error(`Invoice scan failed with exit code ${result.code}${result.signal ? ` (${result.signal})` : ''}`);
  }

  if (stopping) break;
  const elapsed = Date.now() - startedAt.getTime();
  const delay = Math.max(10_000, intervalMs - elapsed);
  await sleep(delay);
}

console.log('Invoice daemon stopped');
