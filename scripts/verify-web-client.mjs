// Screenshot the real web client against the running host, so compositing
// artifacts (stale patches / "crossed pages") can be inspected directly.
// Run: npx electron scripts/verify-web-client.mjs
import electron from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const { app, BrowserWindow } = electron;
const HOST = 'http://127.0.0.1:9601';
const PIN = process.env.RD_PIN || '';
const DEVICE = process.env.RD_DEVICE || 'RD-5852-4865';
const outDir = path.resolve('dist');

app.commandLine.appendSwitch('disable-gpu-sandbox');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { sandbox: false, offscreen: false },
  });
  await win.loadURL(`${HOST}/?mode=direct&id=${encodeURIComponent(DEVICE)}&pin=${encodeURIComponent(PIN)}`);
  await wait(9000);

  const first = await win.webContents.capturePage();
  await fs.writeFile(path.join(outDir, 'web-remote-1.png'), first.toPNG());
  await wait(4000);
  const second = await win.webContents.capturePage();
  await fs.writeFile(path.join(outDir, 'web-remote-2.png'), second.toPNG());

  const stats = await win.webContents.executeJavaScript(`
    (() => {
      const c = document.querySelector('canvas');
      return { canvas: c ? c.width + 'x' + c.height : null, text: (document.body.innerText || '').slice(0, 120) };
    })()
  `);
  console.log('WEB_CLIENT', JSON.stringify(stats));
  app.exit(0);
});
