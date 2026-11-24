import {
  FRAME_KIND,
  MSG,
  computeChallengeProof,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
} from './protocol.js';
import { RTC_VIDEO_CHANNEL, RTC_VIDEO_READY, RtcVideoAssembler } from '@remote-deck/shared/rtc-video';

export function toWsUrl(inputUrl) {
  const raw = String(inputUrl || '').trim();
  if (!raw) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
    return raw.endsWith('/ws') ? raw : `${raw.replace(/\/+$/, '')}/ws`;
  }
  const normalized = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
  const u = new URL(normalized);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  return u.toString();
}

export function toHttpBase(inputUrl) {
  const raw = String(inputUrl || '').trim();
  if (!raw) return window.location.origin;
  if (raw.startsWith('ws://')) return `http://${raw.slice(5).replace(/\/ws$/, '')}`;
  if (raw.startsWith('wss://')) return `https://${raw.slice(6).replace(/\/ws$/, '')}`;
  const normalized = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
  return normalized.replace(/\/+$/, '');
}

/**
 * Unified multi-path client transport supporting:
 * 1. Direct LAN / Tunnel WebSocket
 * 2. Relay Server with automatic LAN-first race -> WebRTC DataChannel P2P -> Relay WS fallback
 */
export class RemoteTransport {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.activeChannel = null; // { kind: 'lan' | 'tailscale' | 'webrtc' | 'relay', sendText, sendBinary, close }
    this.signalingWs = null;
    this.rtcPc = null;
    this.rtcDc = null;
    this.pingTimer = null;
    this.closed = false;
    this.lastConnectArgs = null;
    this.sessionInfo = null;
    this.bytesThisWindow = 0;
    this.framesThisWindow = 0;
    this.statsTimer = null;
    this.rttMs = null;
    this.wasAuthenticated = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  emitStatus(status, detail = '') {
    this.handlers.onStatus?.({ status, detail, channel: this.activeChannel?.kind || null });
  }

  emitLog(text) {
    this.handlers.onLog?.(text);
  }

  sendJson(obj) {
    if (!this.activeChannel) return false;
    try {
      this.activeChannel.sendText(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(kind, meta, payload) {
    if (!this.activeChannel) return false;
    try {
      this.activeChannel.sendBinary(encodeBinaryEnvelope(kind, meta, payload));
      return true;
    } catch {
      return false;
    }
  }

  // Bytes queued in the underlying socket / data channel. File uploads use this
  // to apply backpressure instead of dumping a whole file into the send buffer
  // at once (which stalls or kills the tab on large files).
  bufferedAmount() {
    const ch = this.activeChannel;
    if (!ch) return 0;
    try {
      return Number(ch.bufferedAmount?.() || 0);
    } catch {
      return 0;
    }
  }

  async connect({ mode, serverUrl, deviceId, pin, fallbackUrl = '' }) {
    this.disconnect(false);
    this.closed = false;
    this.wasAuthenticated = false;
    this.reconnectAttempt = 0;
    clearTimeout(this.reconnectTimer);
    this.lastConnectArgs = { mode, serverUrl, deviceId, pin, fallbackUrl };

    const wsUrl = toWsUrl(serverUrl);
    if (mode === 'direct') {
      const fbWs = fallbackUrl ? toWsUrl(fallbackUrl) : '';
      const hasFallback = fbWs && fbWs !== wsUrl;
      this.emitLog(`直连地址: ${wsUrl}`);
      this.emitStatus('connecting', '正在建立直连通道...');
      try {
        await this.#connectDirectWs(
          wsUrl,
          pin,
          wsUrl.startsWith('wss://') ? 'tunnel' : 'lan',
          hasFallback ? 3000 : undefined,
        );
        return;
      } catch (err) {
        const msg = err?.message || '';
        const isAuthErr = msg.includes('配对码') || msg.includes('PIN') || msg.includes('拒绝');
        if (!hasFallback || isAuthErr) throw err;
        this.emitLog(`直连失败，切换到服务器: ${fbWs}`);
        this.emitStatus('connecting', '正在连接服务器...');
        await this.#connectDirectWs(fbWs, pin, 'tunnel', 12000);
        return;
      }
    }

    // Relay + Smart Route Racing mode
    this.emitLog(`连接服务器: ${wsUrl}`);
    this.emitStatus('connecting', '正在查找设备并探测最优链路...');
    await this.#connectViaRelay(wsUrl, deviceId, pin);
  }

  async #connectDirectWs(wsUrl, pin, channelKind = 'lan', timeoutMs) {
    const session = await this.#openAndAuthenticateWs(wsUrl, pin, channelKind, timeoutMs);
    this.#activateChannel(session);
  }

  #openAndAuthenticateWs(wsUrl, pin, channelKind, timeoutMs) {
    const effectiveTimeout = timeoutMs ?? (wsUrl.startsWith('wss://') ? 12000 : 4500);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error(`连接超时 (${wsUrl})`));
        }
      }, effectiveTimeout);

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === MSG.AUTH_CHALLENGE) {
          const proof = computeChallengeProof(pin, msg.nonce, msg.deviceId);
          ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof }));
          return;
        }
        if (msg.type === MSG.AUTH_PENDING && !settled) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              try { ws.close(); } catch {}
              reject(new Error('等待被控端确认超时'));
            }
          }, 28000);
          this.emitStatus('connecting', msg.message || '等待被控端确认允许连接...');
          return;
        }
        if (msg.type === MSG.AUTH_OK && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            kind: channelKind,
            ws,
            authInfo: msg,
            sendText: (t) => ws.send(t),
            sendBinary: (u8) => ws.send(u8),
            bufferedAmount: () => ws.bufferedAmount || 0,
            close: () => ws.close(),
          });
          return;
        }
        if (msg.type === MSG.AUTH_ERROR && !settled) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          reject(new Error(msg.error || '密码错误'));
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`无法连接到 ${wsUrl}`));
        }
      };

      ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`连接已关闭 (${wsUrl})`));
        }
      };
    });
  }

  async #raceLanCandidates(candidates, pin) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const isPageHttps = window.location.protocol === 'https:';
    const usable = candidates.filter((c) => {
      if (!c?.wsUrl) return false;
      // Avoid browser Mixed Content failure if Web UI is loaded over HTTPS
      if (isPageHttps && c.wsUrl.startsWith('ws://')) return false;
      return true;
    });
    if (usable.length === 0) return null;

    this.emitLog(`探测局域网地址 (${usable.map((u) => u.ip).join(', ')})...`);
    try {
      const winner = await Promise.any(
        usable.map(async (c) => {
          const kind = c.kind === 'tailscale' ? 'tailscale' : 'lan';
          return await this.#openAndAuthenticateWs(c.wsUrl, pin, kind, 1100);
        }),
      );
      return winner;
    } catch {
      return null;
    }
  }

  #connectViaRelay(relayWsUrl, deviceId, pin) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let relayAuthStarted = false;
      const ws = new WebSocket(relayWsUrl);
      ws.binaryType = 'arraybuffer';
      this.signalingWs = ws;

      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: MSG.CONTROLLER_CONNECT, deviceId }));
      };

      ws.onerror = () => fail(new Error(`无法连接服务器 ${relayWsUrl}`));

      ws.onclose = () => {
        if (!settled) fail(new Error('服务器连接提前关闭'));
        if (this.activeChannel?.ws === ws && !this.closed) {
          this.#handleUnexpectedDrop('连接已断开');
        }
      };

      ws.onmessage = async (ev) => {
        if (typeof ev.data !== 'string') {
          if (this.activeChannel?.ws === ws) {
            this.#handleBinary(ev.data);
          }
          return;
        }
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === MSG.ERROR) {
          fail(new Error(msg.error || '设备连接失败'));
          return;
        }

        if (msg.type === MSG.ROUTE_CANDIDATES) {
          this.emitLog(`收到路由候选: LAN=${msg.lanEndpoints?.length || 0}, ICE=${msg.iceServers?.length || 0}`);

          // 1. Race LAN / Tailscale direct first
          const lanWinner = await this.#raceLanCandidates(msg.lanEndpoints, pin);
          if (lanWinner) {
            this.emitLog(`局域网连接成功 (${lanWinner.kind})`);
            this.#activateChannel(lanWinner);
            try { ws.close(); } catch {}
            this.signalingWs = null;
            settled = true;
            resolve();
            return;
          }

          // 2. Try WebRTC P2P in background while keeping Relay ready
          if (typeof RTCPeerConnection !== 'undefined' && this.signalingWs === ws) {
            this.#startWebRtcUpgrade(ws, msg.iceServers || [], pin, () => {
              settled = true;
              resolve();
            });
          }
          return;
        }

        if (this.signalingWs !== ws) return;
        if (msg.type === MSG.RTC_ANSWER && this.rtcPc && msg.sdp) {
          const pc = this.rtcPc;
          const pending = this.pendingRtcIce;
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            for (const candidate of pending.splice(0)) {
              try { await pc.addIceCandidate(candidate); } catch {}
            }
          } catch {}
          return;
        }

        if (msg.type === MSG.RTC_ICE && this.rtcPc && msg.candidate) {
          if (!this.rtcPc.remoteDescription) {
            this.pendingRtcIce.push(msg.candidate);
          } else {
            try { await this.rtcPc.addIceCandidate(msg.candidate); } catch {}
          }
          return;
        }

        if (msg.type === MSG.RELAY_READY) {
          this.emitLog('服务器就绪，正在鉴权...');
          return;
        }

        if (msg.type === MSG.AUTH_CHALLENGE && !relayAuthStarted) {
          relayAuthStarted = true;
          const proof = computeChallengeProof(pin, msg.nonce, msg.deviceId);
          ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof }));
          return;
        }

        if (msg.type === MSG.AUTH_PENDING && !this.activeChannel) {
          this.emitStatus('connecting', msg.message || '等待被控端确认允许连接...');
          return;
        }

        if (msg.type === MSG.AUTH_OK && !this.activeChannel) {
          this.#activateChannel({
            kind: 'relay',
            ws,
            authInfo: msg,
            sendText: (t) => ws.send(t),
            sendBinary: (u8) => ws.send(u8),
            bufferedAmount: () => ws.bufferedAmount || 0,
            close: () => ws.close(),
          });
          settled = true;
          resolve();
          return;
        }

        if (msg.type === MSG.AUTH_ERROR && !this.activeChannel) {
          fail(new Error(msg.error || '密码错误'));
          try { ws.close(); } catch {}
          return;
        }

        if (this.activeChannel?.ws === ws) {
          this.#handleControlMessage(msg);
        }
      };
    });
  }

  async #startWebRtcUpgrade(signalingWs, iceServers, pin, onConnected) {
    try {
      const pc = new RTCPeerConnection({ iceServers });
      this.rtcPc = pc;
      this.pendingRtcIce = [];
      const dc = pc.createDataChannel('remotedeck', { ordered: true });
      dc.binaryType = 'arraybuffer';
      this.rtcDc = dc;

      pc.onicecandidate = (ev) => {
        if (ev.candidate && signalingWs.readyState === WebSocket.OPEN) {
          signalingWs.send(JSON.stringify({
            type: MSG.RTC_ICE,
            candidate: ev.candidate,
          }));
        }
      };

      dc.onopen = () => {
        this.emitLog('已建立直连');
      };

      let authed = false;
      let videoReceiving = false;
      pc.ondatachannel = ({ channel: video }) => {
        if (video.label !== RTC_VIDEO_CHANNEL || !authed || this.activeChannel?.dc !== dc) {
          video.close();
          return;
        }
        video.binaryType = 'arraybuffer';
        const assembler = new RtcVideoAssembler();
        video.onmessage = ({ data }) => {
          if (this.activeChannel?.dc !== dc || !(data instanceof ArrayBuffer || data instanceof Uint8Array)) return;
          const frame = assembler.push(data);
          if (!frame) return;
          if (!videoReceiving || frame.gap) this.handlers.onVideoDiscontinuity?.();
          videoReceiving = true;
          this.#handleBinary(frame.data, FRAME_KIND.VIDEO);
        };
        video.onclose = () => {
          if (this.activeChannel?.dc !== dc || !videoReceiving) return;
          videoReceiving = false;
          this.handlers.onVideoDiscontinuity?.();
          this.sendJson({ type: MSG.SCREEN_CONFIG, forceKey: true });
        };
        const ready = () => {
          if (this.activeChannel?.dc === dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({ type: RTC_VIDEO_READY, ready: true }));
          }
        };
        video.onopen = ready;
        if (video.readyState === 'open') ready();
      };
      dc.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
          if (authed && this.activeChannel?.dc === dc) {
            this.#handleBinary(ev.data, undefined, videoReceiving ? FRAME_KIND.VIDEO : undefined);
          }
          return;
        }
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (!authed && msg.type === MSG.AUTH_CHALLENGE) {
          const proof = computeChallengeProof(pin, msg.nonce, msg.deviceId);
          dc.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof }));
          return;
        }
        if (!authed && msg.type === MSG.AUTH_OK) {
          authed = true;
          if (this.rtcPc !== pc || this.signalingWs !== signalingWs || this.closed) return;
          const prevChannel = this.activeChannel;
          if (prevChannel?.kind === 'relay' && prevChannel.ws.readyState === WebSocket.OPEN) {
            prevChannel.sendText(JSON.stringify({ type: MSG.SCREEN_STOP }));
            prevChannel.sendText(JSON.stringify({ type: MSG.AUDIO_STOP }));
            prevChannel.sendText(JSON.stringify({ type: MSG.CLIPBOARD_WATCH, enabled: false }));
          }
          this.handlers.onVideoDiscontinuity?.();
          if (msg.videoEncoder && msg.permissions?.view !== false && this.handlers.onVideoFrame) {
            dc.send(JSON.stringify({ type: RTC_VIDEO_READY }));
          }
          this.#activateChannel({
            kind: 'webrtc',
            dc,
            authInfo: msg,
            sendText: (t) => dc.send(t),
            sendBinary: (u8) => dc.send(u8),
            bufferedAmount: () => dc.bufferedAmount || 0,
            close: () => dc.close(),
          }, Boolean(prevChannel));
          onConnected();
          this.emitLog('已切换为 WebRTC 连接');
          return;
        }
        if (authed && this.activeChannel?.dc === dc) {
          this.#handleControlMessage(msg);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (signalingWs.readyState === WebSocket.OPEN) {
        signalingWs.send(JSON.stringify({
          type: MSG.RTC_OFFER,
          sdp: offer.sdp,
        }));
      }
    } catch {
      // Relay WS remains active
    }
  }

  #activateChannel(channel, isUpgrade = false) {
    this.activeChannel = channel;
    this.sessionInfo = channel.authInfo;
    this.wasAuthenticated = true;
    this.reconnectAttempt = 0;
    clearTimeout(this.reconnectTimer);

    if (channel.ws && channel.ws !== this.signalingWs) {
      channel.ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            this.#handleControlMessage(JSON.parse(ev.data));
          } catch {}
        } else {
          this.#handleBinary(ev.data);
        }
      };
      channel.ws.onclose = () => {
        if (this.activeChannel === channel && !this.closed) {
          this.#handleUnexpectedDrop('连接已断开');
        }
      };
    }

    if (channel.dc) {
      channel.dc.onclose = () => {
        if (this.activeChannel === channel && !this.closed) {
          this.#handleUnexpectedDrop('连接已断开');
        }
      };
    }

    this.#startTelemetry();
    this.handlers.onAuthenticated?.(channel.authInfo, channel.kind);
    if (isUpgrade) this.handlers.onChannelUpgrade?.(channel.kind);
    this.emitStatus('connected', channel.kind);
  }

  #handleUnexpectedDrop(reason) {
    if (this.closed || !this.wasAuthenticated || !this.lastConnectArgs) {
      this.emitStatus('disconnected', reason);
      return;
    }
    this.disconnect(false);
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.closed || !this.lastConnectArgs) return;
    if (this.reconnectAttempt >= 5) {
      this.wasAuthenticated = false;
      this.emitStatus('disconnected', '多次重连失败，请重新连接');
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(8000, 1200 * this.reconnectAttempt);
    this.emitStatus('reconnecting', `连接波动，正在自动重连 (${this.reconnectAttempt}/5)...`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (this.closed || !this.lastConnectArgs) return;
      try {
        const { mode, serverUrl, deviceId, pin, fallbackUrl } = this.lastConnectArgs;
        const wsUrl = toWsUrl(serverUrl);
        if (mode === 'direct') {
          const fbWs = fallbackUrl ? toWsUrl(fallbackUrl) : '';
          const hasFallback = fbWs && fbWs !== wsUrl;
          try {
            await this.#connectDirectWs(
              wsUrl,
              pin,
              wsUrl.startsWith('wss://') ? 'tunnel' : 'lan',
              hasFallback ? 3000 : undefined,
            );
          } catch (err) {
            if (!hasFallback) throw err;
            await this.#connectDirectWs(fbWs, pin, 'tunnel', 12000);
          }
        } else {
          await this.#connectViaRelay(wsUrl, deviceId, pin);
        }
      } catch {
        if (!this.closed) {
          this.#scheduleReconnect();
        }
      }
    }, delay);
  }

  #startTelemetry() {
    clearInterval(this.pingTimer);
    clearInterval(this.statsTimer);
    this.pingTimer = setInterval(() => {
      this.sendJson({ type: MSG.PING, ts: performance.now(), rttMs: this.rttMs });
    }, 2000);
    this.sendJson({ type: MSG.PING, ts: performance.now(), rttMs: this.rttMs });

    this.statsTimer = setInterval(() => {
      this.handlers.onTelemetry?.({
        rttMs: this.rttMs,
        fps: this.framesThisWindow,
        kbps: Math.round((this.bytesThisWindow * 8) / 1000),
        channel: this.activeChannel?.kind || null,
      });
      this.bytesThisWindow = 0;
      this.framesThisWindow = 0;
    }, 1000);
  }

  #handleControlMessage(msg) {
    if (msg.type === MSG.PONG && typeof msg.ts === 'number') {
      this.rttMs = Math.max(1, Math.round(performance.now() - msg.ts));
      return;
    }
    this.handlers.onMessage?.(msg);
  }

  #handleBinary(raw, onlyKind, ignoredKind) {
    try {
      const env = decodeBinaryEnvelope(raw);
      if ((onlyKind !== undefined && env.kind !== onlyKind) || env.kind === ignoredKind) return;
      this.bytesThisWindow += raw?.byteLength || 0;
      if (env.kind === FRAME_KIND.SCREEN) {
        this.framesThisWindow += 1;
        this.handlers.onScreenFrame?.(env.meta, env.payload);
      } else if (env.kind === FRAME_KIND.PTY_OUT) {
        this.handlers.onPtyOutput?.(env.meta?.id, env.payload);
      } else if (env.kind === FRAME_KIND.FILE_DOWN) {
        this.handlers.onFileDownloadChunk?.(env.meta, env.payload);
      } else if (env.kind === FRAME_KIND.AUDIO) {
        this.handlers.onAudioFrame?.(env.meta, env.payload);
      } else if (env.kind === FRAME_KIND.VIDEO) {
        this.framesThisWindow += 1;
        this.handlers.onVideoFrame?.(env.meta, env.payload);
      } else if (env.kind === FRAME_KIND.PHONE_VIDEO) {
        this.handlers.onPhoneVideoFrame?.(env.meta, env.payload);
      } else if (env.kind === FRAME_KIND.PHONE_AUDIO) {
        this.handlers.onPhoneAudioFrame?.(env.meta, env.payload);
      }
    } catch {}
  }

  disconnect(userInitiated = true) {
    if (userInitiated) {
      this.closed = true;
      this.wasAuthenticated = false;
      clearTimeout(this.reconnectTimer);
    }
    clearInterval(this.pingTimer);
    clearInterval(this.statsTimer);
    if (this.activeChannel) {
      try { this.activeChannel.close(); } catch {}
      this.activeChannel = null;
    }
    if (this.signalingWs) {
      try { this.signalingWs.close(); } catch {}
      this.signalingWs = null;
    }
    if (this.rtcPc) {
      try { this.rtcPc.close(); } catch {}
      this.rtcPc = null;
      this.rtcDc = null;
    }
    if (userInitiated) {
      this.emitStatus('idle', '');
    }
  }
}
