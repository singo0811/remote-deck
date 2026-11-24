// Report the effective stream parameters the host actually produces for a given
// client request (resolution, fps, bitrate) — the phone only sees the result.
import { WebSocket } from 'ws';
import { FRAME_KIND, MSG, computeChallengeProof, decodeBinaryEnvelope } from '../packages/shared/src/index.mjs';

const PIN = process.env.RD_PIN || '';
if (!PIN) {
  console.error('set RD_PIN');
  process.exit(2);
}
const ws = new WebSocket('ws://127.0.0.1:9601/ws');
ws.binaryType = 'arraybuffer';

const stat = { frames: 0, bytes: 0, w: 0, h: 0, startAt: 0, lastAt: 0, maxFrame: 0, vFrames: 0, vBytes: 0, vMax: 0 };

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === MSG.AUTH_CHALLENGE) {
      ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
    } else if (msg.type === MSG.AUTH_OK) {
      run();
    }
    return;
  }
  const env = decodeBinaryEnvelope(data);
  if (env.kind === FRAME_KIND.VIDEO) {
    const t = Date.now();
    if (!stat.startAt) stat.startAt = t;
    stat.lastAt = t;
    stat.vFrames += 1;
    stat.vBytes += env.payload.byteLength;
    if (env.payload.byteLength > stat.vMax) stat.vMax = env.payload.byteLength;
    if (env.meta?.width) { stat.w = env.meta.width; stat.h = env.meta.height; }
    return;
  }
  if (env.kind !== FRAME_KIND.SCREEN) return;
  const now = Date.now();
  if (!stat.startAt) stat.startAt = now;
  stat.lastAt = now;
  stat.frames += 1;
  stat.bytes += env.payload.byteLength;
  if (env.payload.byteLength > stat.maxFrame) stat.maxFrame = env.payload.byteLength;
  stat.w = env.meta.width;
  stat.h = env.meta.height;
});

async function measure(label, cfg, ms = 3500) {
  Object.assign(stat, { frames: 0, bytes: 0, w: 0, h: 0, startAt: 0, lastAt: 0, maxFrame: 0, vFrames: 0, vBytes: 0, vMax: 0 });
  ws.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, ...cfg }));
  await new Promise((r) => setTimeout(r, ms));
  const span = stat.startAt ? (stat.lastAt - stat.startAt) / 1000 : 0;
  const useVideo = stat.vFrames > 0;
  const framesSeen = useVideo ? stat.vFrames : stat.frames;
  const fps = span > 0 ? (framesSeen - 1) / span : 0;
  const byteCount = useVideo ? stat.vBytes : stat.bytes;
  const kbps = span > 0 ? Math.round((byteCount * 8) / span / 1000) : 0;
  const biggest = useVideo ? stat.vMax : stat.maxFrame;
  const kindLabel = useVideo ? 'h264' : 'jpeg';
  console.log(
    `${label.padEnd(22)} ${String(stat.w).padStart(4)}x${String(stat.h).padEnd(4)} fps≈${fps.toFixed(1).padStart(5)} ` +
      `${String(kbps).padStart(6)} kbps  maxFrame=${Math.round(biggest / 1024)}KB ${kindLabel}`,
  );
  ws.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
  await new Promise((r) => setTimeout(r, 400));
}

async function run() {
  const base = { codec: 'h264', separateCursor: true, allowDirty: true, singleFrame: true };
  console.log('preset               resolution  fps     bitrate');
  await measure('智能 auto(30,.72,74)', { ...base, fps: 30, scale: 0.72, quality: 74, auto: true, maxWidth: 1440 });
  await measure('流畅 eco(24,.5,62)', { ...base, fps: 24, scale: 0.5, quality: 62, auto: false, maxWidth: 1280 });
  await measure('均衡 bal(28,.72,76)', { ...base, fps: 28, scale: 0.72, quality: 76, auto: false, maxWidth: 1440 });
  await measure('高清 hd(30,.88,84)', { ...base, fps: 30, scale: 0.88, quality: 84, auto: false, maxWidth: 1600 });
  await measure('超清 uhd(24,1.0,92)', { ...base, fps: 24, scale: 1.0, quality: 92, auto: false, maxWidth: 0 });
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
