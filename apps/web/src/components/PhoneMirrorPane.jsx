import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FRAME_KIND, MSG, decodeBinaryEnvelope } from '../lib/protocol.js';
import { H264Player } from '../lib/video.js';
import { RemoteAudioPlayer } from '../lib/audio.js';

export function PhoneMirrorPane({ transport = null, phoneHubRef = null }) {
  const [phones, setPhones] = useState([]);
  const [selectedSerial, setSelectedSerial] = useState('');
  const [streamMode, setStreamMode] = useState('h264'); // 'h264' | 'snapshot'
  const [directHost, setDirectHost] = useState(''); // Optional LAN/Tailscale IP[:9603] for USB-free 60fps view
  const [wirelessTarget, setWirelessTarget] = useState(''); // Optional ip:debugPort for hdc tconn
  const [streaming, setStreaming] = useState(true);
  const [phoneAudioEnabled, setPhoneAudioEnabled] = useState(false);
  const [reconnectTick, setReconnectTick] = useState(0);
  const [h264Connected, setH264Connected] = useState(false);
  const [h264Supported, setH264Supported] = useState(true);
  const [loadingList, setLoadingList] = useState(false);
  const [connectingWireless, setConnectingWireless] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [phoneDims, setPhoneDims] = useState({ width: 1320, height: 2120 });
  const [videoDims, setVideoDims] = useState({ width: 0, height: 0 });
  const [frameUrl, setFrameUrl] = useState('');
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);

  const imgRef = useRef(null);
  const canvasRef = useRef(null);
  const playerRef = useRef(null);
  const audioRef = useRef(null);
  const phoneAudioEnabledRef = useRef(false);
  const wsRef = useRef(null);
  const dragStartRef = useRef(null);
  const lastUrlRef = useRef('');
  const timerRef = useRef(0);
  const destroyedRef = useRef(false);
  const pendingReqsRef = useRef(new Map());

  const sendRemoteReq = useCallback((payload, timeoutMs = 6000) => {
    if (!transport) return Promise.reject(new Error('no active transport'));
    const reqId = `ph-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingReqsRef.current.has(reqId)) {
          pendingReqsRef.current.delete(reqId);
          reject(new Error('手机指令超时'));
        }
      }, timeoutMs);
      pendingReqsRef.current.set(reqId, { resolve, reject, timer });
      transport.sendJson({ ...payload, reqId });
    });
  }, [transport]);

  useEffect(() => {
    if (!phoneHubRef) return undefined;
    phoneHubRef.current = {
      onMessage: (msg) => {
        if (msg.reqId && pendingReqsRef.current.has(msg.reqId)) {
          const entry = pendingReqsRef.current.get(msg.reqId);
          pendingReqsRef.current.delete(msg.reqId);
          clearTimeout(entry.timer);
          entry.resolve(msg);
          return;
        }
        if (msg.op === 'stream_error') {
          setH264Connected(false);
          setStatusText(msg.error || 'H.264 投屏连接失败');
        } else if (msg.op === 'stream_closed') {
          setH264Connected(false);
          if (!destroyedRef.current) {
            window.setTimeout(() => setReconnectTick((n) => n + 1), 1200);
          }
        }
      },
      onVideo: (meta, payload) => {
        if (!playerRef.current) return;
        if (canvasRef.current) {
          playerRef.current.attach(canvasRef.current);
        }
        if (meta?.width > 0 && meta?.height > 0) {
          setVideoDims((prev) => (prev.width === meta.width && prev.height === meta.height ? prev : { width: meta.width, height: meta.height }));
        }
        playerRef.current.push(meta, payload);
        setH264Connected(true);
        setStatusText('');
      },
      onAudio: (meta, payload) => {
        if (phoneAudioEnabledRef.current && audioRef.current) {
          audioRef.current.pushPcm16(meta, payload);
        }
      },
    };
    return () => {
      if (phoneHubRef) phoneHubRef.current = null;
      for (const entry of pendingReqsRef.current.values()) {
        clearTimeout(entry.timer);
      }
      pendingReqsRef.current.clear();
    };
  }, [phoneHubRef]);

  useEffect(() => {
    void H264Player.supported().then((ok) => {
      setH264Supported(ok);
      if (!ok) setStreamMode('snapshot');
    });
  }, []);

  const refreshDevices = useCallback(async () => {
    setLoadingList(true);
    try {
      const data = transport
        ? await sendRemoteReq({ type: MSG.PHONE_LIST })
        : await (await fetch('/api/phones', { cache: 'no-store' })).json();
      const list = Array.isArray(data?.devices) ? data.devices : [];
      setPhones(list);
      setSelectedSerial((prev) => {
        if (prev && list.some((d) => d.serial === prev)) return prev;
        return list.length > 0 ? list[0].serial : '';
      });
      if (list.length > 0) {
        const first = list[0];
        if (first.screenWidth > 0 && first.screenHeight > 0) {
          setPhoneDims({ width: first.screenWidth, height: first.screenHeight });
        }
        setStatusText('');
      } else if (!directHost.trim()) {
        setStatusText('未检测到手机');
      }
    } catch (err) {
      setStatusText(`查询手机列表失败: ${err?.message || err}`);
    } finally {
      setLoadingList(false);
    }
  }, [directHost, transport, sendRemoteReq]);

  useEffect(() => {
    const dev = phones.find((d) => d.serial === selectedSerial);
    if (dev && dev.screenWidth > 0 && dev.screenHeight > 0) {
      setPhoneDims({ width: dev.screenWidth, height: dev.screenHeight });
    }
  }, [selectedSerial, phones]);

  const fetchOneFrame = useCallback(async (serial) => {
    if (!serial) return;
    try {
      if (transport) {
        const res = await sendRemoteReq({ type: MSG.PHONE_FRAME, serial });
        if (!res?.ok || !res?.jpegBase64) {
          setStatusText(res?.error || '远端拉取手机画面失败');
          return;
        }
        if (res.width > 0 && res.height > 0) {
          setPhoneDims({ width: res.width, height: res.height });
        }
        setFrameUrl(`data:image/jpeg;base64,${res.jpegBase64}`);
        setStatusText('');
        return;
      }

      const resp = await fetch(`/api/phones/frame?serial=${encodeURIComponent(serial)}&t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setStatusText(err?.error || `画面拉取失败 (${resp.status})`);
        return;
      }
      const w = Number(resp.headers.get('x-phone-width')) || 0;
      const h = Number(resp.headers.get('x-phone-height')) || 0;
      if (w > 0 && h > 0) {
        setPhoneDims({ width: w, height: h });
      }
      const blob = await resp.blob();
      const nextUrl = URL.createObjectURL(blob);
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current);
      }
      lastUrlRef.current = nextUrl;
      setFrameUrl(nextUrl);
      setStatusText('');
    } catch (err) {
      setStatusText(`投屏中断: ${err?.message || err}`);
    }
  }, [transport, sendRemoteReq]);

  useEffect(() => {
    destroyedRef.current = false;
    void refreshDevices();
    return () => {
      destroyedRef.current = true;
      clearTimeout(timerRef.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
      if (playerRef.current) {
        playerRef.current.reset();
        playerRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.destroy();
        audioRef.current = null;
      }
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current);
        lastUrlRef.current = '';
      }
    };
  }, [refreshDevices]);

  // 30-60fps H.264 + audio stream (either over remote transport or local /ws/phone-stream)
  useEffect(() => {
    if (streamMode !== 'h264' || !streaming || (!selectedSerial && !directHost.trim())) {
      setH264Connected(false);
      if (transport) {
        transport.sendJson({ type: MSG.PHONE_STREAM_STOP });
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
      return undefined;
    }

    if (!playerRef.current) {
      playerRef.current = new H264Player();
      playerRef.current.onError = () => {
        playerRef.current?.reset();
      };
    }
    if (canvasRef.current) {
      playerRef.current.attach(canvasRef.current);
    }

    if (transport) {
      setStatusText('正在连接...');
      void sendRemoteReq({
        type: MSG.PHONE_STREAM_START,
        serial: selectedSerial,
        host: directHost.trim(),
        port: 9603,
      }).then((res) => {
        if (res?.ok) {
          setH264Connected(true);
          setStatusText('');
        } else {
          setStatusText(res?.error || '连接手机投屏失败');
        }
      }).catch((err) => {
        setStatusText(err?.message || '连接手机投屏失败');
      });
      return () => {
        transport.sendJson({ type: MSG.PHONE_STREAM_STOP });
      };
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams();
    if (selectedSerial) qs.set('serial', selectedSerial);
    if (directHost.trim()) qs.set('host', directHost.trim());
    const wsUrl = `${proto}//${window.location.host}/ws/phone-stream?${qs.toString()}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setStatusText('请在手机端点「开始共享」');

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'connected') {
            setH264Connected(true);
            setStatusText('');
          } else if (msg.type === 'error') {
            setH264Connected(false);
            setStatusText(msg.error || 'H.264 投屏连接失败');
          } else if (msg.type === 'closed') {
            setH264Connected(false);
          }
        } catch {}
        return;
      }
      try {
        const env = decodeBinaryEnvelope(ev.data);
        if (env.kind === FRAME_KIND.AUDIO) {
          if (phoneAudioEnabledRef.current && audioRef.current) {
            audioRef.current.pushPcm16(env.meta, env.payload);
          }
          return;
        }
        if (env.kind === FRAME_KIND.VIDEO && playerRef.current) {
          if (canvasRef.current) {
            playerRef.current.attach(canvasRef.current);
          }
          const meta = env.meta || {};
          if (meta.width > 0 && meta.height > 0) {
            setVideoDims((prev) => (prev.width === meta.width && prev.height === meta.height ? prev : { width: meta.width, height: meta.height }));
          }
          playerRef.current.push(meta, env.payload);
          setH264Connected(true);
          setStatusText('');
        }
      } catch {}
    };

    ws.onerror = () => {
      setH264Connected(false);
    };

    let disposed = false;
    let retryTimer = 0;

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      setH264Connected(false);
      if (!disposed && !destroyedRef.current) {
        retryTimer = window.setTimeout(() => {
          setReconnectTick((n) => n + 1);
        }, 1200);
      }
    };

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      try {
        ws.close();
      } catch {}
    };
  }, [streamMode, streaming, selectedSerial, directHost, reconnectTick, transport, sendRemoteReq]);

  // Legacy HDC snapshot fallback loop
  useEffect(() => {
    if (streamMode !== 'snapshot' || !selectedSerial || !streaming) return undefined;
    let active = true;
    const loop = async () => {
      await fetchOneFrame(selectedSerial);
      if (active && !destroyedRef.current) {
        timerRef.current = window.setTimeout(loop, 240);
      }
    };
    void loop();
    return () => {
      active = false;
      clearTimeout(timerRef.current);
    };
  }, [streamMode, selectedSerial, streaming, fetchOneFrame]);

  const handleTogglePhoneAudio = async () => {
    if (!audioRef.current) {
      audioRef.current = new RemoteAudioPlayer();
    }
    if (!phoneAudioEnabled) {
      const ok = await audioRef.current.start();
      if (!ok) {
        setStatusText('当前浏览器不支持音频播放');
        return;
      }
      phoneAudioEnabledRef.current = true;
      setPhoneAudioEnabled(true);
    } else {
      phoneAudioEnabledRef.current = false;
      audioRef.current.stop();
      setPhoneAudioEnabled(false);
    }
  };

  const handleConnectWireless = async (e) => {
    e.preventDefault();
    const target = wirelessTarget.trim();
    if (!target) return;
    setConnectingWireless(true);
    setStatusText(`正在无线连接 ${target}...`);
    try {
      const data = transport
        ? await sendRemoteReq({ type: MSG.PHONE_CONNECT, target }, 8000)
        : await (await fetch('/api/phones/connect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target }),
          })).json().catch(() => ({}));
      if (data?.ok === false) {
        setStatusText(data?.error || '无线调试连接失败');
        return;
      }
      const list = Array.isArray(data.devices) ? data.devices : [];
      setPhones(list);
      const matched = list.find((d) => d.serial === target) || list[0];
      if (matched) setSelectedSerial(matched.serial);
      setStatusText('');
    } catch (err) {
      setStatusText(`无线连接失败: ${err?.message || err}`);
    } finally {
      setConnectingWireless(false);
    }
  };

  const sendAction = async (payload) => {
    if (!selectedSerial) return;
    setSending(true);
    try {
      if (transport) {
        const res = await sendRemoteReq({ type: MSG.PHONE_INPUT, serial: selectedSerial, ...payload });
        if (res?.ok === false) {
          setStatusText(res?.error || '操作发送失败');
        } else if (streamMode === 'snapshot') {
          setTimeout(() => {
            void fetchOneFrame(selectedSerial);
          }, 180);
        }
        return;
      }
      const resp = await fetch('/api/phones/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serial: selectedSerial, ...payload }),
      });
      const res = await resp.json().catch(() => ({}));
      if (!resp.ok || res?.ok === false) {
        setStatusText(res?.error || '操作发送失败');
      } else if (streamMode === 'snapshot') {
        setTimeout(() => {
          void fetchOneFrame(selectedSerial);
        }, 180);
      }
    } catch (err) {
      setStatusText(`发送失败: ${err?.message || err}`);
    } finally {
      setSending(false);
    }
  };

  const toPhoneCoords = (e) => {
    const el = streamMode === 'h264' ? canvasRef.current : imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
    return {
      x: Math.round(nx * phoneDims.width),
      y: Math.round(ny * phoneDims.height),
    };
  };

  const handlePointerDown = (e) => {
    if (!selectedSerial) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pt = toPhoneCoords(e);
    dragStartRef.current = { clientX: e.clientX, clientY: e.clientY, x: pt.x, y: pt.y };
  };

  const handlePointerUp = (e) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start || !selectedSerial) return;
    const end = toPhoneCoords(e);
    const dist = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY);
    if (dist < 10) {
      void sendAction({ action: 'tap', x: end.x, y: end.y });
    } else {
      void sendAction({ action: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, speed: 2400 });
    }
  };

  const handleSendText = async (e) => {
    e.preventDefault();
    const text = inputText;
    if (!text.trim() || !selectedSerial) return;
    setInputText('');
    await sendAction({ action: 'text', text });
  };

  const hasTarget = Boolean(selectedSerial || directHost.trim());

  return (
    <div className="rd-section-stack">
      <div className="rd-toolbar-row">
        <div>
          <h2>手机投屏</h2>
        </div>
        <div className="rd-phone-actions">
          {phones.length > 0 && (
            <select
              className="compact-select"
              value={selectedSerial}
              onChange={(e) => setSelectedSerial(e.target.value)}
            >
              {phones.map((p) => (
                <option key={p.serial} value={p.serial}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <select
            className="compact-select"
            value={streamMode}
            onChange={(e) => setStreamMode(e.target.value)}
          >
            {h264Supported && <option value="h264">高清</option>}
            <option value="snapshot">截图</option>
          </select>
          {streamMode === 'h264' && (
            <button
              type="button"
              className={`btn-secondary btn-sm ${phoneAudioEnabled ? 'btn-active-pill' : ''}`}
              onClick={handleTogglePhoneAudio}
            >
              声音
            </button>
          )}
          <button type="button" className="btn-secondary btn-sm" onClick={refreshDevices} disabled={loadingList}>
            {loadingList ? '扫描中...' : '刷新'}
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => setStreaming((v) => !v)}
            disabled={!hasTarget}
          >
            {streaming ? '暂停' : '恢复'}
          </button>
        </div>
      </div>

      <details className="rd-phone-advanced">
        <summary>高级</summary>
        <div className="rd-phone-connect-bar">
          <label className="rd-inline-field">
            <span>手机地址</span>
            <input
              type="text"
              value={directHost}
              onChange={(e) => setDirectHost(e.target.value)}
              placeholder="自动或手动填写"
            />
          </label>
          <form className="rd-inline-field" onSubmit={handleConnectWireless}>
            <span>无线调试</span>
            <div className="rd-inline-input-btn">
              <input
                type="text"
                value={wirelessTarget}
                onChange={(e) => setWirelessTarget(e.target.value)}
                placeholder="地址:端口"
              />
              <button type="submit" className="btn-secondary btn-sm" disabled={connectingWireless || !wirelessTarget.trim()}>
                {connectingWireless ? '连接中...' : '连接'}
              </button>
            </div>
          </form>
        </div>
      </details>

      {statusText && <div className="alert-info">{statusText}</div>}

      <div className="rd-phone-workspace">
        <div className="rd-phone-stage">
          {streamMode === 'h264' ? (
            hasTarget ? (
              <div className="rd-phone-canvas-wrap">
                <canvas
                  ref={canvasRef}
                  className="rd-phone-screen-img"
                  onPointerDown={handlePointerDown}
                  onPointerUp={handlePointerUp}
                />
                {!h264Connected && (
                  <div className="rd-phone-hint-badge">等待手机端「开始共享」推流...</div>
                )}
              </div>
            ) : (
              <div className="rd-empty-panel">
                <strong>请输入手机 IP 或连接无线调试</strong>
                <p className="muted">在手机 RemoteDeck 首页点击「开始共享」，再填入手机局域网或 Tailscale IP 即可 60fps 观看。</p>
              </div>
            )
          ) : frameUrl ? (
            <img
              ref={imgRef}
              src={frameUrl}
              alt="HarmonyOS Phone Mirror"
              className="rd-phone-screen-img"
              draggable={false}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
            />
          ) : (
            <div className="rd-empty-panel">
              <strong>{selectedSerial ? '正在连接...' : '没有设备'}</strong>
            </div>
          )}
        </div>

        <aside className="rd-phone-controls-card">
          <h3>快捷按键与输入</h3>
          <div className="rd-phone-key-grid">
            <button type="button" className="btn-secondary btn-sm" disabled={!selectedSerial || sending} onClick={() => sendAction({ action: 'key', key: 'Back' })}>
              返回 (Back)
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={!selectedSerial || sending} onClick={() => sendAction({ action: 'key', key: 'Home' })}>
              桌面 (Home)
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={!selectedSerial || sending} onClick={() => sendAction({ action: 'key', key: 'Power' })}>
              锁屏/唤醒
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={!selectedSerial || streamMode === 'h264'}
              onClick={() => fetchOneFrame(selectedSerial)}
            >
              单帧刷新
            </button>
          </div>

          <div className="rd-phone-key-grid">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={!selectedSerial || sending}
              onClick={() =>
                sendAction({
                  action: 'swipe',
                  x1: Math.round(phoneDims.width * 0.5),
                  y1: Math.round(phoneDims.height * 0.72),
                  x2: Math.round(phoneDims.width * 0.5),
                  y2: Math.round(phoneDims.height * 0.22),
                  speed: 2600,
                })
              }
            >
              上滑下一条
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={!selectedSerial || sending}
              onClick={() =>
                sendAction({
                  action: 'swipe',
                  x1: Math.round(phoneDims.width * 0.5),
                  y1: Math.round(phoneDims.height * 0.25),
                  x2: Math.round(phoneDims.width * 0.5),
                  y2: Math.round(phoneDims.height * 0.75),
                  speed: 2600,
                })
              }
            >
              下滑上一条
            </button>
          </div>

          <form className="rd-phone-text-form" onSubmit={handleSendText}>
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="向手机当前输入框发送中英文..."
              disabled={!selectedSerial || sending}
            />
            <button type="submit" className="btn-primary btn-sm" disabled={!selectedSerial || sending || !inputText.trim()}>
              发送文本
            </button>
          </form>

          {sending ? <p className="muted" style={{ fontSize: '12px', marginTop: '8px' }}>执行中...</p> : null}
        </aside>
      </div>
    </div>
  );
}
