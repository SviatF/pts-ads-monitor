import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const minutes = Number(process.env.INVOICE_POLL_MINUTES || 15);
const intervalMs = Math.max(5, Number.isFinite(minutes) ? minutes : 15) * 60_000;
const storagePath = process.env.META_STORAGE_STATE || 'meta-storage-state.json';
let stopping = false;

async function prepareStorageState() {
  const encoded = process.env.META_STORAGE_STATE_B64;
  if (!encoded) return;
  const json = Buffer.from(encoded, 'base64').toString('utf8');
  JSON.parse(json);
  await writeFile(storagePath, json, { mode: 0o600 });
  console.log(`Meta storage state restored to ${storagePath}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/invoice-runner.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, META_STORAGE_STATE: storagePath },
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

await prepareStorageState();
console.log(`Invoice daemon started; poll interval=${intervalMs / 60_000} minutes`);

while (!stopping) {
  const startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] Starting invoice scan`);
  const result = await runOnce();
  if (result.code === 2) {
    console.error('Meta session expired. Refresh META_STORAGE_STATE_B64 (or the mounted storage-state file) before invoice delivery can resume.');
  } else if (result.code !== 0) {
    console.error(`Invoice scan failed with exit code ${result.code}${result.signal ? ` (${result.signal})` : ''}`);
  }

  if (stopping) break;
  const elapsed = Date.now() - startedAt.getTime();
  const delay = Math.max(10_000, intervalMs - elapsed);
  await sleep(delay);
}

console.log('Invoice daemon stopped');
