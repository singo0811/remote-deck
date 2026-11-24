// Zoom leaves an ROI behind: verify a fresh session no longer inherits it.
import { WebSocket } from 'ws';
import { FRAME_KIND, MSG, computeChallengeProof, decodeBinaryEnvelope } from '../packages/shared/src/index.mjs';

const PIN = process.env.RD_PIN || '';
if (!PIN) {
  console.error('set RD_PIN');
  process.exit(2);
}
const stat = { frames: 0, bytes: 0, w: 0, h: 0, first: 0, last: 0, roi: null };

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:9601/ws');
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === MSG.AUTH_CHALLENGE) {
          ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
        } else if (msg.type === MSG.AUTH_OK) resolve(ws);
      } else {
        const env = decodeBinaryEnvelope(data);
        if (env.kind !== FRAME_KIND.VIDEO && env.kind !== FRAME_KIND.SCREEN) return;
        const now = Date.now();
        if (!stat.first) stat.first = now;
        stat.last = now;
        stat.frames += 1;
        stat.bytes += env.payload.byteLength;
        if (env.meta?.width) { stat.w = env.meta.width; stat.h = env.meta.height; }
        if (env.meta?.roi) stat.roi = env.meta.roi;
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('auth timeout')), 8000);
  });
}

const reset = () => Object.assign(stat, { frames: 0, bytes: 0, w: 0, h: 0, first: 0, last: 0, roi: null });

async function window(ws, ms = 2500) {
  reset();
  await new Promise((r) => setTimeout(r, ms));
  const span = stat.first ? (stat.last - stat.first) / 1000 : 0;
  const kbps = span > 0 ? Math.round((stat.bytes * 8) / span / 1000) : 0;
  return `${stat.w}x${stat.h} ${kbps}kbps roi=${stat.roi ? 'SET' : 'none'}`;
}

const A = await connect();
A.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 24, scale: 0.5, quality: 62, auto: false, maxWidth: 1280, codec: 'h264' }));
console.log('session A 流畅      :', await window(A));
// Simulate the phone zooming in (this is what SCREEN_CONFIG with roi+hiRes does)
A.send(JSON.stringify({ type: MSG.SCREEN_CONFIG, roi: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }, hiRes: true }));
console.log('session A zoomed in :', await window(A));
A.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
A.close();
await new Promise((r) => setTimeout(r, 600));

const B = await connect();
B.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 24, scale: 0.5, quality: 62, auto: false, maxWidth: 1280, codec: 'h264' }));
console.log('session B (fresh)   :', await window(B), '  <- must be 1720x720-ish with roi=none');
B.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
B.close();
setTimeout(() => process.exit(0), 300);
