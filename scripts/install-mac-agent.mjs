import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const repoDir = process.cwd();
const home = os.homedir();
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const logsDir = path.join(home, 'Library', 'Logs', 'PTSAdsMonitor');
const plistPath = path.join(launchAgentsDir, 'com.pts.adsmonitor.invoices.plist');
const envPath = path.join(repoDir, '.env.invoice-agent');

await mkdir(launchAgentsDir, { recursive: true });
await mkdir(logsDir, { recursive: true });

const esc = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pts.adsmonitor.invoices</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>--env-file=${esc(envPath)}</string>
    <string>${esc(path.join(repoDir, 'scripts', 'invoice-daemon.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(repoDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${esc(path.join(logsDir, 'invoice-agent.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.join(logsDir, 'invoice-agent.error.log'))}</string>
</dict>
</plist>
`;

await writeFile(plistPath, plist, { mode: 0o644 });
console.log(`LaunchAgent written: ${plistPath}`);
console.log(`Expected env file: ${envPath}`);
console.log('Load/reload with:');
console.log(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null || true`);
console.log(`launchctl bootstrap gui/$(id -u) ${plistPath}`);
console.log('Logs:');
console.log(path.join(logsDir, 'invoice-agent.log'));
console.log(path.join(logsDir, 'invoice-agent.error.log'));
