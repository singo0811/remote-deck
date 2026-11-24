// Live probe against the running host agent: does it actually emit audio frames
// and clipboard payloads? Isolates host-side vs phone-side breakage.
import { WebSocket } from 'ws';
import {
  FRAME_KIND,
  MSG,
  computeChallengeProof,
  decodeBinaryEnvelope,
} from '../packages/shared/src/index.mjs';

const PIN = process.env.RD_PIN || '';
if (!PIN) {
  console.error('set RD_PIN to the host pairing code (see C:\\ProgramData\\RemoteDeck\\agent-identity.json)');
  process.exit(2);
}
const URL = process.env.RD_WS || 'ws://127.0.0.1:9601/ws';

function auth(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('auth timeout')), 8000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === MSG.AUTH_CHALLENGE) {
        ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
      } else if (msg.type === MSG.AUTH_OK) {
        clearTimeout(timer);
        resolve(msg);
      } else if (msg.type === MSG.AUTH_ERROR) {
        clearTimeout(timer);
        reject(new Error(msg.error));
      }
    });
  });
}

const counts = { screen: 0, audio: 0, clipboard: [], audioMeta: null, errors: [] };
const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';
ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === MSG.CLIPBOARD_DATA) counts.clipboard.push({ text: (msg.text || '').slice(0, 60), auto: Boolean(msg.auto), image: Boolean(msg.imageBase64) });
    if (msg.type === MSG.ERROR || msg.type === MSG.FS_ERROR) counts.errors.push(msg.error || msg.code || 'error');
    return;
  }
  const env = decodeBinaryEnvelope(data);
  if (env.kind === FRAME_KIND.SCREEN) counts.screen += 1;
  if (env.kind === FRAME_KIND.AUDIO) {
    counts.audio += 1;
    if (!counts.audioMeta) counts.audioMeta = { sampleRate: env.meta?.sampleRate, channels: env.meta?.channels, codec: env.meta?.codec, bytes: env.payload?.byteLength };
  }
});

const authInfo = await auth(ws);
console.log('auth ok:', authInfo.deviceId, 'permissions=', JSON.stringify(authInfo.permissions));

const codecArg = process.argv[2] || 'ima_adpcm';
ws.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 10, scale: 0.3, quality: 50 }));
await new Promise((r) => setTimeout(r, 800));
ws.send(JSON.stringify({ type: MSG.AUDIO_START, codec: codecArg }));
ws.send(JSON.stringify({ type: MSG.CLIPBOARD_WATCH, enabled: true }));
await new Promise((r) => setTimeout(r, 1200));
ws.send(JSON.stringify({ type: MSG.CLIPBOARD_GET }));
await new Promise((r) => setTimeout(r, 4500));

console.log('--- results ---');
console.log('codec requested:', codecArg);
console.log('screen frames  :', counts.screen);
console.log('audio frames   :', counts.audio, counts.audioMeta ? JSON.stringify(counts.audioMeta) : '(none)');
console.log('clipboard msgs :', counts.clipboard.length, JSON.stringify(counts.clipboard.slice(0, 3)));
console.log('errors         :', counts.errors.slice(0, 5));

ws.send(JSON.stringify({ type: MSG.AUDIO_STOP }));
ws.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
ws.close();
setTimeout(() => process.exit(0), 300);
