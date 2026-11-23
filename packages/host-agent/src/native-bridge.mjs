import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CMD = {
  DISPLAYS: 0x01,
  CAPTURE: 0x02,
  MOUSE: 0x03,
  KEY: 0x04,
  TEXT: 0x05,
  CLIPBOARD: 0x06,
  AUDIO_START: 0x07,
  AUDIO_STOP: 0x08,
  PRIVACY: 0x09,
  SYS_INFO: 0x0a,
  VIDEO_START: 0x0c,
  VIDEO_STOP: 0x0d,
  PTY_OPEN: 0x10,
  PTY_INPUT: 0x11,
  PTY_RESIZE: 0x12,
  PTY_CLOSE: 0x13,
};

const EVT = {
  JSON: 0x81,
  SCREEN_FRAME: 0x82,
  CLIPBOARD: 0x83,
  AUDIO_FRAME: 0x84,
  VIDEO_PACKET: 0x85,
  PTY_OPENED: 0x90,
  PTY_OUTPUT: 0x91,
  PTY_EXIT: 0x92,
};

export function resolveNativeBinaryPath() {
  const exeName = process.platform === 'win32' ? 'remote-native.exe' : 'remote-native';
  return path.resolve(__dirname, '../bin', exeName);
}

/**
 * Framed binary IPC bridge to the compiled Go native helper.
 */
export class NativeBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.binaryPath = options.binaryPath || resolveNativeBinaryPath();
    this.proc = null;
    this.rxBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.captureQueue = [];
    this.reqCounter = 0;
    this.closing = false;
  }

  start() {
    if (this.proc) return;
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Native helper binary not found at ${this.binaryPath}. Run "npm run build:native" first.`);
    }
    this.closing = false;
    this.proc = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', (chunk) => this.#onStdoutData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.emit('log', text);
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      this.#rejectAll(new Error(`Native helper exited with code ${code}`));
      if (!this.closing) {
        this.emit('exit', code);
      }
    });
  }

  stop() {
    this.closing = true;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.#rejectAll(new Error('Native bridge stopped'));
  }

  #rejectAll(err) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    while (this.captureQueue.length > 0) {
      const item = this.captureQueue.shift();
      clearTimeout(item.timer);
      item.reject(err);
    }
  }

  #writeFrame(typeByte, payloadBuf) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('Native helper is not running');
    }
    const hdr = Buffer.allocUnsafe(5);
    hdr[0] = typeByte;
    hdr.writeUInt32BE(payloadBuf.length, 1);
    this.proc.stdin.write(Buffer.concat([hdr, payloadBuf]));
  }

  #sendJson(typeByte, obj) {
    this.#writeFrame(typeByte, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  #nextReqId() {
    this.reqCounter += 1;
    return `r${this.reqCounter}`;
  }

  #onStdoutData(chunk) {
    this.rxBuffer = this.rxBuffer.length === 0 ? chunk : Buffer.concat([this.rxBuffer, chunk]);
    while (this.rxBuffer.length >= 5) {
      const frameType = this.rxBuffer[0];
      const len = this.rxBuffer.readUInt32BE(1);
      if (this.rxBuffer.length < 5 + len) break;
      const payload = this.rxBuffer.subarray(5, 5 + len);
      this.rxBuffer = this.rxBuffer.subarray(5 + len);
      this.#handleFrame(frameType, payload);
    }
  }

  #handleFrame(frameType, payload) {
    if (frameType === EVT.JSON || frameType === EVT.CLIPBOARD) {
      let msg;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      if (msg.reqId && this.pending.has(msg.reqId)) {
        const entry = this.pending.get(msg.reqId);
        this.pending.delete(msg.reqId);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg);
        return;
      }
      if (msg.op === 'capture_error' && this.captureQueue.length > 0) {
        const entry = this.captureQueue.shift();
        clearTimeout(entry.timer);
        entry.reject(new Error(msg.error || 'capture error'));
        return;
      }
      if (msg.op === 'pty_error') {
        this.emit('pty_error', msg);
      }
      if (msg.op === 'changed') {
        this.emit('clipboard_changed', {
          text: msg.text || '',
          imageBase64: msg.imageBase64 || '',
        });
      }
      return;
    }

    if (frameType === EVT.SCREEN_FRAME) {
      if (payload.length < 4) return;
      const metaLen = payload.readUInt32BE(0);
      if (4 + metaLen > payload.length) return;
      const meta = JSON.parse(payload.subarray(4, 4 + metaLen).toString('utf8'));
      const jpeg = payload.subarray(4 + metaLen);
      const entry = this.captureQueue.shift();
      if (entry) {
        clearTimeout(entry.timer);
        entry.resolve({ meta, jpeg });
      }
      return;
    }

    if (frameType === EVT.AUDIO_FRAME) {
      if (payload.length < 4) return;
      const metaLen = payload.readUInt32BE(0);
      if (4 + metaLen > payload.length) return;
      try {
        const meta = JSON.parse(payload.subarray(4, 4 + metaLen).toString('utf8'));
        const pcm = payload.subarray(4 + metaLen);
        this.emit('audio_frame', { meta, pcm });
      } catch {}
      return;
    }

    if (frameType === EVT.VIDEO_PACKET) {
      if (payload.length < 4) return;
      const metaLen = payload.readUInt32BE(0);
      if (4 + metaLen > payload.length) return;
      try {
        const meta = JSON.parse(payload.subarray(4, 4 + metaLen).toString('utf8'));
        this.emit('video_packet', { meta, data: payload.subarray(4 + metaLen) });
      } catch {}
      return;
    }

    if (frameType === EVT.PTY_OPENED) {
      try {
        this.emit('pty_opened', JSON.parse(payload.toString('utf8')));
      } catch {}
      return;
    }

    if (frameType === EVT.PTY_OUTPUT) {
      if (payload.length < 4) return;
      const idLen = payload.readUInt32BE(0);
      if (4 + idLen > payload.length) return;
      const id = payload.subarray(4, 4 + idLen).toString('utf8');
      const data = payload.subarray(4 + idLen);
      this.emit('pty_output', { id, data });
      return;
    }

    if (frameType === EVT.PTY_EXIT) {
      try {
        this.emit('pty_exit', JSON.parse(payload.toString('utf8')));
      } catch {}
    }
  }

  #requestJson(typeByte, obj, timeoutMs = 5000) {
    this.start();
    const reqId = this.#nextReqId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Native request timed out (${reqId})`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.#sendJson(typeByte, { ...obj, reqId });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err);
      }
    });
  }

  async getDisplays() {
    const res = await this.#requestJson(CMD.DISPLAYS, {});
    return res.displays || [];
  }

  captureFrame({ displayId = 0, scale = 0.75, quality = 70, lastHash = '', seq = 0, allowDirty = false, video = false, fps = 20, paceMs = 0, roiX = 0, roiY = 0, roiW = 0, roiH = 0 } = {}) {
    this.start();
    const reqId = this.#nextReqId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.captureQueue.findIndex((item) => item.reqId === reqId);
        if (idx >= 0) this.captureQueue.splice(idx, 1);
        reject(new Error('Screen capture timed out'));
      }, 5000);
      this.captureQueue.push({ reqId, resolve, reject, timer });
      try {
        this.#sendJson(CMD.CAPTURE, { reqId, displayId, scale, quality, lastHash, seq, allowDirty, video, fps, paceMs, roiX, roiY, roiW, roiH });
      } catch (err) {
        clearTimeout(timer);
        const idx = this.captureQueue.findIndex((item) => item.reqId === reqId);
        if (idx >= 0) this.captureQueue.splice(idx, 1);
        reject(err);
      }
    });
  }

  stopVideo() {
    if (!this.proc) return;
    this.#sendJson(CMD.VIDEO_STOP, {});
  }

  startAudio({ lowBandwidth = false, preferOpus = false } = {}) {
    this.start();
    this.#sendJson(CMD.AUDIO_START, {
      lowBandwidth: Boolean(lowBandwidth),
      preferOpus: Boolean(preferOpus),
    });
  }

  stopAudio() {
    if (!this.proc) return;
    this.#sendJson(CMD.AUDIO_STOP, {});
  }

  async setPrivacy(enabled) {
    const res = await this.#requestJson(CMD.PRIVACY, { enabled: Boolean(enabled) });
    return Boolean(res.enabled);
  }

  async getSysInfo() {
    return await this.#requestJson(CMD.SYS_INFO, {});
  }

  injectMouse(req) {
    this.start();
    this.#sendJson(CMD.MOUSE, req);
  }

  injectKey(req) {
    this.start();
    this.#sendJson(CMD.KEY, req);
  }

  injectText(text) {
    this.start();
    this.#sendJson(CMD.TEXT, { text: String(text || '') });
  }

  async getClipboard() {
    const res = await this.#requestJson(CMD.CLIPBOARD, { op: 'get' });
    return { text: res.text || '', imageBase64: res.imageBase64 || '' };
  }

  async setClipboard(text) {
    await this.#requestJson(CMD.CLIPBOARD, { op: 'set', text: String(text ?? '') });
  }

  async setClipboardImage(imageBase64) {
    await this.#requestJson(CMD.CLIPBOARD, { op: 'set', imageBase64: String(imageBase64 || '') });
  }

  async setClipboardWatch(enabled) {
    try {
      await this.#requestJson(CMD.CLIPBOARD, { op: 'watch', enabled: Boolean(enabled) }, 3000);
    } catch {}
  }

  openPty({ id, cols = 100, rows = 30, shell = 'powershell', cwd = '' }) {
    this.start();
    this.#sendJson(CMD.PTY_OPEN, { id, cols, rows, shell, cwd });
  }

  writePty(id, data) {
    this.start();
    const idBuf = Buffer.from(id, 'utf8');
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const payload = Buffer.allocUnsafe(4 + idBuf.length + dataBuf.length);
    payload.writeUInt32BE(idBuf.length, 0);
    idBuf.copy(payload, 4);
    dataBuf.copy(payload, 4 + idBuf.length);
    this.#writeFrame(CMD.PTY_INPUT, payload);
  }

  resizePty(id, cols, rows) {
    this.start();
    this.#sendJson(CMD.PTY_RESIZE, { id, cols, rows });
  }

  closePty(id) {
    if (!this.proc) return;
    this.#sendJson(CMD.PTY_CLOSE, { id });
  }
}
