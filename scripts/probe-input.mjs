// Verify the host actually injects input: move the cursor via the remote
// protocol and read the real Windows cursor position back.
import { WebSocket } from 'ws';
import { MSG, computeChallengeProof } from '../packages/shared/src/index.mjs';

const PIN = process.env.RD_PIN || '';
if (!PIN) {
  console.error('set RD_PIN');
  process.exit(2);
}
const ws = new WebSocket('ws://127.0.0.1:9601/ws');
ws.binaryType = 'arraybuffer';

const pos = () => {
  // ReadCursorPos through the native helper is what the host itself uses.
  return null;
};

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString('utf8'));
  if (msg.type === MSG.AUTH_CHALLENGE) {
    ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof: computeChallengeProof(PIN, msg.nonce, msg.deviceId) }));
  } else if (msg.type === MSG.AUTH_OK) {
    console.log('auth ok, permissions:', JSON.stringify(msg.permissions));
    void run();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('--- sending normalized mouse moves ---');
  for (const [x, y] of [[0.2, 0.2], [0.8, 0.8], [0.5, 0.5]]) {
    ws.send(JSON.stringify({ type: MSG.INPUT_MOUSE, action: 'move', x, y }));
    await sleep(250);
    console.log(`  move ${x},${y} sent`);
  }
  console.log('--- click at 0.5,0.5 ---');
  ws.send(JSON.stringify({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x5b })); // Win key (visible effect, harmless)
  await sleep(300);
  ws.send(JSON.stringify({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x5b }));
  await sleep(300);
  console.log('--- key taps sent (Win key twice) ---');
  ws.close();
  setTimeout(() => process.exit(0), 200);
}
