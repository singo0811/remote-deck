// Measures frame pacing as the client sees it: arrival gaps, jitter, full vs
// dirty mix. Node: runs directly against the host (ws://127.0.0.1:9601/ws).
import { WebSocket } from 'ws';
import { MSG, FRAME_KIND, computeChallengeProof, decodeBinaryEnvelope } from '../packages/shared/src/index.mjs';

const PIN = process.env.RD_PIN || '8A5ZH4QD';
const ws = new WebSocket('ws://127.0.0.1:9601/ws');
ws.binaryType = 'arraybuffer';

let samples = [];
let fulls = 0;
let dirties = 0;
let bytes = 0;
let phase = '';

function stats(gaps) {
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const sum = gaps.reduce((a, b) => a + b, 0);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n: gaps.length,
    mean: +(sum / gaps.length).toFixed(1),
    p50: +p(0.5).toFixed(1),
    p95: +p(0.95).toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1),
  };
}

function run(name, cfg, ms) {
  return new Promise((resolve) => {
    samples = [];
    fulls = 0;
    dirties = 0;
    bytes = 0;
    phase = name;
    ws.send(JSON.stringify({ type: MSG.SCREEN_CONFIG, displayId: 0, ...cfg }));
    setTimeout(() => {
      const gaps = [];
      for (let i = 1; i < samples.length; i += 1) gaps.push(samples[i] - samples[i - 1]);
      console.log(
        JSON.stringify({
          phase: name,
          fps: +(samples.length / (ms / 1000)).toFixed(1),
          kBps: Math.round(bytes / (ms / 1000) / 1024),
          fulls,
          dirties,
          gap: stats(gaps),
        }),
      );
      resolve();
    }, ms);
  });
}

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === MSG.AUTH_CHALLENGE) {
      ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
    } else if (msg.type === MSG.AUTH_OK) {
      ws.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, auto: true, fps: 30, allowDirty: true }));
      setTimeout(async () => {
        await run('auto-30', { auto: true, fps: 30, allowDirty: true }, 6000);
        await run('hd-30', { auto: false, fps: 30, scale: 1, quality: 88, allowDirty: true }, 6000);
        await run('hd-30-nodirty', { auto: false, fps: 30, scale: 1, quality: 88, allowDirty: false }, 6000);
        try {
          ws.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
        } catch {}
        ws.close();
        process.exit(0);
      }, 1500);
    }
    return;
  }
  if (!phase) return;
  const env = decodeBinaryEnvelope(data);
  if (env.kind !== FRAME_KIND.SCREEN || env.meta?.video) return;
  if (!env.payload || env.payload.byteLength === 0) return;
  samples.push(performance.now());
  bytes += env.payload.byteLength;
  if (env.meta?.dirty) dirties += 1;
  else fulls += 1;
});

ws.on('error', (e) => {
  console.log('WS_ERR', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(1);
}, 40000);
