import zlib from 'node:zlib';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Generate a crisp 32x32 RGBA PNG icon buffer with no external image files required.
 */
let cachedIcon = null;

/** Brand icon shipped with the desktop app (falls back to the drawn mark). */
export function buildAppIconPng(size = 32) {
  try {
    if (!cachedIcon) {
      const file = fileURLToPath(new URL('../assets/tray-64.png', import.meta.url));
      cachedIcon = fs.readFileSync(file);
    }
    return cachedIcon;
  } catch {
    return drawFallbackIcon(size);
  }
}

function drawFallbackIcon(size = 32) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const r = size / 2;

  for (let y = 0; y < size; y++) {
    const rowOff = y * (1 + size * 4);
    raw[rowOff] = 0; // filter None
    for (let x = 0; x < size; x++) {
      const pxOff = rowOff + 1 + x * 4;
      const dx = Math.abs(x + 0.5 - r);
      const dy = Math.abs(y + 0.5 - r);
      const corner = Math.max(dx - (r - 6), 0) ** 2 + Math.max(dy - (r - 6), 0) ** 2;
      if (corner > 36) {
        // transparent outside rounded square
        continue;
      }

      // Background dark navy
      let R = 15;
      let G = 23;
      let B = 42;
      const A = 255;

      // Cyan monitor outline
      const inMonitorBorder =
        x >= 5 && x <= 23 && y >= 7 && y <= 20 && (x === 5 || x === 23 || y === 7 || y === 20 || x === 6 || y === 8);
      // Monitor stand
      const inStand = x >= 11 && x <= 17 && y >= 22 && y <= 23;
      // Emerald phone badge on bottom-right
      const inPhoneBorder =
        x >= 19 && x <= 27 && y >= 14 && y <= 26 && (x === 19 || x === 27 || y === 14 || y === 26);
      const inPhoneFill = x > 19 && x < 27 && y > 14 && y < 26;

      if (inPhoneFill) {
        R = 15;
        G = 23;
        B = 42;
      }
      if (inMonitorBorder || inStand) {
        R = 56;
        G = 189;
        B = 248;
      }
      if (inPhoneBorder) {
        R = 52;
        G = 211;
        B = 153;
      }

      raw[pxOff + 0] = R;
      raw[pxOff + 1] = G;
      raw[pxOff + 2] = B;
      raw[pxOff + 3] = A;
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
