/**
 * Dedicated pacing worker.
 *
 * The capture loop lives on the Electron/Node main thread, where every frame's
 * stdout pipe drain (hundreds of KB) delays the next setTimeout by ~10 ms and
 * spikes it further. Timers inside a worker are not blocked by that I/O, so the
 * tick stays on schedule and the main thread only has to start the capture.
 */
import { parentPort } from 'node:worker_threads';

let timer = null;
let intervalMs = 33;
let inflight = false;

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer() {
  stopTimer();
  timer = setInterval(() => {
    if (inflight) return; // main thread is still busy: drop this tick
    inflight = true;
    parentPort.postMessage({ type: 'tick' });
  }, intervalMs);
}

parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'interval' && Number(msg.intervalMs) > 0) {
    intervalMs = Math.max(16, Math.round(Number(msg.intervalMs)));
    startTimer();
    return;
  }
  if (msg.type === 'ack') {
    inflight = false;
    return;
  }
  if (msg.type === 'start') {
    if (Number(msg.intervalMs) > 0) intervalMs = Math.max(16, Math.round(Number(msg.intervalMs)));
    inflight = false;
    startTimer();
    return;
  }
  if (msg.type === 'stop') {
    stopTimer();
    inflight = false;
  }
});

parentPort.postMessage({ type: 'ready' });
