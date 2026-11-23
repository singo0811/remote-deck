// End-to-end check of the client H.264 path inside the packaged Chromium:
// ffmpeg produces Annex-B H.264, we split it into access units exactly like the
// Go host does, and our real H264Player must decode them onto a canvas.
// Run: npx electron scripts/verify-h264.mjs
import electron from 'electron';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { app, BrowserWindow } = electron;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const videoModule = path.join(repoRoot, 'apps/web/src/lib/video.js');

const PAGE = `<!doctype html><meta charset="utf-8">
<canvas id="c" width="16" height="16"></canvas>
<script type="module">
  import { H264Player } from '/video.js';
  window.player = new H264Player();
  window.player.attach(document.getElementById('c'));
  window.player.onError = (e) => { window.decodeError = String(e && e.message || e); };
  window.pump = (chunks) => {
    let i = 0;
    for (const item of chunks) {
      const bin = atob(item.b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      if (!window.player.push(item.meta, bytes)) {
        window.pumpFail = { at: i, decoder: Boolean(window.player.decoder), key: item.meta.key, len: bytes.length };
        return i;
      }
      i++;
    }
    return i;
  };
  window.diag = () => ({
    configured: Boolean(window.player.decoder),
    configKey: window.player.configKey,
    error: window.decodeError || null,
    fail: window.pumpFail || null,
  });
  window.ready = true;
</script>`;

function splitAccessUnits(buf) {
  const find = (from) => {
    for (let i = from; i + 3 <= buf.length; i += 1) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
    }
    return -1;
  };
  const us = [];
  let au = [];
  let hasVcl = false;
  let start = find(0);
  while (start >= 0) {
    const next = find(start + 3);
    if (next < 0) break;
    const nal = buf.subarray(start, next);
    const type = nal[nal[0] === 0 && nal[1] === 0 && nal[2] === 0 ? 4 : 3] & 0x1f;
    const isVcl = type >= 1 && type <= 5;
    if (isVcl && hasVcl) {
      us.push(Buffer.concat(au));
      au = [];
      hasVcl = false;
    }
    au.push(Buffer.from(nal));
    if (isVcl) hasVcl = true;
    start = next;
  }
  if (au.length) us.push(Buffer.concat(au));
  return us;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/video.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    res.end(await fs.readFile(videoModule));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

app.commandLine.appendSwitch('disable-gpu-sandbox');

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-h264-'));
  const src = path.join(dir, 'test.h264');
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15',
      '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-profile:v', 'baseline', '-g', '30', '-pix_fmt', 'yuv420p', '-f', 'h264', src],
    { stdio: 'inherit' },
  );
  const raw = await fs.readFile(src);
  const aus = splitAccessUnits(raw);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await win.webContents.executeJavaScript('new Promise(r => { const t = () => (window.ready ? r(true) : setTimeout(t, 20)); t(); })');

  const chunks = aus.map((au, idx) => ({
    b64: au.toString('base64'),
    meta: { key: idx === 0, ts: idx * 66, width: 160, height: 120 },
  }));
  const pushed = await win.webContents.executeJavaScript(`window.pump(${JSON.stringify(chunks)})`);
  await new Promise((r) => setTimeout(r, 600));

  const stats = await win.webContents.executeJavaScript(
    '({ decoded: window.player.decoded, error: window.decodeError || null, cw: document.getElementById("c").width, diag: window.diag ? window.diag() : null })',
  );

  console.log(
    'H264_E2E:',
    JSON.stringify({ aus: aus.length, pushed, ...stats, chrome: process.versions.chrome }),
  );
  const ok = stats.decoded >= Math.min(6, aus.length) && !stats.error;
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
  app.exit(ok ? 0 : 3);
});
