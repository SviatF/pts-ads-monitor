import { spawn } from 'node:child_process';

const maxCrashes = Math.max(1, Number(process.env.INVOICE_MAX_CRASHES_PER_RUN || 3));
const maxMinutes = Math.max(1, Number(process.env.INVOICE_MAX_RUNTIME_MINUTES || 10));
const maxRuntimeMs = maxMinutes * 60_000;

const child = spawn(process.execPath, ['scripts/invoice-runner.mjs'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});

let crashCount = 0;
let stoppedBySupervisor = false;

function inspectChunk(chunk, target) {
  const text = chunk.toString();
  target.write(text);
  const crashes = text.match(/BROWSER_CLOSED|Target page, context or browser has been closed/g) || [];
  crashCount += crashes.length;
  if (!stoppedBySupervisor && crashCount >= maxCrashes) {
    stoppedBySupervisor = true;
    console.error(`\nInvoice supervisor: crash budget reached (${crashCount}/${maxCrashes}). Stopping this scan safely.`);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  }
}

child.stdout.on('data', (chunk) => inspectChunk(chunk, process.stdout));
child.stderr.on('data', (chunk) => inspectChunk(chunk, process.stderr));

const timeout = setTimeout(() => {
  if (stoppedBySupervisor) return;
  stoppedBySupervisor = true;
  console.error(`\nInvoice supervisor: max runtime reached (${maxMinutes} min). Stopping this scan safely.`);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 3000).unref();
}, maxRuntimeMs);

timeout.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error('Invoice supervisor failed to start runner:', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  if (stoppedBySupervisor) {
    console.log(`Invoice supervisor summary: crashes=${crashCount}, status=stopped_safely`);
    process.exitCode = 0;
    return;
  }
  console.log(`Invoice supervisor summary: crashes=${crashCount}, status=completed`);
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
