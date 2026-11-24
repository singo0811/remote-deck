// Per-frame latency breakdown as the host sees it: capture cost (bt), total
// host-side work (tw), pacing gaps, and input -> next-frame round trip.
import { WebSocket } from 'ws';
import { FRAME_KIND, MSG, computeChallengeProof, decodeBinaryEnvelope } from '../packages/shared/src/index.mjs';

const PIN = process.env.RD_PIN || '';
if (!PIN) {
  console.error('set RD_PIN');
  process.exit(2);
}
const ws = new WebSocket('ws://127.0.0.1:9601/ws');
ws.binaryType = 'arraybuffer';

const arrivals = [];
const bt = [];
const tw = [];
let echoSentAt = 0;
let echoWait = 0;
let lastFrameAt = 0;
const gaps = [];

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === MSG.AUTH_CHALLENGE) {
      ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
    } else if (msg.type === MSG.AUTH_OK) {
      void run();
    }
    return;
  }
  const env = decodeBinaryEnvelope(data);
  if (env.kind !== FRAME_KIND.VIDEO && env.kind !== FRAME_KIND.SCREEN) return;
  const now = Date.now();
  const meta = env.meta || {};
  if (meta.ts) arrivals.push(now - meta.ts);
  if (Number.isFinite(meta.bt)) bt.push(meta.bt);
  if (Number.isFinite(meta.tw)) tw.push(meta.tw);
  if (lastFrameAt) gaps.push(now - lastFrameAt);
  lastFrameAt = now;
  if (echoWait && meta.echo && meta.echo.ts >= echoWait) {
    console.log(`   input->frame: ${now - meta.echo.ts} ms (echo ${meta.echo.action})`);
    echoWait = 0;
  }
});

const stats = (arr) => {
  if (!arr.length) return 'n/a';
  const s = [...arr].sort((a, b) => a - b);
  const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  return `avg=${avg} p50=${Math.round(s[Math.floor(s.length * 0.5)])} p90=${Math.round(s[Math.floor(s.length * 0.9)])} max=${Math.round(s[s.length - 1])}`;
};

async function window(label, ms = 3500) {
  arrivals.length = 0; bt.length = 0; tw.length = 0; gaps.length = 0; lastFrameAt = 0;
  await new Promise((r) => setTimeout(r, ms));
  const fps = gaps.length ? 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
  console.log(`${label.padEnd(18)} fps≈${fps.toFixed(1)}`);
  console.log(`   host frame age (send->client): ${stats(arrivals)} ms`);
  console.log(`   capture backend bt          : ${stats(bt)} ms`);
  console.log(`   host capture+encode tw      : ${stats(tw)} ms`);
}

async function run() {
  ws.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 30, scale: 0.72, quality: 76, auto: false, maxWidth: 1440, codec: 'h264', allowDirty: true, separateCursor: true, singleFrame: true }));
  await window('均衡 1440 (30fps)');

  ws.send(JSON.stringify({ type: MSG.SCREEN_CONFIG, fps: 24, scale: 1.0, quality: 92, maxWidth: 0, auto: false }));
  await window('超清 3440 (24fps)');

  ws.send(JSON.stringify({ type: MSG.SCREEN_CONFIG, fps: 30, scale: 0.5, quality: 62, maxWidth: 1280, auto: false }));
  await window('流畅 1720 (30fps)');

  // Input round trip: move the mouse and wait for a frame that echoes it.
  console.log('--- input round trip (mouse moves) ---');
  for (let i = 0; i < 4; i += 1) {
    echoWait = Date.now();
    ws.send(JSON.stringify({ type: MSG.INPUT_MOUSE, action: 'move', x: 0.3 + i * 0.1, y: 0.5 }));
    await new Promise((r) => setTimeout(r, 700));
  }

  ws.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
