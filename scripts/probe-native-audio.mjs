// Drive the native helper directly to see why audio capture produces no frames.
import { NativeBridge } from '../packages/host-agent/src/native-bridge.mjs';

const bridge = new NativeBridge();
let frames = 0;
let meta = null;
const seen = [];

bridge.on('log', (t) => console.log('[helper]', t));
bridge.on('audio_frame', ({ meta: m, pcm }) => {
  frames += 1;
  if (!meta) meta = { sampleRate: m?.sampleRate, channels: m?.channels, codec: m?.codec, bytes: pcm?.length };
});
// NativeBridge surfaces unknown JSON ops through 'json'? Log whatever we can.
for (const evt of ['json', 'audio_error', 'error']) {
  bridge.on(evt, (p) => {
    seen.push([evt, p]);
    console.log(`[${evt}]`, JSON.stringify(p)?.slice(0, 300));
  });
}

bridge.start();
await new Promise((r) => setTimeout(r, 400));
console.log('starting audio (preferOpus from argv):', process.argv[2] === 'opus');
bridge.startAudio({ lowBandwidth: false, preferOpus: process.argv[2] === 'opus' });
await new Promise((r) => setTimeout(r, 4000));
console.log('--- result ---');
console.log('audio frames:', frames, meta ? JSON.stringify(meta) : '(none)');
console.log('other events:', seen.length);
try { bridge.stopAudio(); } catch {}
try { bridge.stop(); } catch {}
setTimeout(() => process.exit(0), 300);
