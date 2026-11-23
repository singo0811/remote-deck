import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDeviceEnvironment } from '../apps/web/src/lib/device.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../apps/web/dist');

test('responsive tier detection adapts to Desktop, Tablet, Phone, and manual overrides', () => {
  const prevWindow = globalThis.window;
  const prevNav = globalThis.navigator;

  const mockEnv = (width, height, coarse, touchPoints = 0) => {
    globalThis.window = {
      innerWidth: width,
      innerHeight: height,
      matchMedia: () => ({ matches: coarse }),
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: { maxTouchPoints: touchPoints },
      configurable: true,
    });
  };

  try {
    mockEnv(1440, 900, false, 0);
    assert.equal(detectDeviceEnvironment('auto').tier, 'desktop');

    mockEnv(820, 1180, true, 5);
    assert.equal(detectDeviceEnvironment('auto').tier, 'tablet');

    mockEnv(390, 844, true, 5);
    assert.equal(detectDeviceEnvironment('auto').tier, 'phone');
    assert.equal(detectDeviceEnvironment('desktop').tier, 'desktop');
    assert.equal(detectDeviceEnvironment('tablet').tier, 'tablet');
  } finally {
    globalThis.window = prevWindow;
    if (prevNav !== undefined) {
      Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true });
    }
  }
});

test('built web PWA bundle contains required adaptive assets and manifest', async () => {
  const files = await fs.readdir(distDir);
  for (const required of ['index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'sw.js', 'icon.svg']) {
    assert.ok(files.includes(required), `missing built asset: ${required}`);
  }
  const css = await fs.readFile(path.join(distDir, 'app.css'), 'utf8');
  assert.match(css, /\.tier-phone/);
  assert.match(css, /\.tier-tablet/);
  assert.match(css, /touch-dock/);
});

// Guards the low-latency / interaction features added after the initial PWA
// shell: they live in the bundled app, so a silent build regression would
// otherwise only show up when someone connects from a browser.
test('built web bundle ships separate-cursor, pointer-lock, drag-drop upload and Opus audio', async () => {
  const js = await fs.readFile(path.join(distDir, 'app.js'), 'utf8');
  const css = await fs.readFile(path.join(distDir, 'app.css'), 'utf8');

  for (const marker of [
    'separateCursor',      // host streams a cursor shape separate from the video
    'cursorShape',         // canvas overlay paints the remote cursor
    'requestPointerLock',  // relative mouse mode for remote games/CAD
    'rd-upload-progress',  // drag-and-drop upload progress + cancel UI
    'AudioDecoder',        // WebCodecs Opus decode path
    'roi',                 // ROI frame painting
  ]) {
    assert.ok(js.includes(marker), `app.js is missing feature marker: ${marker}`);
  }
  for (const cls of ['.rd-remote-cursor', '.rd-drop-overlay', '.rd-upload-progress', '.rd-pointer-lock-pill']) {
    assert.ok(css.includes(cls), `app.css is missing: ${cls}`);
  }
});
