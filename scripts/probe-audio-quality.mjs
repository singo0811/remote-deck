// Validate captured audio numerically: a correct conversion yields sane RMS for
// PCM16 output, while a format mis-detection produces near-full-scale noise.
import { NativeBridge } from '../packages/host-agent/src/native-bridge.mjs';

const bridge = new NativeBridge();
const stats = { frames: 0, bytes: 0, codec: null, sampleRate: 0, channels: 0, peak: 0, sumSq: 0, samples: 0, info: null };

bridge.on('log', (t) => console.log('[helper]', t));
bridge.on('audio_error', (m) => console.log('[audio_error]', JSON.stringify(m)));
bridge.on('audio_frame', ({ meta, pcm }) => {
  if (!meta || meta.codec !== 'pcm16') return; // only the raw PCM path is measurable directly
  stats.frames += 1;
  stats.bytes += pcm.length;
  stats.codec = meta.codec;
  stats.sampleRate = meta.sampleRate;
  stats.channels = meta.channels;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i + 1 < view.byteLength; i += 2) {
    const v = view.getInt16(i, true);
    const a = Math.abs(v);
    if (a > stats.peak) stats.peak = a;
    stats.sumSq += v * v;
    stats.samples += 1;
  }
});

bridge.start();
await new Promise((r) => setTimeout(r, 300));
bridge.startAudio({ lowBandwidth: false, preferOpus: false });
await new Promise((r) => setTimeout(r, 3500));

const rms = stats.samples > 0 ? Math.sqrt(stats.sumSq / stats.samples) : 0;
console.log('--- pcm16 capture stats ---');
console.log('frames:', stats.frames, 'bytes:', stats.bytes, `rate=${stats.sampleRate} ch=${stats.channels}`);
console.log('peak:', Math.round(stats.peak), 'rms:', Math.round(rms));
console.log('verdict:', rms === 0 ? 'silent' : rms > 20000 ? 'LIKELY NOISE (near full scale)' : 'plausible audio');
try { bridge.stopAudio(); } catch {}
try { bridge.stop(); } catch {}
setTimeout(() => process.exit(0), 300);
