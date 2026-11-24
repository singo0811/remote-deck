// Run an isolated host agent against the real screen and report encoder restarts
// and keyframe ratio — isolates "every frame is a keyframe" from the live app.
import { HostAgent } from '../packages/host-agent/src/agent.mjs';
import { WebSocket } from 'ws';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_KIND, MSG, computeChallengeProof, decodeBinaryEnvelope } from '../packages/shared/src/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(here, '../apps/web/dist');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-enc-'));
const PIN = 'DIAGPIN1';

const starts = [];
const agent = new HostAgent({
  lanPort: 0,
  lanHost: '127.0.0.1',
  discoveryPort: 0,
  deviceId: 'RD-DIAG-0001',
  pin: PIN,
  deviceName: 'diag',
  allowedRoots: [tempRoot],
  webDistDir,
});

const log = [];
const origWarn = console.warn;
console.warn = (...args) => {
  const text = args.join(' ');
  if (text.includes('video_start')) starts.push(text);
  log.push(text);
  origWarn(...args);
};

const info = await agent.start();
const ws = new WebSocket(`ws://127.0.0.1:${info.lanPort}/ws`);
ws.binaryType = 'arraybuffer';

let frames = 0;
let keys = 0;
let bytes = 0;
let first = 0;
let last = 0;
let w = 0;
let h = 0;

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === MSG.AUTH_CHALLENGE) {
      ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
    } else if (msg.type === MSG.AUTH_OK) {
      ws.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 24, scale: 1.0, quality: 92, auto: false, maxWidth: 0, codec: 'h264' }));
      setTimeout(finish, 4000);
    }
    return;
  }
  const env = decodeBinaryEnvelope(data);
  if (env.kind !== FRAME_KIND.VIDEO) return;
  const now = Date.now();
  if (!first) first = now;
  last = now;
  frames += 1;
  bytes += env.payload.byteLength;
  if (env.meta?.key) keys += 1;
  if (env.meta?.width) { w = env.meta.width; h = env.meta.height; }
});

function finish() {
  const span = first ? (last - first) / 1000 : 0;
  console.log('--- encoder diagnostic (超清 3440x1440@24) ---');
  console.log(`frames=${frames} keyframes=${keys} ${w}x${h} fps=${(frames / Math.max(span, 0.001)).toFixed(1)}`);
  console.log(`bitrate=${Math.round((bytes * 8) / Math.max(span, 0.001) / 1000)} kbps  avgFrame=${Math.round(bytes / Math.max(frames, 1) / 1024)}KB`);
  console.log(`encoder starts=${starts.length}`);
  for (const s of starts.slice(0, 6)) console.log('  ' + s.replace(/\s+/g, ' ').slice(0, 180));
  ws.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
  ws.close();
  agent.stop().finally(() => fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {}).then(() => process.exit(0)));
}
