// Measure audio delivery timing while the video stream is running, to tell
// network-side drops apart from a renderer-side buffering problem.
import { WebSocket } from 'ws';
import { FRAME_KIND, MSG, computeChallengeProof, decodeBinaryEnvelope } from '../packages/shared/src/index.mjs';

const PIN = process.env.RD_PIN || '';
if (!PIN) {
  console.error('set RD_PIN (see C:\\ProgramData\\RemoteDeck\\agent-identity.json)');
  process.exit(2);
}
const codec = process.argv[2] || 'ima_adpcm';
const seconds = Number(process.argv[3] || 8);
const ws = new WebSocket('ws://127.0.0.1:9601/ws');
ws.binaryType = 'arraybuffer';

let audioBytes = 0;
let audioFrames = 0;
let videoFrames = 0;
let lastAudioAt = 0;
let maxGap = 0;
let gapOver60 = 0;
let gapOver150 = 0;
let firstAudioAt = 0;
const gaps = [];
let meta = null;

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === MSG.AUTH_CHALLENGE) {
      ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
    } else if (msg.type === MSG.AUTH_OK) {
      ws.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 60, scale: 1, quality: 80 }));
      setTimeout(() => ws.send(JSON.stringify({ type: MSG.AUDIO_START, codec })), 500);
      setTimeout(finish, seconds * 1000);
    }
    return;
  }
  const env = decodeBinaryEnvelope(data);
  if (env.kind === FRAME_KIND.SCREEN) videoFrames += 1;
  if (env.kind === FRAME_KIND.AUDIO) {
    const now = Date.now();
    if (!firstAudioAt) firstAudioAt = now;
    if (lastAudioAt) {
      const gap = now - lastAudioAt;
      gaps.push(gap);
      if (gap > maxGap) maxGap = gap;
      if (gap > 60) gapOver60 += 1;
      if (gap > 150) gapOver150 += 1;
    }
    lastAudioAt = now;
    audioFrames += 1;
    audioBytes += env.payload.byteLength;
    if (!meta) meta = { codec: env.meta?.codec, sampleRate: env.meta?.sampleRate, channels: env.meta?.channels, frames: env.meta?.frames };
  }
});

function finish() {
  const span = firstAudioAt ? (lastAudioAt - firstAudioAt) / 1000 : 0;
  const expectedBps = meta ? meta.sampleRate * meta.channels * 2 : 0;
  gaps.sort((a, b) => a - b);
  console.log('--- audio delivery ---');
  console.log('codec:', meta ? JSON.stringify(meta) : '(no audio)');
  console.log('frames:', audioFrames, 'bytes:', audioBytes, 'span:', span.toFixed(1) + 's');
  if (expectedBps) console.log('effective rate:', Math.round(audioBytes / Math.max(span, 0.001)), 'B/s  (pcm16 realtime =', expectedBps, 'B/s)');
  console.log('max gap:', maxGap + 'ms', '| >60ms:', gapOver60, '| >150ms:', gapOver150);
  if (gaps.length) console.log('median gap:', gaps[Math.floor(gaps.length / 2)] + 'ms', 'p90:', gaps[Math.floor(gaps.length * 0.9)] + 'ms');
  console.log('video frames:', videoFrames);
  ws.send(JSON.stringify({ type: MSG.AUDIO_STOP }));
  ws.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
