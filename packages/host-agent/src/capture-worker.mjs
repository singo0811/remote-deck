/**
 * Capture worker: owns the native child process (stdout pipe, JSON parsing,
 * child lifecycle) so the main thread never has to drain hundreds of KB of
 * frames. The pacing loop stays on the main thread, where its timers are now
 * punctual; frames arrive as zero-copy transferable ArrayBuffers.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { NativeBridge } from './native-bridge.mjs';

const bridge = new NativeBridge({ binaryPath: workerData?.binaryPath });
let seq = 0;

parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'capture') {
    try {
      const { meta, jpeg } = await bridge.captureFrame(msg.req);
      const buf = jpeg && jpeg.length ? Buffer.from(jpeg) : null;
      if (buf) {
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        parentPort.postMessage({ type: 'frame', id: msg.id, meta, jpeg: ab }, [ab]);
      } else {
        parentPort.postMessage({ type: 'frame', id: msg.id, meta, jpeg: null });
      }
    } catch (err) {
      parentPort.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
    }
    return;
  }
  if (msg.type === 'stopVideo') {
    try {
      bridge.stopVideo();
    } catch {}
    return;
  }
  if (msg.type === 'ping') {
    seq += 1;
    parentPort.postMessage({ type: 'pong', seq });
  }
});

parentPort.postMessage({ type: 'ready' });
