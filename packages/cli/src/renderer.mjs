import jpeg from 'jpeg-js';

/**
 * Render a JPEG buffer into 24-bit TrueColor ANSI half-block art (`▀`)
 * sized to `cols` x `rows` terminal cells, with optional zoom & pan.
 */
export function renderJpegToAnsi(jpegBuf, cols = 100, rows = 30, { zoom = 1, panX = 0.5, panY = 0.5 } = {}) {
  const decoded = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: true });
  const srcW = decoded.width;
  const srcH = decoded.height;
  const px = decoded.data;

  const targetW = Math.max(20, cols);
  const targetH = Math.max(10, rows * 2); // 2 vertical pixels per terminal row via `▀`

  const z = Math.max(1, zoom);
  const viewW = srcW / z;
  const viewH = srcH / z;
  const startX = Math.max(0, Math.min(srcW - viewW, panX * srcW - viewW / 2));
  const startY = Math.max(0, Math.min(srcH - viewH, panY * srcH - viewH / 2));

  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    const syTop = Math.min(srcH - 1, Math.floor(startY + ((r * 2) / targetH) * viewH));
    const syBot = Math.min(srcH - 1, Math.floor(startY + ((r * 2 + 1) / targetH) * viewH));
    for (let c = 0; c < targetW; c += 1) {
      const sx = Math.min(srcW - 1, Math.floor(startX + (c / targetW) * viewW));
      const iTop = (syTop * srcW + sx) * 4;
      const iBot = (syBot * srcW + sx) * 4;
      line += `\x1b[38;2;${px[iTop]};${px[iTop + 1]};${px[iTop + 2]};48;2;${px[iBot]};${px[iBot + 1]};${px[iBot + 2]}m▀`;
    }
    line += '\x1b[0m';
    lines.push(line);
  }
  return { text: lines.join('\n'), width: srcW, height: srcH };
}

export function detectRendererPreference() {
  const term = String(process.env.TERM || '').toLowerCase();
  const prog = String(process.env.TERM_PROGRAM || '').toLowerCase();
  if (term.includes('kitty') || prog.includes('kitty') || prog.includes('ghostty') || prog.includes('wezterm')) {
    return 'kitty';
  }
  return 'ansi';
}

/**
 * Emit a Kitty graphics protocol frame (compressed JPEG/direct chunked or fallback).
 */
export function renderJpegToKitty(jpegBuf) {
  // Kitty's graphics protocol expects PNG or raw RGBA; for broad terminal reliability,
  // convert JPEG via jpeg-js into compact RGB chunked `f=24` payload.
  const decoded = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: true });
  const rgb = Buffer.alloc(decoded.width * decoded.height * 3);
  for (let i = 0, j = 0; i < decoded.data.length; i += 4, j += 3) {
    rgb[j] = decoded.data[i];
    rgb[j + 1] = decoded.data[i + 1];
    rgb[j + 2] = decoded.data[i + 2];
  }
  const b64 = rgb.toString('base64');
  const chunkSize = 4096;
  let out = '\x1b[H';
  for (let offset = 0; offset < b64.length; offset += chunkSize) {
    const chunk = b64.slice(offset, offset + chunkSize);
    const more = offset + chunkSize < b64.length ? 1 : 0;
    if (offset === 0) {
      out += `\x1b_Ga=T,f=24,s=${decoded.width},v=${decoded.height},q=2,m=${more};${chunk}\x1b\\`;
    } else {
      out += `\x1b_Gm=${more};${chunk}\x1b\\`;
    }
  }
  return { text: out, width: decoded.width, height: decoded.height };
}
