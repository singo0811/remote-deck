// Reproduce the phone's preset-switch flow: one SCREEN_START, then SCREEN_CONFIG
// changes, and report whether the H.264 stream actually changes resolution.
import { WebSocket } from 'ws';
import { FRAME_KIND, MSG, computeChallengeProof, decodeBinaryEnvelope } from '../packages/shared/src/index.mjs';

const PIN = process.env.RD_PIN || '';
if (!PIN) {
  console.error('set RD_PIN');
  process.exit(2);
}
const ws = new WebSocket('ws://127.0.0.1:9601/ws');
ws.binaryType = 'arraybuffer';

const stat = { frames: 0, bytes: 0, w: 0, h: 0, first: 0, last: 0, max: 0, jpeg: 0, jpegBytes: 0, key: 0 };
ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === MSG.AUTH_CHALLENGE) {
      ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
    } else if (msg.type === MSG.AUTH_OK) {
      void run();
    } else if (msg.type === MSG.SCREEN_CONFIG) {
      console.log('   host said:', JSON.stringify(msg));
    }
    return;
  }
  const env = decodeBinaryEnvelope(data);
  const now = Date.now();
  if (env.kind === FRAME_KIND.VIDEO) {
    if (!stat.first) stat.first = now;
    stat.last = now;
    stat.frames += 1;
    stat.bytes += env.payload.byteLength;
    if (env.payload.byteLength > stat.max) stat.max = env.payload.byteLength;
    if (env.meta?.key) stat.key += 1;
    if (env.meta?.width) { stat.w = env.meta.width; stat.h = env.meta.height; }
  } else if (env.kind === FRAME_KIND.SCREEN) {
    stat.jpeg += 1;
    stat.jpegBytes += env.payload.byteLength;
    if (env.meta?.width) { stat.w = env.meta.width; stat.h = env.meta.height; }
  }
});

async function window(label, ms = 4000) {
  Object.assign(stat, { frames: 0, bytes: 0, w: 0, h: 0, first: 0, last: 0, max: 0, jpeg: 0, jpegBytes: 0, key: 0 });
  await new Promise((r) => setTimeout(r, ms));
  const span = stat.first ? (stat.last - stat.first) / 1000 : 0;
  const fps = span > 0 ? (stat.frames - 1) / span : 0;
  const kbps = span > 0 ? Math.round((stat.bytes * 8) / span / 1000) : 0;
  console.log(
    `${label.padEnd(26)} h264=${String(stat.frames).padStart(4)}f ${fps.toFixed(1).padStart(5)}fps ` +
      `${stat.w}x${stat.h} ${String(kbps).padStart(5)}kbps max=${Math.round(stat.max / 1024)}KB keys=${stat.key} | jpeg=${stat.jpeg} ${Math.round(stat.jpegBytes / 1024)}KB`,
  );
}

async function run() {
  // What the phone does on connect with 超清
  ws.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 24, scale: 1.0, quality: 92, auto: false, maxWidth: 0, codec: 'h264', allowDirty: true, separateCursor: true, singleFrame: true }));
  await window('start: 超清 (1.0/92)');

  // …then the user picks 流畅 (this is what configScreen sends)
  ws.send(JSON.stringify({ type: MSG.SCREEN_CONFIG, fps: 24, scale: 0.5, quality: 62, maxWidth: 1280, auto: false }));
  await window('config: 流畅 (0.5/62)');

  ws.send(JSON.stringify({ type: MSG.SCREEN_CONFIG, fps: 30, scale: 0.88, quality: 84, maxWidth: 1600, auto: false }));
  await window('config: 高清 (0.88/84)');

  ws.send(JSON.stringify({ type: MSG.SCREEN_CONFIG, fps: 24, scale: 1.0, quality: 92, maxWidth: 0, auto: false }));
  await window('config: 超清 back');

  ws.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
