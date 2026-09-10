import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { readCredential } from '../src/store.js';

const [browser, credential, screenshot] = process.argv.slice(2);
if (!browser || !credential) throw new Error('Usage: browser-probe.js CHROMIUM_BINARY VIEWER_CREDENTIAL [SCREENSHOT]');
const url = process.env.WORK_URL ?? 'http://127.0.0.1:8790';
const profile = mkdtempSync(join(tmpdir(), 'work-commander-browser-'));
const chrome = spawn(browser, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser startup timeout')), 15000);
    let output = '';
    chrome.stderr.on('data', data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited ${code}`)); });
  });
  socket = new WebSocket(endpoint); await once(socket, 'open');
  let seq = 0; const pending = new Map();
  socket.addEventListener('message', message => {
    const value = JSON.parse(message.data), entry = pending.get(value.id);
    if (entry) {
      pending.delete(value.id); clearTimeout(entry.timer);
      if (value.error) entry.reject(new Error(value.error.message)); else entry.resolve(value.result);
    }
  });
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => command(method, params, sessionId);
  await cdp('Page.enable');
  await cdp('Network.enable');
  const response = await fetch(`${url}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: readCredential(credential) }),
  });
  if (!response.ok) throw new Error(`Viewer login failed: ${response.status}`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  await cdp('Network.setCookie', { name: 'wc_view', value: cookie.slice('wc_view='.length), url, httpOnly: true, sameSite: 'Strict' });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url });
  const waitFor = async expression => {
    const deadline = Date.now() + Number(process.env.WORK_BROWSER_TIMEOUT_MS ?? 15000);
    while (Date.now() < deadline) {
      const value = await cdp('Runtime.evaluate', { expression, returnByValue: true });
      if (value.result.value) return value.result.value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const diagnostic = await cdp('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    throw new Error(`Page did not reach expected state: ${expression}\n${diagnostic.result.value}`);
  };
  await waitFor("document.getElementById('connection')?.textContent === '实时已连接'");
  const result = await cdp('Runtime.evaluate', {
    expression: `JSON.stringify({authenticated:document.getElementById('login').hidden,
      live:document.getElementById('connection').textContent, cards:document.querySelectorAll('.card').length,
      groups:document.querySelectorAll('.column').length, horizontalOverflow:document.documentElement.scrollWidth>innerWidth})`,
    returnByValue: true,
  });
  console.log(result.result.value);
  await cdp('Runtime.evaluate', { expression: "document.querySelector('.card')?.click()" });
  await waitFor("!document.getElementById('detail').hidden");
  if (process.env.WORK_EXPECT_TEXT) {
    await waitFor(`document.getElementById('detail').textContent.includes(${JSON.stringify(process.env.WORK_EXPECT_TEXT)})`);
    console.log(JSON.stringify({ expectedDetailObserved: process.env.WORK_EXPECT_TEXT }));
  }
  if (screenshot) {
    const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(screenshot, Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 });
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobile = await cdp('Runtime.evaluate', { expression: "JSON.stringify({mobileOverflow:document.documentElement.scrollWidth>innerWidth,detailVisible:!document.getElementById('detail').hidden})", returnByValue: true });
  console.log(mobile.result.value);
} finally {
  socket?.close();
  if (chrome.exitCode === null) { const exited = once(chrome, 'exit'); chrome.kill('SIGTERM'); await exited; }
  rmSync(profile, { recursive: true });
}
