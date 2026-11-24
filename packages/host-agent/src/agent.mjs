import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'werift';
import {
  FRAME_KIND,
  MSG,
  PERMISSIONS,
  collectLocalAddresses,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  generateDeviceId,
  generateNonce,
  generatePairingPin,
  pickShareableEndpoints,
  verifyChallengeProof,
} from '@remote-deck/shared';
import {
  capturePhoneFrame,
  connectPhoneH264Stream,
  connectWirelessPhone,
  listConnectedPhones,
  sendPhoneInput,
} from './phone-bridge.mjs';
import { NativeBridge } from './native-bridge.mjs';
import { FileService } from './file-service.mjs';
import { QuickTunnel } from './tunnel.mjs';
import { TsnetBridge } from './tsnet-bridge.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Proxies capture calls to a worker so the main thread never parses frame
 * pipes. Enable with REMOTEDECK_WORKER_CAPTURE=1 (measured before defaulting on).
 */
class WorkerCaptureBridge {
  constructor(binaryPath) {
    this.pending = new Map();
    this.nextId = 1;
    this.failed = null;
    this.worker = null;
    this.ready = false;
    try {
      const url = new URL('./capture-worker.mjs', import.meta.url);
      this.worker = new Worker(url, { type: 'module', workerData: { binaryPath } });
      this.worker.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'ready') {
          this.ready = true;
          return;
        }
        if (msg.type === 'frame' || msg.type === 'error') {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.type === 'error') {
            entry.reject(new Error(msg.message));
            return;
          }
          const jpeg = msg.jpeg ? Buffer.from(msg.jpeg) : Buffer.alloc(0);
          entry.resolve({ meta: msg.meta, jpeg });
        }
      });
      this.worker.on('error', (err) => {
        this.failed = err;
        for (const [, entry] of this.pending) entry.reject(err);
        this.pending.clear();
      });
    } catch (err) {
      this.failed = err;
      this.worker = null;
    }
  }

  get available() {
    return Boolean(this.worker) && !this.failed;
  }

  captureFrame(req = {}) {
    if (!this.available) return Promise.reject(new Error('capture worker unavailable'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Screen capture timed out (worker)'));
      }, 5000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.worker.postMessage({ type: 'capture', id, req });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  stopVideo() {
    try {
      this.worker?.postMessage({ type: 'stopVideo' });
    } catch {}
  }

  dispose() {
    try {
      this.worker?.terminate();
    } catch {}
    this.worker = null;
  }
}

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024; // 4 MiB backpressure limit
// Dirty-rect patches cannot self-heal, so periodically resend a full frame.
// Rare on purpose: a full frame costs several normal frames' time (visible hitch).
const FULL_FRAME_REFRESH_FRAMES = 240;
// Per-frame timing trace for diagnosing pacing: set REMOTEDECK_TIMING_LOG to a
// file path and every frame appends one JSON line.
const TIMING_LOG = process.env.REMOTEDECK_TIMING_LOG || '';
let timingStream = null;
function timingLog(rec) {
  if (!TIMING_LOG) return;
  try {
    if (!timingStream) {
      timingStream = fsSync.createWriteStream(TIMING_LOG, { flags: 'a' });
    }
    timingStream.write(`${JSON.stringify(rec)}\n`);
  } catch {}
}

function wrapWsTransport(ws, channelName) {
  try {
    ws._socket?.setNoDelay?.(true);
  } catch {}
  return {
    channelName,
    isOpen: () => ws.readyState === WebSocket.OPEN,
    getBufferedAmount: () => ws.bufferedAmount || 0,
    sendText: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    sendBinary: (u8) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(u8, { binary: true });
    },
    close: (code = 1000, reason = '') => {
      try {
        ws.close(code, reason);
      } catch {}
    },
  };
}

function wrapDataChannelTransport(dc) {
  return {
    channelName: 'webrtc',
    isOpen: () => dc.readyState === 'open',
    getBufferedAmount: () => dc.bufferedAmount || 0,
    sendText: (text) => {
      if (dc.readyState === 'open') dc.send(text);
    },
    sendBinary: (u8) => {
      if (dc.readyState === 'open') dc.send(Buffer.from(u8));
    },
    close: () => {
      try {
        dc.close();
      } catch {}
    },
  };
}

export async function loadOrCreateIdentity(configPath, overrides = {}) {
  let saved = {};
  if (configPath) {
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      saved = JSON.parse(raw);
    } catch {}
  }

  const deviceId = overrides.deviceId || saved.deviceId || generateDeviceId();
  const pin = overrides.pin || saved.pin || generatePairingPin(8);
  const deviceName = overrides.deviceName || saved.deviceName || os.hostname();

  if (configPath && (!saved.deviceId || !saved.pin || overrides.persist)) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ deviceId, pin, deviceName }, null, 2),
      'utf8',
    );
  }

  return { deviceId, pin, deviceName };
}

export class HostAgent {
  constructor(options = {}) {
    this.lanPort = Number(options.lanPort ?? 9601);
    this.lanHost = options.lanHost ?? '0.0.0.0';
    this.discoveryPort = Number(options.discoveryPort ?? 9602);
    this.relayUrl = options.relayUrl || '';
    this.relaySecret = options.relaySecret || '';
    this.webDistDir = options.webDistDir ? path.resolve(options.webDistDir) : null;
    this.configPath = options.configPath || null;
    this.enableQuickTunnel = Boolean(options.quickTunnel);
    this.onStatusChange = options.onStatusChange || null;
    this.deviceId = options.deviceId || '';
    this.pin = options.pin || '';
    this.deviceName = options.deviceName || os.hostname();
    this.permissions = {
      [PERMISSIONS.VIEW]: options.permissions?.view ?? true,
      [PERMISSIONS.CONTROL]: options.permissions?.control ?? true,
      [PERMISSIONS.TERMINAL]: options.permissions?.terminal ?? true,
      [PERMISSIONS.FILES]: options.permissions?.files ?? true,
      [PERMISSIONS.AUDIO]: options.permissions?.audio ?? true,
    };
    this.requireApproval = Boolean(options.requireApproval);
    this.autoRotatePin = Boolean(options.autoRotatePin);
    this.onApproveSession = options.onApproveSession || null;
    this.privacyEnabled = false;
    this.elevated = false;
    this.clipboardWatchActive = false;
    this.videoEncoderAvailable = false;
    this.tunnelHostname = options.tunnelHostname || '';
    this.tunnelToken = options.tunnelToken || '';
    this.tsnetEnabled = Boolean(options.tsnetEnabled);
    this.tsnetAuthKey = options.tsnetAuthKey || '';
    this.tsnetStateDir = options.tsnetStateDir || (this.configPath ? path.join(path.dirname(this.configPath), 'tsnet-state') : path.join(os.tmpdir(), 'remotedeck-tsnet'));
    this.tsnet = new TsnetBridge();
    this.tsnetStatus = this.tsnet.getStatus();
    this.tsnet.on('status', (st) => {
      const prevIp = this.tsnetStatus?.tailscaleIp || '';
      this.tsnetStatus = st;
      if (st.tailscaleIp && st.tailscaleIp !== prevIp) {
        this.#sendHeartbeat();
      }
      this.#notifyStatus();
    });

    this.native = options.nativeBridge || new NativeBridge({ binaryPath: options.nativeBinaryPath });
    // Optional: capture through a worker so frame pipes never touch this thread.
    this.captureBridge = this.native;
    if (!options.nativeBridge && process.env.REMOTEDECK_WORKER_CAPTURE === '1') {
      const proxy = new WorkerCaptureBridge(options.nativeBinaryPath);
      if (proxy.available) this.captureBridge = proxy;
      else proxy.dispose();
    }
    this.files = options.fileService || new FileService({ allowedRoots: options.allowedRoots });

    this.httpServer = null;
    this.wss = null;
    this.udpSocket = null;
    this.quickTunnel = null;
    this.tunnelUrl = null;
    this.tunnelState = 'idle';
    this.tunnelError = '';
    this.relayWs = null;
    this.relayConnected = false;
    this.sessionBindSecret = '';
    this.iceServers = [];
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.displays = [];

    /** @type {Set<any>} */
    this.sessions = new Set();
    /** @type {Set<any>} */
    this.audioSessions = new Set();
    /** @type {Set<any>} */
    this.clipboardWatchers = new Set();
    /** @type {Set<any>} */
    this.videoSessions = new Set();
    /** @type {Map<string, any>} */
    this.rtcPeers = new Map(); // sessionId -> { pc, pendingCandidates }
    /** @type {Map<string, any>} */
    this.ptyOwners = new Map(); // ptyId -> session

    this.native.on('audio_frame', ({ meta, pcm }) => {
      if (this.audioSessions.size === 0 || !pcm || pcm.length === 0) return;
      const env = encodeBinaryEnvelope(FRAME_KIND.AUDIO, meta || {}, pcm);
      for (const sess of this.audioSessions) {
        if (sess.transport.isOpen() && sess.transport.getBufferedAmount() < MAX_BUFFERED_BYTES) {
          sess.transport.sendBinary(env);
        }
      }
    });

    // Audio capture failures used to be dropped on the floor, so the phone just
    // showed "no sound". Surface them, and tell subscribed clients why.
    this.native.on('audio_error', (msg) => {
      console.warn(`[remote-deck] audio capture error: ${msg?.error || 'unknown'}`);
      for (const sess of this.audioSessions) {
        sess.sendJson({ type: MSG.ERROR, code: 'audio_unavailable', error: msg?.error || 'audio capture failed' });
      }
    });

    this.native.on('json_event', (msg) => {
      if (msg?.op) console.warn(`[remote-deck] native event ${msg.op}: ${JSON.stringify(msg).slice(0, 200)}`);
    });

    this.native.on('pty_opened', ({ id, mode }) => {
      const sess = this.ptyOwners.get(id);
      if (sess) sess.sendJson({ type: MSG.PTY_OPENED, id, mode });
    });

    this.native.on('pty_output', ({ id, data }) => {
      const sess = this.ptyOwners.get(id);
      if (sess && sess.transport.isOpen()) {
        const env = encodeBinaryEnvelope(FRAME_KIND.PTY_OUT, { id }, data);
        sess.transport.sendBinary(env);
      }
    });

    this.native.on('pty_exit', ({ id, code }) => {
      const sess = this.ptyOwners.get(id);
      this.ptyOwners.delete(id);
      if (sess) {
        sess.ownedPtys.delete(id);
        sess.sendJson({ type: MSG.PTY_EXIT, id, code });
      }
    });

    this.native.on('video_packet', ({ meta, data }) => {
      if (this.videoSessions.size === 0 || !data || data.length === 0) return;
      const envelope = encodeBinaryEnvelope(FRAME_KIND.VIDEO, meta || {}, data);
      for (const sess of this.videoSessions) {
        if (sess.transport.isOpen() && sess.transport.getBufferedAmount() < MAX_BUFFERED_BYTES) {
          sess.transport.sendBinary(envelope);
        }
      }
    });

    this.native.on('clipboard_changed', ({ text, imageBase64 }) => {      if (this.clipboardWatchers.size === 0) return;
      if (!text && !imageBase64) return;
      for (const sess of this.clipboardWatchers) {
        if (sess.transport.isOpen()) {
          sess.sendJson({
            type: MSG.CLIPBOARD_DATA,
            text: text || '',
            imageBase64: imageBase64 || '',
            auto: true,
          });
        }
      }
    });
  }

  getLanEndpoints() {
    const endpoints = collectLocalAddresses(this.lanPort);
    const tsIp = this.tsnetStatus?.tailscaleIp || '';
    if (tsIp && !endpoints.some((e) => e.ip === tsIp)) {
      endpoints.push({
        iface: 'Tailscale (内嵌组网)',
        ip: tsIp,
        family: 4,
        kind: 'tailscale',
        virtual: false,
        wsUrl: `ws://${tsIp}:${this.lanPort}/ws`,
        httpUrl: `http://${tsIp}:${this.lanPort}`,
      });
    }
    return endpoints;
  }

  getHostStatus() {
    const lanEndpoints = this.getLanEndpoints();
    return {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      pin: this.pin,
      lanPort: this.lanPort,
      lanEndpoints,
      // Physical adapters only, for QR codes / "share this address" UIs.
      shareEndpoints: pickShareableEndpoints(lanEndpoints),
      tunnelUrl: this.tunnelUrl,
      tunnelState: this.tunnelState,
      tunnelError: this.tunnelError,
      tunnelNamed: Boolean(this.tunnelToken),
      tunnelHostname: this.tunnelHostname,
      quickTunnelEnabled: this.enableQuickTunnel,
      tsnet: this.tsnetStatus,
      relayUrl: this.relayUrl,
      relayConnected: this.relayConnected,
      displays: this.displays,
      permissions: { ...this.permissions },
      elevated: this.elevated,
      privacyEnabled: this.privacyEnabled,
      requireApproval: this.requireApproval,
      autoRotatePin: this.autoRotatePin,
      activeSessions: this.sessions.size,
    };
  }

  setTsnetConfig({ enabled, authKey } = {}) {
    if (typeof enabled === 'boolean') {
      this.tsnetEnabled = enabled;
    }
    if (typeof authKey === 'string') {
      this.tsnetAuthKey = authKey.trim();
    }
    if (this.tsnetEnabled && !this.stopped) {
      const safeName = String(this.deviceName || 'remotedeck')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'remotedeck';
      this.tsnet.start({
        stateDir: this.tsnetStateDir,
        hostname: `remotedeck-${safeName}`.slice(0, 48),
        authKey: this.tsnetAuthKey,
        forwardPort: this.lanPort,
      });
    } else {
      this.tsnet.stop();
    }
    this.tsnetStatus = this.tsnet.getStatus();
    this.#notifyStatus();
    return this.tsnetStatus;
  }

  logoutTsnet() {
    this.tsnetEnabled = false;
    this.tsnetAuthKey = '';
    this.tsnet.logout();
    this.tsnetStatus = this.tsnet.getStatus();
    this.#notifyStatus();
    return this.tsnetStatus;
  }

  #notifyStatus() {
    this.onStatusChange?.(this.getHostStatus());
  }

  setSecurityOptions({ requireApproval, autoRotatePin } = {}) {
    if (typeof requireApproval === 'boolean') this.requireApproval = requireApproval;
    if (typeof autoRotatePin === 'boolean') this.autoRotatePin = autoRotatePin;
    this.#notifyStatus();
    return { requireApproval: this.requireApproval, autoRotatePin: this.autoRotatePin };
  }

  async getSysInfo() {
    return await this.native.getSysInfo?.();
  }

  #syncClipboardWatch() {
    const want = !this.stopped && this.clipboardWatchers.size > 0;
    if (want === this.clipboardWatchActive) return;
    this.clipboardWatchActive = want;
    void this.native.setClipboardWatch?.(want);
  }

  async setPrivacy(enabled) {
    const next = Boolean(enabled);
    try {
      const actual = await this.native.setPrivacy?.(next);
      this.privacyEnabled = Boolean(actual);
    } catch (err) {
      this.privacyEnabled = false;
      this.#notifyStatus();
      throw err;
    }
    this.#notifyStatus();
    return this.privacyEnabled;
  }

  #syncAudioStream() {
    if (this.stopped) return;
    if (this.audioSessions.size > 0 && this.permissions.audio !== false) {
      // WAN paths (relay / P2P data channel) downgrade bitrate/rate so audio
      // never competes with video frames. Use Opus only when all subscribed
      // clients advertise Opus support.
      let lowBandwidth = true;
      let preferOpus = true;
      for (const sess of this.audioSessions) {
        const ch = sess.transport?.channelName;
        if (ch === 'lan' || ch === 'tailscale') {
          lowBandwidth = false;
        }
        if (!sess.supportsOpus) {
          preferOpus = false;
        }
      }
      this.native.startAudio?.({ lowBandwidth, preferOpus });
    } else {
      this.native.stopAudio?.();
    }
  }

  async regeneratePin() {
    this.pin = generatePairingPin(8);
    if (this.configPath) {
      await loadOrCreateIdentity(this.configPath, {
        deviceId: this.deviceId,
        pin: this.pin,
        deviceName: this.deviceName,
        persist: true,
      });
    }
    this.#notifyStatus();
    return this.pin;
  }

  setPermissions(next) {
    if (!next || typeof next !== 'object') return this.permissions;
    for (const key of Object.values(PERMISSIONS)) {
      if (typeof next[key] === 'boolean') {
        this.permissions[key] = next[key];
      }
    }
    this.#notifyStatus();
    return { ...this.permissions };
  }

  setQuickTunnel(enabled) {
    this.enableQuickTunnel = Boolean(enabled);
    if (this.enableQuickTunnel) {
      if (!this.quickTunnel) {
        this.quickTunnel = new QuickTunnel({
          localPort: this.lanPort,
          token: this.tunnelToken,
          hostname: this.tunnelHostname,
          onUrl: (url) => {
            this.tunnelUrl = url;
            this.#sendHeartbeat();
            this.#notifyStatus();
          },
          onStatus: ({ state, error }) => {
            this.tunnelState = state || 'idle';
            this.tunnelError = error || '';
            this.#notifyStatus();
          },
        });
      }
      void this.quickTunnel.start();
    } else {
      if (this.quickTunnel) {
        this.quickTunnel.stop();
        this.quickTunnel = null;
      }
      this.tunnelUrl = null;
      this.tunnelState = 'idle';
      this.tunnelError = '';
      this.#sendHeartbeat();
    }
    this.#notifyStatus();
  }

  setTunnelConfig({ token = '', hostname = '' } = {}) {
    const nextToken = String(token || '').trim();
    const nextHost = String(hostname || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const changed = nextToken !== this.tunnelToken || nextHost !== this.tunnelHostname;
    this.tunnelToken = nextToken;
    this.tunnelHostname = nextHost;
    if (changed && this.enableQuickTunnel) {
      // Restart the tunnel so the new mode/domain takes effect immediately.
      if (this.quickTunnel) {
        this.quickTunnel.stop();
        this.quickTunnel = null;
      }
      this.tunnelUrl = null;
      this.tunnelState = 'idle';
      this.setQuickTunnel(true);
    }
    this.#notifyStatus();
    return { token: this.tunnelToken, hostname: this.tunnelHostname, named: Boolean(nextToken) };
  }

  setRelayConfig({ relayUrl = '', relaySecret = '' } = {}) {
    const cleanUrl = String(relayUrl || '').trim();
    const cleanSecret = String(relaySecret || '').trim();
    if (this.relayUrl === cleanUrl && this.relaySecret === cleanSecret && this.relayWs) {
      return;
    }
    this.relayUrl = cleanUrl;
    this.relaySecret = cleanSecret;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.relayConnected = false;
    if (this.relayWs) {
      try {
        this.relayWs.close();
      } catch {}
      this.relayWs = null;
    }
    if (this.relayUrl && !this.stopped) {
      this.#connectRelay();
    }
    this.#notifyStatus();
  }

  async refreshDisplays() {
    try {
      this.displays = await this.native.getDisplays();
    } catch {
      this.displays = [{ id: 0, name: 'Primary', left: 0, top: 0, width: 1280, height: 720, primary: true }];
    }
    return this.displays;
  }

  async start() {
    this.stopped = false;
    const identity = await loadOrCreateIdentity(this.configPath, {
      deviceId: this.deviceId,
      pin: this.pin,
      deviceName: this.deviceName,
    });
    this.deviceId = identity.deviceId;
    this.pin = identity.pin;
    this.deviceName = identity.deviceName;

    await this.refreshDisplays();
    try {
      const info = await this.native.getSysInfo?.();
      this.elevated = Boolean(info?.elevated);
      this.videoEncoderAvailable = Boolean(info?.videoEncoder);
    } catch {
      this.elevated = false;
      this.videoEncoderAvailable = false;
    }
    await this.#startLanServer();
    if (this.discoveryPort > 0) {
      await this.#startUdpBeacon();
    }
    if (this.enableQuickTunnel) {
      this.setQuickTunnel(true);
    }
    if (this.tsnetEnabled) {
      this.setTsnetConfig({ enabled: true, authKey: this.tsnetAuthKey });
    }
    if (this.relayUrl) {
      this.#connectRelay();
    }

    this.#notifyStatus();
    return this.getHostStatus();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);

    for (const sess of [...this.sessions]) {
      sess.close();
    }
    this.sessions.clear();

    for (const peer of this.rtcPeers.values()) {
      try {
        peer.pc.close();
      } catch {}
    }
    this.rtcPeers.clear();

    if (this.relayWs) {
      try {
        this.relayWs.close();
      } catch {}
      this.relayWs = null;
    }

    if (this.quickTunnel) {
      this.quickTunnel.stop();
      this.quickTunnel = null;
    }

    this.tsnet.stop();

    if (this.udpSocket) {
      await new Promise((resolve) => this.udpSocket.close(() => resolve()));
      this.udpSocket = null;
    }

    if (this.wss) {
      await new Promise((resolve) => this.wss.close(() => resolve()));
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(() => resolve()));
      this.httpServer = null;
    }

    this.files.closeAllUploads();
    this.audioSessions.clear();
    this.clipboardWatchers.clear();
    this.clipboardWatchActive = false;
    this.videoSessions.clear();
    this.captureBridge.stopVideo?.();
    void this.native.setClipboardWatch?.(false);
    if (this.privacyEnabled) {
      this.privacyEnabled = false;
      await this.native.setPrivacy?.(false).catch(() => {});
    }
    this.native.stop();
  }

  async #serveStatic(req, res) {
    if (!this.webDistDir) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Web UI dist not configured' }));
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    let relPath = decodeURIComponent(url.pathname);
    if (relPath === '/') relPath = '/index.html';
    const resolved = path.resolve(this.webDistDir, `.${relPath}`);
    if (!resolved.startsWith(this.webDistDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    let filePath = resolved;
    try {
      const st = await fs.stat(filePath);
      if (st.isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch {
      if (!path.extname(relPath)) filePath = path.join(this.webDistDir, 'index.html');
      else {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }
    try {
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  async #startLanServer() {
    this.httpServer = http.createServer(async (req, res) => {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      // Same gate the phone-control POST routes use: loopback (the packaged
      // desktop window) is trusted, everything else must present the pairing
      // PIN. /api/phones/frame returns a live screenshot of the mirrored phone,
      // so leaving it open let any LAN peer — or any web page, since CORS is * —
      // grab phone frames.
      const allowPrivileged = () => {
        const remoteIp = req.socket?.remoteAddress || '';
        const isLoopback =
          remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
        if (isLoopback || !this.pin) return true;
        const headerPin = String(req.headers['x-remotedeck-pin'] || '').trim().toUpperCase();
        return headerPin === this.pin;
      };
      const forbid = () => {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
      };
      if (url.pathname === '/api/info' || url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          service: 'remote-deck-host',
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          platform: process.platform,
          permissions: this.permissions,
          displays: this.displays,
          lanEndpoints: this.getLanEndpoints(),
          tunnelUrl: this.tunnelUrl,
        }));
        return;
      }
      if (url.pathname === '/api/devices') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          service: 'remote-deck-host',
          devices: [{
            deviceId: this.deviceId,
            deviceName: this.deviceName,
            platform: process.platform,
            displays: this.displays,
            lanEndpoints: this.getLanEndpoints(),
            tunnelUrl: this.tunnelUrl,
            online: true,
          }],
        }));
        return;
      }
      if (url.pathname === '/api/lan-devices') {
        // This endpoint makes the host actively scan the LAN, so it must not be
        // usable as a free "scan my network" service by any random web page the
        // operator happens to visit: browsers can only read the reply when CORS
        // allows it, so omit that header for foreign origins. Native clients
        // (phone app, CLI, MCP) are unaffected because CORS does not apply.
        const origin = req.headers.origin;
        if (origin) {
          let sameOrigin = false;
          try {
            sameOrigin = new URL(origin).host === req.headers.host;
          } catch {}
          if (!sameOrigin) {
            res.removeHeader('access-control-allow-origin');
          }
        }
        const now = Date.now();
        if (now - (this.lastLanScanAt || 0) < 3000) {
          res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '扫描过于频繁，请稍后再试' }));
          return;
        }
        this.lastLanScanAt = now;
        const peers = await this.discoverOtherLanDevices(750);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          service: 'remote-deck-host',
          devices: peers,
        }));
        return;
      }
      if (url.pathname === '/api/phones' && req.method === 'GET') {
        if (!allowPrivileged()) { forbid(); return; }
        const devices = await listConnectedPhones();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, devices }));
        return;
      }
      if (url.pathname === '/api/phones/frame' && req.method === 'GET') {
        if (!allowPrivileged()) { forbid(); return; }
        try {
          const serial = url.searchParams.get('serial') || '';
          const frame = await capturePhoneFrame(serial);
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'cache-control': 'no-store',
            'x-phone-width': String(frame.width || 0),
            'x-phone-height': String(frame.height || 0),
          });
          res.end(frame.buffer);
        } catch (err) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err?.message || 'capture failed' }));
        }
        return;
      }
      if (url.pathname === '/api/phones/connect' && req.method === 'POST') {
        const remoteIp = req.socket?.remoteAddress || '';
        const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
        const headerPin = String(req.headers['x-remotedeck-pin'] || '').trim().toUpperCase();
        if (!isLoopback && this.pin && headerPin !== this.pin) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
          return;
        }
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }
        try {
          const result = await connectWirelessPhone(body.target || '');
          const devices = await listConnectedPhones();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ...result, devices }));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err?.message || 'wireless connect failed' }));
        }
        return;
      }
      if (url.pathname === '/api/phones/input' && req.method === 'POST') {
        const remoteIp = req.socket?.remoteAddress || '';
        const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
        const headerPin = String(req.headers['x-remotedeck-pin'] || '').trim().toUpperCase();
        if (!isLoopback && this.pin && headerPin !== this.pin) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
          return;
        }
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }
        try {
          const result = await sendPhoneInput(body.serial || '', body);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err?.message || 'phone input failed' }));
        }
        return;
      }
      await this.#serveStatic(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    this.httpServer.on('upgrade', (req, socket, head) => {
      socket.setNoDelay?.(true);
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/ws/phone-stream') {
        const remoteIp = req.socket?.remoteAddress || '';
        const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
        const qPin = String(url.searchParams.get('pin') || '').trim().toUpperCase();
        if (!isLoopback && this.pin && qPin !== this.pin) {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          void this.#attachPhoneStreamWs(ws, url.searchParams);
        });
        return;
      }
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.#attachSession(wrapWsTransport(ws, 'lan'), ws);
      });
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.lanPort, this.lanHost, () => {
        this.httpServer.off('error', reject);
        const addr = this.httpServer.address();
        if (typeof addr === 'object' && addr) this.lanPort = addr.port;
        resolve();
      });
    });
  }

  async discoverOtherLanDevices(timeoutMs = 750) {
    if (this.discoveryPort <= 0) return [];
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    try {
      await new Promise((resolve) => {
        sock.once('error', resolve);
        sock.bind(0, () => {
          try {
            sock.setBroadcast(true);
          } catch {}
          resolve();
        });
      });

      sock.on('message', (msg) => {
        try {
          const info = JSON.parse(msg.toString('utf8'));
          if (!info?.deviceId || info.deviceId === this.deviceId || found.has(info.deviceId)) return;
          found.set(info.deviceId, {
            deviceId: info.deviceId,
            deviceName: info.deviceName || info.deviceId,
            platform: info.platform || 'win32',
            displays: info.displays || [],
            lanEndpoints: info.lanEndpoints || [],
            tunnelUrl: info.tunnelUrl || null,
            online: true,
          });
        } catch {}
      });

      const targets = new Set(['255.255.255.255']);
      for (const ep of this.getLanEndpoints()) {
        if (ep.kind === 'lan' && ep.ip) {
          const parts = ep.ip.split('.');
          if (parts.length === 4) {
            targets.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
          }
        }
      }
      const probe = Buffer.from('REMOTEDECK_DISCOVER', 'utf8');
      for (const ip of targets) {
        try {
          sock.send(probe, this.discoveryPort, ip);
        } catch {}
      }
      await new Promise((r) => setTimeout(r, timeoutMs));
    } catch {
      // Ignore UDP discovery errors
    } finally {
      try {
        sock.close();
      } catch {}
    }
    return Array.from(found.values());
  }

  async #startUdpBeacon() {
    // SO_REUSEADDR keeps discovery alive when two host instances coexist
    // (boot-service watchdog + interactive app, or a restart overlap).
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udpSocket = sock;
    sock.on('error', (err) => {
      // Discovery must never block startup: log once and keep serving.
      if (this.udpBeaconWarned) return;
      this.udpBeaconWarned = true;
      console.warn(
        `[remote-deck] UDP discovery unavailable on port ${this.discoveryPort}: ${err?.message || err}`,
      );
    });
    sock.on('message', (msg, rinfo) => {
      if (msg.toString('utf8').trim() !== 'REMOTEDECK_DISCOVER') return;
      const reply = Buffer.from(JSON.stringify({
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        platform: process.platform,
        displays: this.displays,
        lanEndpoints: this.getLanEndpoints(),
        tunnelUrl: this.tunnelUrl,
      }), 'utf8');
      sock.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      sock.once('error', done);
      try {
        sock.bind(this.discoveryPort, done);
      } catch {
        done();
      }
    });
  }

  #connectRelay() {
    if (this.stopped || !this.relayUrl) return;
    const ws = new WebSocket(this.relayUrl);
    this.relayWs = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: MSG.AGENT_REGISTER,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        platform: process.platform,
        capabilities: this.permissions,
        displays: this.displays,
        lanEndpoints: this.getLanEndpoints(),
        tunnelUrl: this.tunnelUrl,
        relaySecret: this.relaySecret,
      }));
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.#sendHeartbeat(), 15000);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === MSG.AGENT_REGISTERED) {
        this.sessionBindSecret = msg.sessionBindSecret || '';
        this.iceServers = msg.iceServers || [];
        this.relayConnected = true;
        this.#notifyStatus();
        return;
      }

      if (msg.type === MSG.CONTROLLER_CONNECT && msg.sessionId) {
        this.#handleRelaySessionRequest(msg.sessionId, msg.iceServers || this.iceServers);
        return;
      }

      if (msg.type === MSG.RTC_OFFER && msg.sessionId) {
        this.#handleRtcOffer(msg.sessionId, msg.sdp);
        return;
      }

      if (msg.type === MSG.RTC_ICE && msg.sessionId) {
        this.#handleRtcIce(msg.sessionId, msg.candidate);
        return;
      }

      if (msg.type === MSG.PEER_LEFT && msg.sessionId) {
        this.#closeRtcPeer(msg.sessionId);
      }
    });

    ws.on('close', () => {
      clearInterval(this.heartbeatTimer);
      if (this.relayWs === ws) {
        this.relayConnected = false;
        this.#notifyStatus();
        if (!this.stopped && this.relayUrl) {
          this.reconnectTimer = setTimeout(() => this.#connectRelay(), 3000);
        }
      }
    });

    ws.on('error', () => {});
  }

  #sendHeartbeat() {
    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      this.relayWs.send(JSON.stringify({
        type: MSG.AGENT_HEARTBEAT,
        displays: this.displays,
        lanEndpoints: this.getLanEndpoints(),
        tunnelUrl: this.tunnelUrl,
      }));
    }
  }

  #handleRelaySessionRequest(sessionId, iceServers) {
    // 1. Open dedicated relay session data WebSocket for seamless fallback
    const u = new URL(this.relayUrl);
    u.searchParams.set('role', 'agent-session');
    u.searchParams.set('sessionId', sessionId);
    u.searchParams.set('deviceId', this.deviceId);
    u.searchParams.set('token', this.sessionBindSecret);

    const sessionWs = new WebSocket(u.toString());
    sessionWs.on('open', () => {
      this.#attachSession(wrapWsTransport(sessionWs, 'relay'), sessionWs);
    });
    sessionWs.on('error', () => {});

    // 2. Prepare WebRTC PeerConnection for P2P upgrade
    this.#prepareRtcPeer(sessionId, iceServers);
  }

  #prepareRtcPeer(sessionId, iceServers) {
    this.#closeRtcPeer(sessionId);
    try {
      const pc = new RTCPeerConnection({ iceServers });
      const entry = { pc, pendingCandidates: [] };
      this.rtcPeers.set(sessionId, entry);

      pc.onicecandidate = (ev) => {
        if (ev.candidate && this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
          this.relayWs.send(JSON.stringify({
            type: MSG.RTC_ICE,
            sessionId,
            candidate: ev.candidate,
          }));
        }
      };

      pc.ondatachannel = (ev) => {
        const dc = ev.channel;
        dc.binaryType = 'arraybuffer';
        const transport = wrapDataChannelTransport(dc);
        let attached = false;
        const attachOnce = () => {
          if (attached) return;
          attached = true;
          this.#attachDataChannelSession(transport, dc);
        };
        if (dc.readyState === 'open') {
          attachOnce();
        } else {
          dc.onopen = attachOnce;
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this.#closeRtcPeer(sessionId);
        }
      };
    } catch {
      // WebRTC unavailable; relay WS still serves the session
    }
  }

  async #handleRtcOffer(sessionId, sdp) {
    const entry = this.rtcPeers.get(sessionId);
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'offer'));
      for (const cand of entry.pendingCandidates) {
        await entry.pc.addIceCandidate(new RTCIceCandidate(cand));
      }
      entry.pendingCandidates = [];
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
        this.relayWs.send(JSON.stringify({
          type: MSG.RTC_ANSWER,
          sessionId,
          sdp: entry.pc.localDescription?.sdp || answer.sdp,
        }));
      }
    } catch {}
  }

  async #handleRtcIce(sessionId, candidate) {
    const entry = this.rtcPeers.get(sessionId);
    if (!entry || !candidate) return;
    try {
      if (entry.pc.remoteDescription) {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        entry.pendingCandidates.push(candidate);
      }
    } catch {}
  }

  #closeRtcPeer(sessionId) {
    const entry = this.rtcPeers.get(sessionId);
    if (!entry) return;
    this.rtcPeers.delete(sessionId);
    try {
      entry.pc.close();
    } catch {}
  }

  #attachSession(transport, ws) {
    const session = this.#createSessionController(transport);
    ws.on('message', (data, isBinary) => {
      session.handleIncoming(data, isBinary);
    });
    ws.on('close', () => session.dispose());
    ws.on('error', () => session.dispose());
    session.start();
  }

  #attachDataChannelSession(transport, dc) {
    const session = this.#createSessionController(transport);
    dc.onmessage = (ev) => {
      const raw = ev.data;
      if (typeof raw === 'string') {
        session.handleIncoming(raw, false);
      } else {
        session.handleIncoming(raw, true);
      }
    };
    dc.onclose = () => session.dispose();
    dc.onerror = () => session.dispose();
    session.start();
  }

  #createSessionController(transport) {
    const nonce = generateNonce();
    let authenticated = false;
    let awaitingApproval = false;
    let failedAttempts = 0;
    let streaming = false;
    let streamTimer = null;
    let capturing = false;
    let frameSeq = 0;
    let lastHash = '';
    let framesSinceFullFrame = 0;
    let clientRttMs = 30;
    let abrLevel = 0; // 0 (best) -> 3 (lowest)
    let abrStableTicks = 0;
    let abrCongestTicks = 0;
    let forceKeyPending = false;
    let h264Congested = false;
    let lastCursorShapeId = 0;
    let lastCursorSentX = -1;
    let lastCursorSentY = -1;
    const streamConfig = {
      displayId: 0,
      fps: 18,
      scale: 0.75,
      quality: 70,
      auto: false,
      allowDirty: false,
      hiRes: false, // client zoomed in -> always capture at native resolution
      maxWidth: 0,
      singleFrame: false,
      separateCursor: false,
      roi: null, // {x,y,w,h} normalized: only stream the visible region
      codec: 'jpeg', // 'jpeg' (默认) | 'h264'（需要宿主 ffmpeg）
    };
    const ownedPtys = new Set();

    const session = {
      transport,
      ownedPtys,
      isAuthenticated: () => authenticated,
      sendJson: (obj) => {
        transport.sendText(JSON.stringify(obj));
      },
      start: () => {
        this.sessions.add(session);
        this.#notifyStatus();
        session.sendJson({
          type: MSG.AUTH_CHALLENGE,
          nonce,
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          platform: process.platform,
          permissions: this.permissions,
          displays: this.displays,
          channel: transport.channelName,
          elevated: this.elevated,
        });
      },
      close: () => {
        transport.close(1000, 'session closed');
        session.dispose();
      },
      dispose: () => {
        streaming = false;
        clearTimeout(streamTimer);
        session.phoneStream?.close();
        session.phoneStream = null;
        if (!this.sessions.has(session)) return;
        const wasAuthed = authenticated;
        this.sessions.delete(session);
        this.audioSessions.delete(session);
        this.clipboardWatchers.delete(session);
        this.videoSessions.delete(session);
        if (this.videoSessions.size === 0) this.captureBridge.stopVideo?.();
        this.#syncClipboardWatch();
        this.#syncAudioStream();
        for (const ptyId of ownedPtys) {
          this.ptyOwners.delete(ptyId);
          this.native.closePty(ptyId);
        }
        ownedPtys.clear();

        let remainingAuthed = 0;
        for (const s of this.sessions) {
          if (s.isAuthenticated?.()) remainingAuthed += 1;
        }
        if (remainingAuthed === 0) {
          if (this.privacyEnabled) {
            this.setPrivacy(false).catch(() => {});
          }
          if (wasAuthed && this.autoRotatePin) {
            void this.regeneratePin();
          }
        }
        this.#notifyStatus();
      },
      handleIncoming: async (data, isBinary) => {
        if (isBinary) {
          if (!authenticated) return;
          if (!this.permissions.files) return;
          try {
            const env = decodeBinaryEnvelope(data);
            if (env.kind === FRAME_KIND.FILE_UP) {
              const { transferId, done } = env.meta || {};
              if (!transferId) return;
              if (env.payload.byteLength > 0) {
                await this.files.appendUploadChunk(transferId, env.payload);
              }
              if (done) {
                // Always answer with a correlated upload_done so the client can
                // tell success from a remote write failure (disk full, perms).
                try {
                  const res = await this.files.finishUpload(transferId);
                  session.sendJson({ type: MSG.FS_RESULT, op: 'upload_done', transferId, ok: true, ...res });
                } catch (err) {
                  session.sendJson({
                    type: MSG.FS_RESULT,
                    op: 'upload_done',
                    transferId,
                    ok: false,
                    error: err?.message || 'finish failed',
                  });
                }
              }
            }
          } catch (err) {
            session.sendJson({ type: MSG.FS_ERROR, error: err.message });
          }
          return;
        }

        let msg;
        try {
          msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
        } catch {
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === MSG.PING) {
          if (typeof msg.rttMs === 'number' && msg.rttMs > 0) {
            clientRttMs = msg.rttMs;
          }
          session.sendJson({ type: MSG.PONG, ts: msg.ts, serverTs: Date.now() });
          return;
        }

        if (!authenticated) {
          if (msg.type === MSG.AUTH_RESPONSE) {
            if (awaitingApproval) return;
            if (verifyChallengeProof(this.pin, nonce, this.deviceId, msg.proof)) {
              if (this.requireApproval && typeof this.onApproveSession === 'function') {
                awaitingApproval = true;
                session.sendJson({ type: MSG.AUTH_PENDING, message: '等待被控端确认允许连接...' });
                let allowed = false;
                try {
                  allowed = await this.onApproveSession({
                    channel: transport.channelName,
                    deviceId: this.deviceId,
                  });
                } catch {
                  allowed = false;
                }
                awaitingApproval = false;
                if (!transport.isOpen()) return;
                if (!allowed) {
                  session.sendJson({ type: MSG.AUTH_ERROR, error: '被控端已拒绝此次远程连接' });
                  session.close();
                  return;
                }
              }
              authenticated = true;
              const displays = await this.refreshDisplays();
              session.sendJson({
                type: MSG.AUTH_OK,
                deviceId: this.deviceId,
                deviceName: this.deviceName,
                platform: process.platform,
                permissions: this.permissions,
                displays,
                channel: transport.channelName,
                elevated: this.elevated,
                privacyEnabled: this.privacyEnabled,
                videoEncoder: this.videoEncoderAvailable,
                lanEndpoints: this.getLanEndpoints(),
                tunnelUrl: this.tunnelUrl || '',
              });
            } else {
              failedAttempts += 1;
              session.sendJson({
                type: MSG.AUTH_ERROR,
                error: '配对码校验失败，请检查设备 ID 与访问码',
                attemptsRemaining: Math.max(0, 5 - failedAttempts),
              });
              if (failedAttempts >= 5) {
                session.close();
              }
            }
          } else {
            session.sendJson({ type: MSG.AUTH_ERROR, error: 'Authentication required' });
          }
          return;
        }

        // Authenticated handlers
        await handleAuthedMessage(msg);
      },
    };

    const applyCodec = (next) => {
      const normalized = next === 'h264' ? 'h264' : 'jpeg';
      if (normalized === streamConfig.codec) return;
      streamConfig.codec = normalized;
      lastHash = '';
      if (normalized === 'h264') {
        this.videoSessions.add(session);
      } else {
        this.videoSessions.delete(session);
        if (this.videoSessions.size === 0) this.captureBridge.stopVideo?.();
      }
      session.sendJson({ type: MSG.SCREEN_CONFIG, codec: streamConfig.codec });
    };

    const getEffectiveStreamParams = () => {
      const clientMaxW = streamConfig.maxWidth > 0 ? streamConfig.maxWidth : 0;
      const tiers = streamConfig.codec === 'h264'
        ? [
            { fps: 30, scale: 1.0, quality: 84, maxWidth: 2240 },
            { fps: 26, scale: 0.85, quality: 78, maxWidth: 1920 },
            { fps: 20, scale: 0.72, quality: 70, maxWidth: 1440 },
            { fps: 14, scale: 0.55, quality: 62, maxWidth: 1280 },
          ]
        : [
            { fps: 30, scale: 0.85, quality: 80, maxWidth: 1920 },
            { fps: 24, scale: 0.75, quality: 74, maxWidth: 1600 },
            { fps: 18, scale: 0.62, quality: 66, maxWidth: 1280 },
            { fps: 12, scale: 0.48, quality: 58, maxWidth: 1024 },
          ];
      const base = streamConfig.auto
        ? tiers[Math.max(0, Math.min(3, abrLevel))]
        : { fps: streamConfig.fps, scale: streamConfig.scale, quality: streamConfig.quality, maxWidth: clientMaxW };
      if (streamConfig.hiRes) {
        // Client is zoomed in: full resolution beats bandwidth savings.
        return { fps: Math.min(24, base.fps), scale: 1.0, quality: Math.max(92, base.quality), maxWidth: 0 };
      }
      const effMaxW = clientMaxW > 0 && base.maxWidth > 0
        ? Math.min(clientMaxW, base.maxWidth)
        : (clientMaxW || base.maxWidth || 0);
      return { fps: base.fps, scale: base.scale, quality: base.quality, maxWidth: effMaxW };
    };

    // Absolute-deadline pacing: the deadline advances by exactly one interval and
    // the sleep is measured against "now" only. (Subtracting the capture time a
    // second time made every frame wait a full extra interval: ~23 fps cap.)
    let nextDeadline = 0;
    let schedAt = 0;
    let schedDelay = 0;
    let timerLagEma = 0; // Electron's main loop fires timers late; compensate for it
    let captureEma = 16; // measured capture cost, used to keep sleeps deterministic
    // A worker-owned timer keeps the cadence stable; the main thread's I/O no
    // longer delays ticks. Falls back to setTimeout if the worker cannot start.
    let pacer = null;
    const pacerInterval = () => {
      const eff = getEffectiveStreamParams();
      return Math.max(20, Math.round(1000 / Math.max(1, Math.min(30, eff.fps))));
    };
    const startPacer = () => {
      return; // worker pacer measured slower: main-loop message delivery still queues
      if (pacer) return;
      try {
        const url = new URL('./pacer-worker.mjs', import.meta.url);
        pacer = new Worker(url, { type: 'module' });
        pacer.on('message', (msg) => {
          if (!msg || msg.type !== 'tick') return;
          void (async () => {
            try {
              if (streaming && !capturing) await captureAndPush();
            } finally {
              try {
                pacer?.postMessage({ type: 'ack' });
              } catch {}
            }
          })();
        });
        pacer.on('error', () => {
          pacer = null;
        });
        pacer.postMessage({ type: 'start', intervalMs: pacerInterval() });
      } catch {
        pacer = null;
      }
    };
    const stopPacer = () => {
      if (!pacer) return;
      try {
        pacer.postMessage({ type: 'stop' });
        pacer.terminate();
      } catch {}
      pacer = null;
    };
    const scheduleNextFrame = () => {
      if (!streaming || !transport.isOpen()) return;
      const eff = getEffectiveStreamParams();
      const nominal = Math.max(20, Math.round(1000 / Math.max(1, Math.min(30, eff.fps))));
      // Leave at least ~10ms of sleep so timers stay on schedule instead of
      // firing back-to-back: a *steady* cadence feels much smoother than a
      // faster but jittery one.
      const targetInterval = Math.max(nominal, Math.round(captureEma + 10));
      const now = Date.now();
      if (!nextDeadline || nextDeadline < now - targetInterval) {
        nextDeadline = now + targetInterval;
      } else {
        nextDeadline += targetInterval;
      }
      if (pacer) {
        pacer.postMessage({ type: 'interval', intervalMs: targetInterval });
        schedAt = 0;
        return;
      }
      // Native pacing owns the clock; come straight back to ask for the next
      // frame. setImmediate keeps us off the timer queue entirely.
      schedAt = 0;
      schedDelay = 0;
      streamTimer = setImmediate(captureAndPush);
    };

    const captureAndPush = async () => {
      const wakeAt = Date.now();
      const wakeLag = schedAt ? wakeAt - schedAt - schedDelay : -1;
      if (!streaming || !transport.isOpen()) return;
      if (schedAt) {
        const lag = Date.now() - schedAt - schedDelay;
        timerLagEma = timerLagEma * 0.75 + Math.max(-5, Math.min(40, lag)) * 0.25;
        schedAt = 0;
      }
      if (capturing) {
        scheduleNextFrame();
        return;
      }
      const buffered = transport.getBufferedAmount();
      if (streamConfig.codec === 'h264') {
        if (buffered > 524288) {
          h264Congested = true;
          scheduleNextFrame();
          return;
        }
        if (h264Congested && buffered < 131072) {
          h264Congested = false;
          forceKeyPending = true;
        }
      }
      if (buffered > MAX_BUFFERED_BYTES) {
        if (streamConfig.auto && abrLevel < 3) {
          abrLevel += 1;
          abrStableTicks = 0;
          lastHash = '';
        }
        scheduleNextFrame();
        return;
      }

      if (streamConfig.auto) {
        if (buffered > 1572864 || clientRttMs > 300) {
          abrCongestTicks = (typeof abrCongestTicks === 'number' ? abrCongestTicks : 0) + 1;
          if ((abrCongestTicks >= 2 || buffered > 2621440) && abrLevel < 3) {
            abrLevel += 1;
            abrCongestTicks = 0;
          }
          abrStableTicks = 0;
        } else if (buffered < 131072 && clientRttMs < 120) {
          abrCongestTicks = 0;
          abrStableTicks += 1;
          if (abrStableTicks >= 18 && abrLevel > 0) {
            abrLevel -= 1;
            abrStableTicks = 0;
          }
        } else {
          abrCongestTicks = 0;
          abrStableTicks = Math.max(0, abrStableTicks - 1);
        }
      }

      capturing = true;
      const startedAt = Date.now();
      try {
        frameSeq += 1;
        const eff = getEffectiveStreamParams();
        const captureScale = eff.scale;
        const capStart = Date.now();
        const sendForceKey = forceKeyPending;
        forceKeyPending = false;
        const { meta, jpeg } = await this.captureBridge.captureFrame({
          displayId: streamConfig.displayId,
          scale: captureScale,
          maxWidth: eff.maxWidth || 0,
          singleFrame: Boolean(streamConfig.singleFrame),
          separateCursor: Boolean(streamConfig.separateCursor),
          cursorShapeId: lastCursorShapeId,
          quality: eff.quality,
          lastHash,
          seq: frameSeq,
          allowDirty: Boolean(streamConfig.allowDirty),
          forceKey: sendForceKey,
          video: streamConfig.codec === 'h264',
          fps: eff.fps,
          // Let the native side own the pacing; this loop just asks for frames.
          paceMs: Math.max(0, Math.round(1000 / Math.max(1, Math.min(30, eff.fps)))),
          roiX: streamConfig.roi ? streamConfig.roi.x : 0,
          roiY: streamConfig.roi ? streamConfig.roi.y : 0,
          roiW: streamConfig.roi ? streamConfig.roi.w : 0,
          roiH: streamConfig.roi ? streamConfig.roi.h : 0,
        });
        lastHash = meta.hash || '';
        if (meta.cursorShape && meta.cursorShape.id) {
          lastCursorShapeId = meta.cursorShape.id;
        }
        const cursorMoved =
          Math.abs((meta.cursorX ?? 0) - lastCursorSentX) > 0.001 ||
          Math.abs((meta.cursorY ?? 0) - lastCursorSentY) > 0.001;
        if (meta.video) {
          // Geometry / cursor heartbeat only; pixels arrive as VIDEO packets.
          if (transport.isOpen() && (!meta.unchanged || meta.cursorShape || cursorMoved || frameSeq % 15 === 0)) {
            lastCursorSentX = meta.cursorX ?? 0.5;
            lastCursorSentY = meta.cursorY ?? 0.5;
            transport.sendBinary(encodeBinaryEnvelope(FRAME_KIND.SCREEN, {
              displayId: meta.displayId,
              width: meta.width,
              height: meta.height,
              nativeWidth: meta.nativeWidth,
              nativeHeight: meta.nativeHeight,
              seq: meta.seq,
              cursorX: meta.cursorX,
              cursorY: meta.cursorY,
              cursorShape: meta.cursorShape || undefined,
              ts: Date.now(),
              video: true,
            }, new Uint8Array(0)));
          }
        } else if (meta.unchanged) {
          if (streamConfig.separateCursor && transport.isOpen() && (meta.cursorShape || cursorMoved)) {
            lastCursorSentX = meta.cursorX ?? 0.5;
            lastCursorSentY = meta.cursorY ?? 0.5;
            transport.sendBinary(encodeBinaryEnvelope(FRAME_KIND.SCREEN, {
              displayId: meta.displayId,
              width: meta.width,
              height: meta.height,
              nativeWidth: meta.nativeWidth,
              nativeHeight: meta.nativeHeight,
              seq: meta.seq,
              cursorX: meta.cursorX,
              cursorY: meta.cursorY,
              cursorShape: meta.cursorShape || undefined,
              ts: Date.now(),
              unchanged: true,
            }, new Uint8Array(0)));
          }
        } else if (!meta.unchanged && jpeg && jpeg.length > 0 && transport.isOpen()) {
          // Dirty-rect patches never self-heal: one dropped patch leaves stale
          // pixels on screen (looks like two windows overlapping). Force a full
          // frame periodically and whenever the transport is under pressure.
          framesSinceFullFrame += 1;
          if (framesSinceFullFrame >= FULL_FRAME_REFRESH_FRAMES || buffered > MAX_BUFFERED_BYTES * 0.6) {
            framesSinceFullFrame = 0;
            lastHash = ''; // next capture is a full frame -> heals any stale patch
          }
          const frameMeta = {
            displayId: meta.displayId,
            width: meta.width,
            height: meta.height,
            nativeWidth: meta.nativeWidth,
            nativeHeight: meta.nativeHeight,
            seq: meta.seq,
            cursorX: meta.cursorX,
            cursorY: meta.cursorY,
            cursorShape: meta.cursorShape || undefined,
            ts: Date.now(),
            t: meta.t,
            fullWidth: meta.fullWidth,
            fullHeight: meta.fullHeight,
            roi: meta.roi,
            echo: lastPointerEcho && Date.now() - lastPointerEcho.ts < 4000 ? lastPointerEcho : undefined,
            tw: Date.now() - capStart,
            bt: meta.bt,
            gdi: meta.gdi,
            lvl: abrLevel,
            ef: eff.fps,
            es: eff.scale,
          };
          if (meta.dirty) {
            frameMeta.dirty = meta.dirty;
          }
          const capCost = Date.now() - capStart;
          captureEma = captureEma * 0.85 + capCost * 0.15;
          const encAt = Date.now();
          const envelope = encodeBinaryEnvelope(FRAME_KIND.SCREEN, frameMeta, jpeg);
          transport.sendBinary(envelope);
          const sentAt = Date.now();
          timingLog({
            wakeLag,
            capture: encAt - capStart,
            encode: sentAt - encAt,
            native: meta.t,
            bytes: jpeg.length,
            total: sentAt - wakeAt,
            dirty: meta.dirty ? 1 : 0,
          });
        }
      } catch (err) {
        // H.264 unavailable (e.g. ffmpeg missing) -> fall back to JPEG silently.
        if (streamConfig.codec === 'h264') {
          streamConfig.codec = 'jpeg';
          this.videoSessions.delete(session);
          if (this.videoSessions.size === 0) this.captureBridge.stopVideo?.();
          lastHash = '';
          session.sendJson({
            type: MSG.SCREEN_CONFIG,
            codec: 'jpeg',
            videoError: err?.message || 'h264 unavailable',
          });
        }
        // Keep streaming loop alive on transient frame grab error
      } finally {
        capturing = false;
        scheduleNextFrame();
      }
    };

    let lastPointerEcho = null;
    const handleAuthedMessage = async (msg) => {
      switch (msg.type) {
        case MSG.SCREEN_DISPLAYS: {
          const displays = await this.refreshDisplays();
          session.sendJson({ type: MSG.DISPLAYS_INFO, displays });
          return;
        }
        case MSG.SCREEN_START: {
          if (!this.permissions.view) return;
          if (typeof msg.displayId === 'number') streamConfig.displayId = msg.displayId;
          if (typeof msg.fps === 'number') streamConfig.fps = msg.fps;
          if (typeof msg.scale === 'number') streamConfig.scale = msg.scale;
          if (typeof msg.quality === 'number') streamConfig.quality = msg.quality;
          if (typeof msg.auto === 'boolean') streamConfig.auto = msg.auto;
          if (typeof msg.allowDirty === 'boolean') streamConfig.allowDirty = msg.allowDirty;
          if (typeof msg.codec === 'string') applyCodec(msg.codec);
          streamConfig.hiRes = Boolean(msg.hiRes);
          streamConfig.maxWidth = Number.isFinite(msg.maxWidth) ? Math.max(0, Math.min(3840, Math.round(msg.maxWidth))) : 0;
          streamConfig.singleFrame = Boolean(msg.singleFrame);
          streamConfig.separateCursor = Boolean(msg.separateCursor);
          lastCursorShapeId = 0;
          abrLevel = 0;
          abrStableTicks = 0;
          abrCongestTicks = 0;
          lastHash = '';
          if (!streaming) {
            streaming = true;
          startPacer();
            captureAndPush();
          }
          return;
        }
        case MSG.SCREEN_CONFIG: {
          if (typeof msg.displayId === 'number') {
            streamConfig.displayId = msg.displayId;
            lastHash = '';
          }
          if (typeof msg.fps === 'number') streamConfig.fps = msg.fps;
          if (typeof msg.scale === 'number') {
            streamConfig.scale = msg.scale;
            lastHash = '';
          }
          if (typeof msg.quality === 'number') {
            streamConfig.quality = msg.quality;
            lastHash = '';
          }
          if (typeof msg.auto === 'boolean') {
            streamConfig.auto = msg.auto;
            abrLevel = 0;
            abrStableTicks = 0;
            lastHash = '';
          }
          if (typeof msg.allowDirty === 'boolean') {
            streamConfig.allowDirty = msg.allowDirty;
            lastHash = '';
          }
          if (typeof msg.codec === 'string') applyCodec(msg.codec);
          if (msg.roi && typeof msg.roi.x === 'number') {
            streamConfig.roi = { x: msg.roi.x, y: msg.roi.y, w: msg.roi.w, h: msg.roi.h };
            lastHash = '';
            forceKeyPending = true;
          } else if (msg.roi === null && streamConfig.roi !== null) {
            streamConfig.roi = null;
            lastHash = '';
            forceKeyPending = true;
          }
          if (msg.forceKey === true) {
            forceKeyPending = true;
            lastHash = '';
          }
          if (typeof msg.hiRes === 'boolean' && msg.hiRes !== streamConfig.hiRes) {
            streamConfig.hiRes = msg.hiRes;
            lastHash = '';
          }
          if (Number.isFinite(msg.maxWidth)) {
            streamConfig.maxWidth = Math.max(0, Math.min(3840, Math.round(msg.maxWidth)));
          }
          if (typeof msg.singleFrame === 'boolean') {
            streamConfig.singleFrame = msg.singleFrame;
          }
          if (typeof msg.separateCursor === 'boolean' && msg.separateCursor !== streamConfig.separateCursor) {
            streamConfig.separateCursor = msg.separateCursor;
            lastCursorShapeId = 0;
            lastHash = '';
          }
          return;
        }
        case MSG.SCREEN_STOP: {
          stopPacer();
          streaming = false;
          clearTimeout(streamTimer);
          this.videoSessions.delete(session);
          if (this.videoSessions.size === 0) this.captureBridge.stopVideo?.();
          return;
        }
        case MSG.AUDIO_START: {
          if (this.permissions.audio === false) return;
          session.supportsOpus = msg.codec === 'opus' || Boolean(msg.opus);
          this.audioSessions.add(session);
          this.#syncAudioStream();
          return;
        }
        case MSG.AUDIO_STOP: {
          this.audioSessions.delete(session);
          this.#syncAudioStream();
          return;
        }
        case MSG.PRIVACY_SET: {
          if (!this.permissions.control) return;
          await this.setPrivacy(Boolean(msg.enabled)).catch(() => {});
          return;
        }

        // Input injection
        case MSG.INPUT_MOUSE: {
          if (typeof msg.x === 'number' && typeof msg.y === 'number') {
            lastPointerEcho = { x: msg.x, y: msg.y, action: msg.action, ts: Date.now() };
          }
          if (!this.permissions.control) return;
          this.native.injectMouse({
            action: msg.action,
            x: msg.x ?? -1,
            y: msg.y ?? -1,
            dx: msg.dx ?? 0,
            dy: msg.dy ?? 0,
            button: msg.button || 'left',
            deltaY: msg.deltaY ?? msg.delta ?? 0,
            displayId: msg.displayId ?? streamConfig.displayId,
          });
          return;
        }
        case MSG.INPUT_KEY: {
          if (!this.permissions.control) return;
          this.native.injectKey({
            action: msg.action || 'tap',
            vk: Number(msg.vk || 0),
            code: msg.code || '',
            mods: msg.mods || {
              ctrl: Boolean(msg.ctrl),
              alt: Boolean(msg.alt),
              shift: Boolean(msg.shift),
              meta: Boolean(msg.meta),
            },
          });
          return;
        }
        case MSG.INPUT_TEXT: {
          if (!this.permissions.control) return;
          this.native.injectText(msg.text || '');
          return;
        }
        case MSG.INPUT_HOTKEY: {
          if (!this.permissions.control) return;
          this.native.injectKey({
            action: 'tap',
            vk: Number(msg.vk || 0),
            mods: msg.mods || {
              ctrl: Boolean(msg.ctrl),
              alt: Boolean(msg.alt),
              shift: Boolean(msg.shift),
              meta: Boolean(msg.meta),
            },
          });
          return;
        }

        // Clipboard
        case MSG.CLIPBOARD_GET: {
          if (!this.permissions.control) return;
          try {
            const res = await this.native.getClipboard();
            session.sendJson({
              type: MSG.CLIPBOARD_DATA,
              text: res?.text || '',
              imageBase64: res?.imageBase64 || '',
            });
          } catch (err) {
            session.sendJson({ type: MSG.CLIPBOARD_DATA, text: '', error: err.message });
          }
          return;
        }
        case MSG.CLIPBOARD_SET: {
          if (!this.permissions.control) return;
          if (msg.imageBase64) {
            await this.native.setClipboardImage?.(msg.imageBase64).catch(() => {});
          } else {
            await this.native.setClipboard(msg.text || '').catch(() => {});
          }
          return;
        }
        case MSG.CLIPBOARD_WATCH: {
          if (!this.permissions.control) return;
          if (msg.enabled) {
            this.clipboardWatchers.add(session);
          } else {
            this.clipboardWatchers.delete(session);
          }
          this.#syncClipboardWatch();
          session.sendJson({
            type: MSG.CLIPBOARD_DATA,
            watch: true,
            enabled: this.clipboardWatchers.has(session),
          });
          return;
        }

        // Terminal
        case MSG.PTY_OPEN: {
          if (!this.permissions.terminal || !msg.id) return;
          ownedPtys.add(msg.id);
          this.ptyOwners.set(msg.id, session);
          this.native.openPty({
            id: msg.id,
            cols: msg.cols || 100,
            rows: msg.rows || 30,
            shell: msg.shell || 'powershell',
            cwd: msg.cwd || '',
          });
          return;
        }
        case MSG.PTY_INPUT: {
          if (!this.permissions.terminal || !msg.id || !ownedPtys.has(msg.id)) return;
          this.native.writePty(msg.id, msg.data || '');
          return;
        }
        case MSG.PTY_RESIZE: {
          if (!this.permissions.terminal || !msg.id || !ownedPtys.has(msg.id)) return;
          this.native.resizePty(msg.id, msg.cols || 100, msg.rows || 30);
          return;
        }
        case MSG.PTY_CLOSE: {
          if (!msg.id || !ownedPtys.has(msg.id)) return;
          ownedPtys.delete(msg.id);
          this.ptyOwners.delete(msg.id);
          this.native.closePty(msg.id);
          return;
        }

        // Filesystem
        case MSG.FS_ROOTS:
        case MSG.FS_LIST:
        case MSG.FS_MKDIR:
        case MSG.FS_RENAME:
        case MSG.FS_DELETE:
        case MSG.FS_READ_TEXT:
        case MSG.FS_WRITE_TEXT:
        case MSG.FS_DOWNLOAD:
        case MSG.FS_ZIP_DOWNLOAD:
        case MSG.FS_UPLOAD_START:
        case MSG.FS_UPLOAD_END: {
          if (!this.permissions.files) {
            session.sendJson({ type: MSG.FS_ERROR, reqId: msg.reqId, error: 'File access disabled by host' });
            return;
          }
          try {
            if (msg.type === MSG.FS_ROOTS) {
              const roots = await this.files.listRoots();
              session.sendJson({ type: MSG.FS_RESULT, reqId: msg.reqId, op: 'roots', roots });
            } else if (msg.type === MSG.FS_LIST) {
              const listing = await this.files.listDir(msg.path);
              session.sendJson({ type: MSG.FS_RESULT, reqId: msg.reqId, op: 'list', ...listing });
            } else if (msg.type === MSG.FS_MKDIR) {
              const res = await this.files.mkdir(msg.path);
              session.sendJson({ type: MSG.FS_RESULT, reqId: msg.reqId, op: 'mkdir', ...res });
            } else if (msg.type === MSG.FS_RENAME) {
              const res = await this.files.rename(msg.oldPath, msg.newPath);
              session.sendJson({ type: MSG.FS_RESULT, reqId: msg.reqId, op: 'rename', ...res });
            } else if (msg.type === MSG.FS_DELETE) {
              const res = await this.files.remove(msg.path);
              session.sendJson({ type: MSG.FS_RESULT, reqId: msg.reqId, op: 'delete', ...res });
            } else if (msg.type === MSG.FS_READ_TEXT) {
              const res = await this.files.readText(msg.path);
              session.sendJson({ type: MSG.FS_RESULT, reqId: msg.reqId, op: 'read_text', ...res });
            } else if (msg.type === MSG.FS_WRITE_TEXT) {
              const res = await this.files.writeText(msg.path, msg.content);
              session.sendJson({ type: MSG.FS_RESULT, reqId: msg.reqId, op: 'write_text', ...res });
            } else if (msg.type === MSG.FS_DOWNLOAD) {
              const transferId = msg.transferId || `dl-${Date.now()}`;
              await this.files.streamDownload(msg.path, transferId, (meta, chunk) => {
                if (!transport.isOpen()) return;
                transport.sendBinary(encodeBinaryEnvelope(FRAME_KIND.FILE_DOWN, meta, chunk));
              });
            } else if (msg.type === MSG.FS_ZIP_DOWNLOAD) {
              const transferId = msg.transferId || `zip-${Date.now()}`;
              await this.files.streamZip(msg.paths || [msg.path], transferId, (meta, chunk) => {
                if (!transport.isOpen()) return;
                transport.sendBinary(encodeBinaryEnvelope(FRAME_KIND.FILE_DOWN, meta, chunk));
              });
            } else if (msg.type === MSG.FS_UPLOAD_START) {
              const res = await this.files.startUpload({
                transferId: msg.transferId,
                dirPath: msg.dirPath,
                fileName: msg.fileName,
                total: msg.total || 0,
                offset: msg.offset || 0,
              });
              // The client correlates on transferId (it sends no reqId here) and
              // needs the resume offset back, otherwise it stalls waiting for an
              // ack that never matches and re-sends bytes from 0.
              session.sendJson({
                type: MSG.FS_RESULT,
                reqId: msg.reqId,
                op: 'upload_ack',
                transferId: msg.transferId,
                ok: true,
                offset: res.offset || 0,
                path: res.path,
              });
            } else if (msg.type === MSG.FS_UPLOAD_END) {
              const res = await this.files.finishUpload(msg.transferId);
              session.sendJson({ type: MSG.FS_RESULT, reqId: msg.reqId, op: 'upload_done', transferId: msg.transferId, ...res });
            }
          } catch (err) {
            session.sendJson({ type: MSG.FS_ERROR, reqId: msg.reqId, error: err.message });
          }
          return;
        }

        // Remote Phone Mirroring Proxy
        case MSG.PHONE_LIST: {
          if (!this.permissions.view) return;
          try {
            const devices = await listConnectedPhones();
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'list', ok: true, devices });
          } catch (err) {
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'list', ok: false, error: err.message });
          }
          return;
        }
        case MSG.PHONE_CONNECT: {
          if (!this.permissions.control) return;
          try {
            const res = await connectWirelessPhone(msg.target || '');
            const devices = await listConnectedPhones();
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'connect', ...res, devices });
          } catch (err) {
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'connect', ok: false, error: err.message });
          }
          return;
        }
        case MSG.PHONE_FRAME: {
          if (!this.permissions.view) return;
          try {
            const frame = await capturePhoneFrame(msg.serial || '');
            session.sendJson({
              type: MSG.PHONE_RESULT,
              reqId: msg.reqId,
              op: 'frame',
              ok: true,
              width: frame.width,
              height: frame.height,
              jpegBase64: frame.buffer.toString('base64'),
            });
          } catch (err) {
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'frame', ok: false, error: err.message });
          }
          return;
        }
        case MSG.PHONE_INPUT: {
          if (!this.permissions.control) return;
          try {
            const res = await sendPhoneInput(msg.serial || '', msg);
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'input', ...res });
          } catch (err) {
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'input', ok: false, error: err.message });
          }
          return;
        }
        case MSG.PHONE_STREAM_STOP: {
          session.phoneStream?.close();
          session.phoneStream = null;
          return;
        }
        case MSG.PHONE_STREAM_START: {
          if (!this.permissions.view) return;
          session.phoneStream?.close();
          session.phoneStream = null;
          try {
            let host = String(msg.host || '').trim();
            let port = Number(msg.port) || 9603;
            const hp = host.match(/^\[?([^\]]+)\]?:(\d+)$/);
            const rawIp = hp ? hp[1] : host;
            const rawPort = hp ? Number(hp[2]) || port : port;
            const isTsV4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(rawIp);
            if (isTsV4 && this.tsnet?.getStatus?.().enabled) {
              try {
                port = await this.tsnet.openTunnel(rawIp, rawPort);
                host = '127.0.0.1';
              } catch {}
            }
            const handle = await connectPhoneH264Stream({
              serial: msg.serial || '',
              host,
              port,
              onPacket: (pkt) => {
                if (!transport.isOpen() || session.phoneStream !== handle) return;
                if (pkt.audio) {
                  if (transport.getBufferedAmount() > MAX_BUFFERED_BYTES) return;
                  transport.sendBinary(encodeBinaryEnvelope(
                    FRAME_KIND.PHONE_AUDIO,
                    { codec: pkt.codec || 'ima_adpcm', sampleRate: pkt.sampleRate || 48000, channels: pkt.channels || 2, frames: pkt.frames || 0, ts: pkt.ptsUs },
                    pkt.payload,
                  ));
                  return;
                }
                if (transport.getBufferedAmount() > MAX_BUFFERED_BYTES && !pkt.key && !pkt.codecData) return;
                transport.sendBinary(encodeBinaryEnvelope(
                  FRAME_KIND.PHONE_VIDEO,
                  { width: pkt.width, height: pkt.height, key: Boolean(pkt.key), codecData: Boolean(pkt.codecData), ts: pkt.ptsUs },
                  pkt.payload,
                ));
              },
              onError: (err) => {
                session.sendJson({ type: MSG.PHONE_RESULT, op: 'stream_error', ok: false, error: err?.message || 'phone stream error' });
              },
              onClose: () => {
                if (session.phoneStream === handle) session.phoneStream = null;
                session.sendJson({ type: MSG.PHONE_RESULT, op: 'stream_closed', ok: true });
              },
            });
            session.phoneStream = handle;
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'stream_started', ok: true, target: handle.target });
          } catch (err) {
            session.sendJson({ type: MSG.PHONE_RESULT, reqId: msg.reqId, op: 'stream_error', ok: false, error: err?.message || '连接手机投屏失败' });
          }
          return;
        }
      }
    };

    return session;
  }

  async #attachPhoneStreamWs(ws, params) {
    const serial = params.get('serial') || '';
    let host = (params.get('host') || '').trim();
    let port = Number(params.get('port')) || 9603;

    const sendJsonSafe = (obj) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch {}
      }
    };

    const isTailscaleV4 = (ip) => {
      const m = String(ip || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (!m) return false;
      return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
    };

    if (host) {
      const hp = host.match(/^\[?([^\]]+)\]?:(\d+)$/);
      const rawIp = hp ? hp[1] : host;
      const rawPort = hp ? Number(hp[2]) || port : port;
      if (isTailscaleV4(rawIp) && this.tsnet?.getStatus?.().enabled) {
        try {
          const tunPort = await this.tsnet.openTunnel(rawIp, rawPort);
          host = '127.0.0.1';
          port = tunPort;
        } catch {
          // Fall back to direct OS dial if tunnel helper wasn't ready
        }
      }
    }

    let streamHandle = null;
    let closed = false;
    ws.on('close', () => {
      closed = true;
      streamHandle?.close();
    });
    ws.on('error', () => {
      closed = true;
      streamHandle?.close();
    });

    try {
      streamHandle = await connectPhoneH264Stream({
        serial,
        host,
        port,
        onPacket: (pkt) => {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          if (pkt.audio) {
            if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
            const env = encodeBinaryEnvelope(
              FRAME_KIND.AUDIO,
              {
                codec: pkt.codec || 'ima_adpcm',
                sampleRate: pkt.sampleRate || 48000,
                channels: pkt.channels || 2,
                frames: pkt.frames || 0,
                ts: pkt.ptsUs,
              },
              pkt.payload,
            );
            ws.send(env, { binary: true });
            return;
          }
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES && !pkt.key && !pkt.codecData) {
            return;
          }
          const env = encodeBinaryEnvelope(
            FRAME_KIND.VIDEO,
            {
              width: pkt.width,
              height: pkt.height,
              key: Boolean(pkt.key),
              codecData: Boolean(pkt.codecData),
              ts: pkt.ptsUs,
            },
            pkt.payload,
          );
          ws.send(env, { binary: true });
        },
        onError: (err) => {
          sendJsonSafe({ type: 'error', error: err?.message || 'phone stream error' });
        },
        onClose: () => {
          sendJsonSafe({ type: 'closed' });
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.close();
            } catch {}
          }
        },
      });
      if (closed) {
        streamHandle.close();
        return;
      }
      sendJsonSafe({ type: 'connected', target: streamHandle.target });
    } catch (err) {
      sendJsonSafe({ type: 'error', error: err?.message || '连接手机投屏失败' });
      try {
        ws.close();
      } catch {}
    }
  }
}







