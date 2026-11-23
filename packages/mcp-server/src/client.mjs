import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import {
  FRAME_KIND,
  MSG,
  computeChallengeProof,
  decodeBinaryEnvelope,
} from '@remote-deck/shared';

const VK_MAP = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  left: 0x25,
  arrowleft: 0x25,
  up: 0x26,
  arrowup: 0x26,
  right: 0x27,
  arrowright: 0x27,
  down: 0x28,
  arrowdown: 0x28,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  insert: 0x2d,
  win: 0x5b,
  meta: 0x5b,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
};

export function resolveVk(key) {
  if (typeof key === 'number' && Number.isFinite(key)) return key;
  const s = String(key || '').trim();
  if (!s) return 0;
  const lower = s.toLowerCase();
  if (VK_MAP[lower]) return VK_MAP[lower];
  if (s.length === 1) {
    const code = s.toUpperCase().charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) {
      return code;
    }
  }
  const num = Number(s);
  return Number.isFinite(num) ? num : 0;
}

export function normalizeWsUrl(inputUrl) {
  const raw = String(inputUrl || '').trim() || 'ws://127.0.0.1:9601/ws';
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
    return raw.endsWith('/ws') ? raw : `${raw.replace(/\/+$/, '')}/ws`;
  }
  const norm = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
  const u = new URL(norm);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  return u.toString();
}

export class RemoteControllerClient extends EventEmitter {
  constructor({ url = 'ws://127.0.0.1:9601/ws', pin = '', deviceId = '', mode = 'direct' } = {}) {
    super();
    this.url = normalizeWsUrl(url);
    this.pin = pin;
    this.deviceId = deviceId;
    this.mode = deviceId && mode !== 'direct' ? 'relay' : mode;
    this.ws = null;
    this.authInfo = null;
    this.reqSeq = 1;
    this.pendingFs = new Map();
    this.pendingClipboard = [];
    this.lastFrame = null;
    this.frameWaiters = [];
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.authInfo);
  }

  async connect(timeoutMs = 10000) {
    if (this.connected) return this.authInfo;
    this.disconnect();

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error(`连接超时 (${this.url})`));
        }
      }, timeoutMs);

      const fail = (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.on('open', () => {
        if (this.mode === 'relay' && this.deviceId) {
          ws.send(JSON.stringify({ type: MSG.CONTROLLER_CONNECT, deviceId: this.deviceId }));
        }
      });

      ws.on('error', (err) => fail(err));

      ws.on('close', () => {
        this.ws = null;
        this.authInfo = null;
        for (const [, p] of this.pendingFs) p.reject(new Error('Connection closed'));
        this.pendingFs.clear();
        for (const cb of this.pendingClipboard) cb.reject(new Error('Connection closed'));
        this.pendingClipboard = [];
        for (const fw of this.frameWaiters) fw.reject(new Error('Connection closed'));
        this.frameWaiters = [];
        this.emit('close');
        fail(new Error('连接已关闭'));
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          try {
            const env = decodeBinaryEnvelope(data);
            if (env.kind === FRAME_KIND.SCREEN) {
              const frame = { meta: env.meta || {}, jpeg: Buffer.from(env.payload) };
              if (!frame.meta.dirty) {
                this.lastFrame = frame;
              }
              this.emit('screen', frame);
              if (this.frameWaiters.length > 0 && !frame.meta.dirty) {
                const waiters = this.frameWaiters.splice(0, this.frameWaiters.length);
                for (const w of waiters) w.resolve(frame);
              }
            } else if (env.kind === FRAME_KIND.PTY_OUT) {
              this.emit('pty_output', {
                id: env.meta?.id || '',
                text: Buffer.from(env.payload).toString('utf8'),
              });
            }
          } catch {}
          return;
        }

        let msg;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        if (!settled && msg.type === MSG.AUTH_CHALLENGE) {
          const proof = computeChallengeProof(this.pin, msg.nonce, msg.deviceId);
          ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof }));
          return;
        }
        if (!settled && msg.type === MSG.AUTH_OK) {
          settled = true;
          clearTimeout(timer);
          this.authInfo = msg;
          resolve(msg);
          return;
        }
        if (!settled && (msg.type === MSG.AUTH_ERROR || msg.type === MSG.ERROR)) {
          fail(new Error(msg.error || 'Authentication failed'));
          return;
        }

        if (msg.type === MSG.FS_RESULT || msg.type === MSG.FS_ERROR) {
          const waiter = msg.reqId ? this.pendingFs.get(msg.reqId) : null;
          if (waiter) {
            this.pendingFs.delete(msg.reqId);
            if (msg.type === MSG.FS_ERROR) waiter.reject(new Error(msg.error || 'FS error'));
            else waiter.resolve(msg);
          }
          return;
        }

        if (msg.type === MSG.CLIPBOARD_DATA && !msg.watch) {
          const cb = this.pendingClipboard.shift();
          if (cb) cb.resolve(msg);
          return;
        }

        if (msg.type === MSG.PTY_OPENED || msg.type === MSG.PTY_EXIT) {
          this.emit(msg.type, msg);
        }
      });
    });
  }

  sendJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to RemoteDeck host');
    }
    this.ws.send(JSON.stringify(obj));
  }

  async captureFullFrame({ displayId = 0, scale = 0.85, quality = 82, timeoutMs = 8000 } = {}) {
    await this.connect();
    const waitFrame = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.frameWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.frameWaiters.splice(idx, 1);
        reject(new Error('等待屏幕截图超时'));
      }, timeoutMs);
      this.frameWaiters.push({
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    this.sendJson({
      type: MSG.SCREEN_START,
      displayId,
      fps: 2,
      scale,
      quality,
      auto: false,
      allowDirty: false,
    });
    try {
      return await waitFrame;
    } finally {
      try {
        this.sendJson({ type: MSG.SCREEN_STOP });
      } catch {}
    }
  }

  #normalizeCoords(x, y, normalized = true) {
    if (normalized) {
      return {
        x: Math.max(0, Math.min(1, Number(x))),
        y: Math.max(0, Math.min(1, Number(y))),
      };
    }
    const disp = this.authInfo?.displays?.[0] || { width: 1920, height: 1080 };
    const w = this.lastFrame?.meta?.fullWidth || disp.width || 1920;
    const h = this.lastFrame?.meta?.fullHeight || disp.height || 1080;
    return {
      x: Math.max(0, Math.min(1, Number(x) / w)),
      y: Math.max(0, Math.min(1, Number(y) / h)),
    };
  }

  async click({ x, y, button = 'left', double = false, normalized = true }) {
    await this.connect();
    const pt = this.#normalizeCoords(x, y, normalized);
    this.sendJson({
      type: MSG.INPUT_MOUSE,
      action: double ? 'dblclick' : 'click',
      x: pt.x,
      y: pt.y,
      button,
    });
    return pt;
  }

  async move({ x, y, normalized = true }) {
    await this.connect();
    const pt = this.#normalizeCoords(x, y, normalized);
    this.sendJson({ type: MSG.INPUT_MOUSE, action: 'move', x: pt.x, y: pt.y, button: 'left' });
    return pt;
  }

  async drag({ fromX, fromY, toX, toY, button = 'left', normalized = true }) {
    await this.connect();
    const a = this.#normalizeCoords(fromX, fromY, normalized);
    const b = this.#normalizeCoords(toX, toY, normalized);
    this.sendJson({ type: MSG.INPUT_MOUSE, action: 'down', x: a.x, y: a.y, button });
    await new Promise((r) => setTimeout(r, 60));
    this.sendJson({ type: MSG.INPUT_MOUSE, action: 'move', x: b.x, y: b.y, button });
    await new Promise((r) => setTimeout(r, 60));
    this.sendJson({ type: MSG.INPUT_MOUSE, action: 'up', x: b.x, y: b.y, button });
    return { from: a, to: b };
  }

  async scroll({ deltaY = -240, x, y, normalized = true }) {
    await this.connect();
    if (typeof x === 'number' && typeof y === 'number') {
      const pt = this.#normalizeCoords(x, y, normalized);
      this.sendJson({ type: MSG.INPUT_MOUSE, action: 'move', x: pt.x, y: pt.y, button: 'left' });
    }
    this.sendJson({ type: MSG.INPUT_MOUSE, action: 'wheel', deltaY: Number(deltaY) });
  }

  async typeText(text) {
    await this.connect();
    this.sendJson({ type: MSG.INPUT_TEXT, text: String(text || '') });
  }

  async sendKey({ key, ctrl = false, alt = false, shift = false, meta = false }) {
    await this.connect();
    const vk = resolveVk(key);
    if (!vk) throw new Error(`未知按键: ${key}`);
    this.sendJson({
      type: MSG.INPUT_HOTKEY,
      vk,
      ctrl: Boolean(ctrl),
      alt: Boolean(alt),
      shift: Boolean(shift),
      meta: Boolean(meta),
    });
    return vk;
  }

  async getClipboard(timeoutMs = 5000) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('读取剪贴板超时')), timeoutMs);
      this.pendingClipboard.push({
        resolve: (d) => { clearTimeout(timer); resolve(d); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sendJson({ type: MSG.CLIPBOARD_GET });
    });
  }

  async setClipboard(text) {
    await this.connect();
    this.sendJson({ type: MSG.CLIPBOARD_SET, text: String(text || '') });
  }

  async fsRequest(type, extra = {}, timeoutMs = 8000) {
    await this.connect();
    const reqId = `req-${this.reqSeq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFs.delete(reqId);
        reject(new Error(`文件操作超时 (${type})`));
      }, timeoutMs);
      this.pendingFs.set(reqId, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.sendJson({ type, reqId, ...extra });
    });
  }

  async execCommand(command, { shell = 'powershell', timeoutMs = 8000 } = {}) {
    await this.connect();
    const id = `mcp-pty-${Date.now()}-${this.reqSeq++}`;
    let output = '';
    const marker = `__RD_DONE_${this.reqSeq}__`;
    return new Promise((resolve) => {
      let quietTimer = null;
      const done = () => {
        clearTimeout(hardTimer);
        clearTimeout(quietTimer);
        this.off('pty_output', onOut);
        this.off(MSG.PTY_EXIT, onExit);
        try {
          this.sendJson({ type: MSG.PTY_CLOSE, id });
        } catch {}
        resolve(output);
      };
      const onOut = (ev) => {
        if (ev.id !== id) return;
        output += ev.text;
        if (output.includes(marker)) {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(done, 150);
        }
      };
      const onExit = (ev) => {
        if (ev.id === id) done();
      };
      const hardTimer = setTimeout(done, timeoutMs);
      this.on('pty_output', onOut);
      this.on(MSG.PTY_EXIT, onExit);
      this.sendJson({ type: MSG.PTY_OPEN, id, cols: 120, rows: 30, shell });
      setTimeout(() => {
        try {
          this.sendJson({ type: MSG.PTY_INPUT, id, data: `${command}; Write-Output "${marker}"\r\n` });
        } catch {
          done();
        }
      }, 350);
    });
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.authInfo = null;
  }
}
