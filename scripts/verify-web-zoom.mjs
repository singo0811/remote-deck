// Zoom the real web client and check the canvas re-sizes without stale patches.
// Run: npx electron scripts/verify-web-zoom.mjs
import electron from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const { app, BrowserWindow } = electron;
const HOST = 'http://127.0.0.1:9601';
const PIN = process.env.RD_PIN || '';
const DEVICE = process.env.RD_DEVICE || 'RD-5852-4865';
const outDir = path.resolve('dist');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('disable-gpu-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { sandbox: false },
  });
  await win.loadURL(`${HOST}/?mode=direct&id=${encodeURIComponent(DEVICE)}&pin=${encodeURIComponent(PIN)}`);
  await wait(9000);

  const before = await win.webContents.executeJavaScript(
    "(() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : null; })()",
  );

  // Two ctrl+wheel zoom-ins, the same gesture the UI uses.
  await win.webContents.executeJavaScript(`
    (() => {
      const c = document.querySelector('canvas');
      const fire = (dy) => c.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true, clientX: 700, clientY: 400 }));
      fire(-120); fire(-120); fire(-120);
      return true;
    })()
  `);
  await wait(5000);

  const after = await win.webContents.executeJavaScript(
    "(() => { const c = document.querySelector('canvas'); return c ? { canvas: c.width + 'x' + c.height, zoom: document.body.innerText.match(/重置 ([0-9.]+)x/) ? document.body.innerText.match(/重置 ([0-9.]+)x/)[1] : null } : null; })()",
  );

  const shot = await win.webContents.capturePage();
  await fs.writeFile(path.join(outDir, 'web-zoom.png'), shot.toPNG());
  console.log('ZOOM_TEST', JSON.stringify({ before, after }));
  app.exit(0);
});
