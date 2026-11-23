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
