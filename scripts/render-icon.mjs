import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';

const repo = path.resolve(process.argv[2] || '.');
const svgPath = path.join(repo, 'assets', 'icon.svg');
const outDir = path.join(repo, 'assets', 'icons');
const svg = await fs.readFile(svgPath, 'utf8');
await fs.mkdir(outDir, { recursive: true });

const svgFile = path.join(outDir, 'icon.svg');
await fs.writeFile(svgFile, svg);

const port = 9470;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--window-size=1024,1024',
  `--remote-debugging-port=${port}`,
  '--user-data-dir=' + process.env.TEMP + '\\rd-icon-render',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (list.some((t) => t.type === 'page')) break;
  } catch {}
}
const page = (list || []).find((t) => t.type === 'page');
if (!page) { console.error('no chrome page'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  const onMsg = (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id === mid) { ws.off('message', onMsg); resolve(m.result || m.error); }
  };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false });
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;background:transparent">
${svg.replace('width="512" height="512"', 'width="1024" height="1024"')}
</div></body></html>`;
await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
await sleep(900);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (!shot?.data) { console.error('no screenshot'); child.kill(); process.exit(1); }
const master = path.join(outDir, 'icon-1024.png');
await fs.writeFile(master, Buffer.from(shot.data, 'base64'));
ws.close();
child.kill();
console.log('master', master);
