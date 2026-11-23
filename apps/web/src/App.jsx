import React, { useEffect, useRef, useState } from 'react';
import { useDeviceEnvironment } from './lib/device.js';
import { FRAME_KIND, MSG } from './lib/protocol.js';
import { RemoteTransport } from './lib/transport.js';
import { RemoteAudioPlayer } from './lib/audio.js';
import { H264Player } from './lib/video.js';
import { ConnectView, saveRecentDevice } from './components/ConnectView.jsx';
import { TopHud } from './components/TopHud.jsx';
import { RemoteCanvas } from './components/RemoteCanvas.jsx';
import { TerminalPanel } from './components/TerminalPanel.jsx';
import { FilePanel } from './components/FilePanel.jsx';
import { PhoneMirrorPane } from './components/PhoneMirrorPane.jsx';

const QUALITY_PRESETS = {
  auto: { fps: 20, scale: 0.9, quality: 82, auto: true },
  eco: { fps: 12, scale: 0.55, quality: 62, auto: false },
  balanced: { fps: 18, scale: 0.8, quality: 78, auto: false },
  hd: { fps: 22, scale: 1.0, quality: 88, auto: false },
  uhd: { fps: 18, scale: 1.0, quality: 94, auto: false },
};

export function App() {
  const [layoutOverride, setLayoutOverride] = useState('auto');
  const env = useDeviceEnvironment(layoutOverride);

  const [connState, setConnState] = useState('idle'); // idle | connecting | connected
  const [sessionInfo, setSessionInfo] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [logs, setLogs] = useState([]);
  const [toast, setToast] = useState('');

  const [activeTab, setActiveTab] = useState('screen'); // screen | terminal | files | split
  const [displays, setDisplays] = useState([]);
  const [activeDisplayId, setActiveDisplayId] = useState(0);
  const [qualityPreset, setQualityPreset] = useState('auto');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [privacyEnabled, setPrivacyEnabled] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [clipSync, setClipSync] = useState(false);
  const clipSyncRef = useRef(false);
  const [codecMode, setCodecMode] = useState('jpeg');
  const [h264Ready, setH264Ready] = useState(false);
  const codecModeRef = useRef('jpeg');
  const hiResRef = useRef(false);
  const h264ReadyRef = useRef(false);
  const hostVideoRef = useRef(false);
  const codecTouchedRef = useRef(false);
  const resyncTimerRef = useRef(0);
  const h264WatchdogRef = useRef(0);
  const [reconnectMsg, setReconnectMsg] = useState('');
  const [telemetry, setTelemetry] = useState({ rttMs: null, fps: 0, kbps: 0, channel: null });

  // High-frequency binary refs to avoid cloning megabytes into React state
  const latestFrameRef = useRef(null);
  const fsRootsRef = useRef([]);
  const dropRootsWaitersRef = useRef([]);
  const dropUploadAckRef = useRef(new Map());
  const dropUploadCancelRef = useRef(false);
  const [dropUploadProgress, setDropUploadProgress] = useState(null);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [pointerLockTrigger, setPointerLockTrigger] = useState(0);
  const phoneHubRef = useRef(null);
  const frameQueueRef = useRef([]);
  const [frameTick, setFrameTick] = useState(0);
  const framePaintRafRef = useRef(0);
  const scheduleFramePaint = () => {
    if (framePaintRafRef.current) return;
    framePaintRafRef.current = window.requestAnimationFrame(() => {
      framePaintRafRef.current = 0;
      setFrameTick((n) => n + 1);
    });
  };
  const ptyEventsRef = useRef([]);
  const [ptyTick, setPtyTick] = useState(0);
  const fsEventsRef = useRef([]);
  const [fsTick, setFsTick] = useState(0);
  const downloadsRef = useRef(new Map());

  const transportRef = useRef(null);
  const audioRef = useRef(null);
  const videoRef = useRef(null);
  if (!videoRef.current && typeof window !== 'undefined') {
    videoRef.current = new H264Player();
  }
  const audioEnabledRef = useRef(false);
  const qualityPresetRef = useRef('auto');
  const activeDisplayIdRef = useRef(0);
  const shellRef = useRef(null);
  const utf8Decoder = useRef(new TextDecoder());

  useEffect(() => {
    audioEnabledRef.current = audioEnabled;
  }, [audioEnabled]);
  useEffect(() => {
    qualityPresetRef.current = qualityPreset;
  }, [qualityPreset]);
  useEffect(() => {
    activeDisplayIdRef.current = activeDisplayId;
  }, [activeDisplayId]);
  useEffect(() => {
    clipSyncRef.current = clipSync;
  }, [clipSync]);
  useEffect(() => {
    codecModeRef.current = codecMode;
  }, [codecMode]);

  // Probe WebCodecs H.264 once; only then offer the switch in the HUD.
  useEffect(() => {
    let alive = true;
    H264Player.supported().then((ok) => {
      if (!alive) return;
      h264ReadyRef.current = ok;
      setH264Ready(ok);
      if (ok) maybeAutoCodec();
    });
    if (videoRef.current) {
      videoRef.current.onError = () => {
        if (codecModeRef.current === 'h264') {
          codecModeRef.current = 'jpeg';
          setCodecMode('jpeg');
          transportRef.current?.sendJson({ type: MSG.SCREEN_CONFIG, codec: 'jpeg' });
          notify('H.264 解码失败，已自动切回 JPEG');
        }
      };
    }
    return () => {
      alive = false;
    };
  }, []);

  const notify = (msg) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 2600);
  };

  // Prefer H.264 when both ends support it: ~10x lower bandwidth at native res.
  const maybeAutoCodec = () => {
    if (codecTouchedRef.current) return;
    if (!h264ReadyRef.current || !hostVideoRef.current) return;
    if (codecModeRef.current === 'h264') return;
    codecModeRef.current = 'h264';
    setCodecMode('h264');
    transportRef.current?.sendJson({ type: MSG.SCREEN_CONFIG, codec: 'h264' });
    armH264Watchdog();
  };

  const writeImageToLocalClipboard = async (base64, silent) => {
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        if (!silent) notify('已把远端图片复制到本机剪贴板');
        return;
      }
    } catch {
      // Clipboard image writes are denied on plain-HTTP LAN origins.
    }
    if (!silent) notify('远端剪贴板里是一张图片（当前环境无法写入本机剪贴板）');
  };

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    return () => {
      transportRef.current?.disconnect();
      audioRef.current?.destroy();
    };
  }, []);

  const ensureTransport = () => {
    if (transportRef.current) return transportRef.current;
    const t = new RemoteTransport({
      onLog: (line) => setLogs((prev) => [...prev.slice(-15), line]),
      onStatus: ({ status, detail }) => {
        if (status === 'reconnecting') {
          setReconnectMsg(detail || '正在自动重连...');
        } else if (status === 'connected') {
          setReconnectMsg('');
        } else if (status === 'disconnected') {
          setReconnectMsg('');
          setConnState('idle');
          setErrorMsg(detail || '连接已断开');
        }
      },
      onTelemetry: (stats) => setTelemetry(stats),
      onChannelUpgrade: (channel) => {
        setSessionInfo((prev) => (prev ? { ...prev, channel } : prev));
        notify(`链路已升级为 ${channel === 'webrtc' ? 'WebRTC P2P 直连' : channel}`);
      },
      onAuthenticated: (authInfo, channel) => {
        setReconnectMsg('');
        setConnState('connected');
        setSessionInfo({ ...authInfo, channel });
        setDisplays(authInfo.displays || []);
        const targetDisplay = authInfo.displays?.some((d) => d.id === activeDisplayIdRef.current)
          ? activeDisplayIdRef.current
          : (authInfo.displays?.[0]?.id ?? 0);
        setActiveDisplayId(targetDisplay);
        setPrivacyEnabled(Boolean(authInfo.privacyEnabled));
        setErrorMsg('');
        hostVideoRef.current = Boolean(authInfo.videoEncoder);

        const preset = QUALITY_PRESETS[qualityPresetRef.current] || QUALITY_PRESETS.auto;
        if (authInfo.permissions?.view !== false) {
          t.sendJson({
            type: MSG.SCREEN_START,
            displayId: targetDisplay,
            allowDirty: true,
            separateCursor: true,
            codec: codecModeRef.current === 'h264' ? 'h264' : 'jpeg',
            ...preset,
          });
        }
        if (audioEnabledRef.current && authInfo.permissions?.audio !== false) {
          t.sendJson({ type: MSG.AUDIO_START });
        }
        if (clipSyncRef.current && authInfo.permissions?.control !== false) {
          t.sendJson({ type: MSG.CLIPBOARD_WATCH, enabled: true });
        }
        maybeAutoCodec();
      },
      onScreenFrame: (meta, jpegBytes) => {
        // H.264 or separate-cursor unchanged heartbeat: forward geometry/cursor without wiping JPEG queue.
        if (meta?.video || meta?.unchanged) {
          const item = { meta, jpegBytes: null };
          if (!latestFrameRef.current) latestFrameRef.current = item;
          frameQueueRef.current.push(item);
          if (frameQueueRef.current.length > 24) frameQueueRef.current = frameQueueRef.current.slice(-24);
          scheduleFramePaint();
          return;
        }
        const frame = { meta, jpegBytes };
        latestFrameRef.current = frame;
        if (!meta?.dirty) {
          frameQueueRef.current = [frame];
        } else {
          frameQueueRef.current.push(frame);
          if (frameQueueRef.current.length > 24) {
            frameQueueRef.current = frameQueueRef.current.slice(-24);
            // A dropped patch frame leaves stale pixels behind: ask for a full frame.
            if (!resyncTimerRef.current) {
              resyncTimerRef.current = window.setTimeout(() => {
                resyncTimerRef.current = 0;
                const t = transportRef.current;
                t?.sendJson({ type: MSG.SCREEN_CONFIG, allowDirty: false });
                window.setTimeout(() => t?.sendJson({ type: MSG.SCREEN_CONFIG, allowDirty: true }), 120);
              }, 1200);
            }
          }
        }
        scheduleFramePaint();
      },
      onAudioFrame: (meta, pcmBytes) => {
        audioRef.current?.pushPcm16(meta, pcmBytes);
      },
      onVideoFrame: (meta, data) => {
        videoRef.current?.push(meta, data);
      },
      onPhoneVideoFrame: (meta, data) => {
        phoneHubRef.current?.onVideo?.(meta, data);
      },
      onPhoneAudioFrame: (meta, data) => {
        phoneHubRef.current?.onAudio?.(meta, data);
      },
      onPtyOutput: (id, payload) => {
        const text = utf8Decoder.current.decode(payload, { stream: true });
        ptyEventsRef.current.push({ kind: 'output', id, text });
        setPtyTick((n) => n + 1);
      },
      onFileDownloadChunk: (meta, payload) => {
        const { transferId, fileName, done } = meta;
        let rec = downloadsRef.current.get(transferId);
        if (!rec) {
          rec = { fileName: fileName || 'download.bin', chunks: [] };
          downloadsRef.current.set(transferId, rec);
        }
        if (payload.byteLength > 0) rec.chunks.push(new Uint8Array(payload));
        if (done) {
          downloadsRef.current.delete(transferId);
          const blob = new Blob(rec.chunks);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = rec.fileName;
          a.click();
          URL.revokeObjectURL(url);
          notify(`已下载: ${rec.fileName}`);
        }
      },
      onMessage: (msg) => {
        if (msg.type === MSG.DISPLAYS_INFO) {
          setDisplays(msg.displays || []);
        } else if (msg.type === MSG.SCREEN_CONFIG) {
          if (msg.videoError) {
            hostVideoRef.current = false;
            codecModeRef.current = 'jpeg';
            setCodecMode('jpeg');
            notify(`H.264 不可用（${msg.videoError}），继续使用 JPEG`);
          }
        } else if (msg.type === MSG.PTY_OPENED) {
          ptyEventsRef.current.push({ kind: 'opened', id: msg.id, mode: msg.mode });
          setPtyTick((n) => n + 1);
        } else if (msg.type === MSG.PTY_EXIT) {
          ptyEventsRef.current.push({ kind: 'exit', id: msg.id, code: msg.code });
          setPtyTick((n) => n + 1);
        } else if (msg.type === MSG.FS_RESULT || msg.type === MSG.FS_ERROR) {
          if (msg.op === 'roots' && Array.isArray(msg.roots)) {
            fsRootsRef.current = msg.roots;
            const waiters = dropRootsWaitersRef.current.splice(0);
            waiters.forEach((fn) => fn(msg.roots));
          }
          if ((msg.op === 'upload_ack' || msg.op === 'upload_done') && msg.transferId && dropUploadAckRef.current.has(msg.transferId)) {
            const resolve = dropUploadAckRef.current.get(msg.transferId);
            dropUploadAckRef.current.delete(msg.transferId);
            resolve(msg);
          }
          fsEventsRef.current.push(msg);
          setFsTick((n) => n + 1);
        } else if (msg.type === MSG.CLIPBOARD_DATA) {
          if (msg.watch) return; // ack of the watch toggle
          const text = msg.text || '';
          if (msg.imageBase64) {
            void writeImageToLocalClipboard(msg.imageBase64, Boolean(msg.auto));
            return;
          }
          if (text && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
            if (!msg.auto) notify('已拉取远端剪贴板到本地');
            return;
          }
          if (!msg.auto) notify(text ? `远端剪贴板: ${text.slice(0, 40)}` : '远端剪贴板为空');
        } else if (msg.type === MSG.PHONE_RESULT) {
          phoneHubRef.current?.onMessage?.(msg);
        }
      },
    });
    transportRef.current = t;
    return t;
  };

  const handleConnect = async ({ mode, serverUrl, deviceId, pin, fallbackUrl = '' }) => {
    setErrorMsg('');
    setLogs([]);
    setConnState('connecting');
    latestFrameRef.current = null;
    ptyEventsRef.current = [];
    fsEventsRef.current = [];

    const t = ensureTransport();
    try {
      await t.connect({ mode, serverUrl, deviceId, pin, fallbackUrl });
      const tunnelUrl = t.sessionInfo?.tunnelUrl || fallbackUrl || (String(serverUrl).startsWith('https://') ? serverUrl : '');
      saveRecentDevice({
        mode,
        serverUrl,
        deviceId: deviceId || t.sessionInfo?.deviceId,
        deviceName: t.sessionInfo?.deviceName,
        pin,
        tunnelUrl,
      });
    } catch (err) {
      setConnState('idle');
      setErrorMsg(err.message || '连接失败');
    }
  };

  const handleDisconnect = () => {
    transportRef.current?.disconnect(true);
    hiResRef.current = false;
    audioRef.current?.stop();
    setAudioEnabled(false);
    setPrivacyEnabled(false);
    setImmersive(false);
    setReconnectMsg('');
    setConnState('idle');
    setSessionInfo(null);
    latestFrameRef.current = null;
    frameQueueRef.current = [];
  };

  const handleToggleAudio = async () => {
    if (!audioRef.current) {
      audioRef.current = new RemoteAudioPlayer();
    }
    if (!audioEnabled) {
      const ok = await audioRef.current.start();
      if (!ok) {
        notify('当前浏览器不支持音频播放');
        return;
      }
      const opusOk = await RemoteAudioPlayer.supportedOpus();
      transportRef.current?.sendJson({
        type: MSG.AUDIO_START,
        codec: opusOk ? 'opus' : 'ima_adpcm',
      });
      setAudioEnabled(true);
      notify(opusOk ? '已开启远端系统声音 (Opus)' : '已开启远端系统声音');
    } else {
      audioRef.current.stop();
      transportRef.current?.sendJson({ type: MSG.AUDIO_STOP });
      setAudioEnabled(false);
      notify('已静音远端声音');
    }
  };

  const handleTogglePrivacy = () => {
    const next = !privacyEnabled;
    transportRef.current?.sendJson({ type: MSG.PRIVACY_SET, enabled: next });
    setPrivacyEnabled(next);
    notify(next ? '已请求开启被控端防窥黑屏' : '已关闭被控端防窥黑屏');
  };

  const handleDropFiles = async (fileList) => {
    const t = transportRef.current;
    if (!t || !fileList?.length) return;
    let roots = fsRootsRef.current;
    if (!roots || roots.length === 0) {
      roots = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve([]), 4000);
        dropRootsWaitersRef.current.push((r) => {
          clearTimeout(timer);
          resolve(r);
        });
        t.sendJson({ type: MSG.FS_ROOTS, reqId: `drop-${Date.now()}` });
      });
    }
    const targetDir = (roots.find((r) => /desktop|桌面/i.test(r.name || '')) || roots[0])?.path;
    if (!targetDir) {
      notify('未能获取远端目标目录');
      return;
    }
    const CHUNK = 256 * 1024;
    const filesArr = Array.from(fileList);
    dropUploadCancelRef.current = false;
    try {
      for (let idx = 0; idx < filesArr.length; idx += 1) {
        if (dropUploadCancelRef.current) break;
        const file = filesArr[idx];
        const transferId = `drop-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setDropUploadProgress({
          fileName: file.name,
          sent: 0,
          total: file.size,
          index: idx + 1,
          count: filesArr.length,
        });
        const ackPromise = new Promise((resolve) => {
          dropUploadAckRef.current.set(transferId, resolve);
          setTimeout(() => {
            if (dropUploadAckRef.current.has(transferId)) {
              dropUploadAckRef.current.delete(transferId);
              resolve(null);
            }
          }, 5000);
        });
        t.sendJson({
          type: MSG.FS_UPLOAD_START,
          transferId,
          dirPath: targetDir,
          fileName: file.name,
          total: file.size,
          offset: 0,
        });
        const ack = await ackPromise;
        let offset = Number.isFinite(ack?.offset) ? ack.offset : 0;
        while (offset < file.size || file.size === 0) {
          if (dropUploadCancelRef.current) {
            t.sendBinary(FRAME_KIND.FILE_UP, { transferId, done: true }, new Uint8Array(0));
            notify(`已取消上传 ${file.name}`);
            return;
          }
          const slice = file.slice(offset, offset + CHUNK);
          const buf = new Uint8Array(await slice.arrayBuffer());
          offset += buf.byteLength;
          const done = offset >= file.size;
          t.sendBinary(FRAME_KIND.FILE_UP, { transferId, done }, buf);
          setDropUploadProgress({
            fileName: file.name,
            sent: offset,
            total: file.size,
            index: idx + 1,
            count: filesArr.length,
          });
          if (done) break;
        }
        notify(`已上传 ${file.name} -> ${targetDir}`);
      }
    } finally {
      setDropUploadProgress(null);
    }
  };

  const handleZoomChange = (z) => {
    const want = z > 2.5;
    if (want === hiResRef.current) return;
    hiResRef.current = want;
    transportRef.current?.sendJson({ type: MSG.SCREEN_CONFIG, hiRes: want });
  };

  // Safety net: if H.264 never produces a decoded frame (bad bitstream, missing
  // decoder), fall back to JPEG instead of leaving the user with a black screen.
  const armH264Watchdog = () => {
    window.clearTimeout(h264WatchdogRef.current);
    h264WatchdogRef.current = window.setTimeout(() => {
      h264WatchdogRef.current = 0;
      if (codecModeRef.current !== 'h264') return;
      if ((videoRef.current?.decoded || 0) > 0) return;
      codecModeRef.current = 'jpeg';
      setCodecMode('jpeg');
      transportRef.current?.sendJson({ type: MSG.SCREEN_CONFIG, codec: 'jpeg' });
      notify('H.264 无画面，已自动切回 JPEG');
    }, 3500);
  };

  const handleChangeCodec = (next) => {
    codecTouchedRef.current = true;
    const mode = next === 'h264' && h264Ready ? 'h264' : 'jpeg';
    if (mode === 'h264') armH264Watchdog();
    setCodecMode(mode);
    codecModeRef.current = mode;
    videoRef.current?.reset();
    transportRef.current?.sendJson({ type: MSG.SCREEN_CONFIG, codec: mode });
    notify(mode === 'h264' ? '已切换 H.264（需宿主装有 ffmpeg）' : '已切回 JPEG');
  };

  const handleToggleClipSync = () => {
    const next = !clipSync;
    setClipSync(next);
    transportRef.current?.sendJson({ type: MSG.CLIPBOARD_WATCH, enabled: next });
    notify(next ? '已开启剪贴板自动同步（远端复制即到本机）' : '已关闭剪贴板自动同步');
  };

  const handleChangeDisplay = (displayId) => {
    setActiveDisplayId(displayId);
    transportRef.current?.sendJson({ type: MSG.SCREEN_CONFIG, displayId });
  };

  const handleChangeQuality = (presetKey) => {
    setQualityPreset(presetKey);
    const preset = QUALITY_PRESETS[presetKey] || QUALITY_PRESETS.balanced;
    transportRef.current?.sendJson({ type: MSG.SCREEN_CONFIG, ...preset });
  };

  const handleSyncClipboard = async () => {
    // Images first so screenshots / copied pictures round-trip too.
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types?.find((t) => t.startsWith('image/'));
          if (!imageType) continue;
          const blob = await item.getType(imageType);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
          transportRef.current?.sendJson({ type: MSG.CLIPBOARD_SET, imageBase64: btoa(binary) });
          notify('已推送本机图片到远端剪贴板');
          return;
        }
      }
    } catch {}
    try {
      if (navigator.clipboard?.readText) {
        const local = await navigator.clipboard.readText();
        if (local) {
          transportRef.current?.sendJson({ type: MSG.CLIPBOARD_SET, text: local });
          notify('已推送本地剪贴板到远端');
          return;
        }
      }
    } catch {}
    transportRef.current?.sendJson({ type: MSG.CLIPBOARD_GET });
  };

  const handleSendHotkey = (vk, mods = {}) => {
    if (sessionInfo?.permissions?.control === false) return;
    transportRef.current?.sendJson({
      type: MSG.INPUT_KEY,
      action: 'tap',
      vk,
      ctrl: Boolean(mods.ctrl),
      alt: Boolean(mods.alt),
      shift: Boolean(mods.shift),
      meta: Boolean(mods.meta),
    });
  };

  const handleToggleFullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      try {
        window.screen?.orientation?.unlock?.();
      } catch {}
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.()
        .then(() => {
          if (env.tier === 'phone') {
            window.screen?.orientation?.lock?.('landscape').catch(() => {});
          }
        })
        .catch(() => {});
    }
  };

  if (connState !== 'connected') {
    const desktopApi = typeof window !== 'undefined' ? window.remoteDeckDesktop : null;
    return (
      <ConnectView
        tier={env.tier}
        onConnect={handleConnect}
        connecting={connState === 'connecting'}
        errorMsg={errorMsg}
        logs={logs}
        layoutOverride={layoutOverride}
        onChangeLayoutOverride={setLayoutOverride}
        desktopApi={desktopApi}
      />
    );
  }

  const effectiveTab = env.tier !== 'desktop' && activeTab === 'split' ? 'screen' : activeTab;

  return (
    <div className={`workspace-shell tier-${env.tier}`} ref={shellRef}>
      {!immersive && (
        <TopHud
          tier={env.tier}
          sessionInfo={sessionInfo}
          telemetry={telemetry}
          activeTab={effectiveTab}
          onChangeTab={setActiveTab}
          displays={displays}
          activeDisplayId={activeDisplayId}
          onChangeDisplay={handleChangeDisplay}
          qualityPreset={qualityPreset}
          onChangeQuality={handleChangeQuality}
          audioEnabled={audioEnabled}
          onToggleAudio={handleToggleAudio}
          privacyEnabled={privacyEnabled}
          onTogglePrivacy={handleTogglePrivacy}
          immersive={immersive}
          onToggleImmersive={() => setImmersive((v) => !v)}
          layoutOverride={layoutOverride}
          onChangeLayoutOverride={setLayoutOverride}
          onSyncClipboard={handleSyncClipboard}
          clipSync={clipSync}
          onToggleClipSync={handleToggleClipSync}
          codecMode={codecMode}
          h264Ready={h264Ready}
          onChangeCodec={handleChangeCodec}
          onSendHotkey={handleSendHotkey}
          pointerLocked={pointerLocked}
          onTogglePointerLock={() => setPointerLockTrigger((n) => n + 1)}
          onToggleFullscreen={handleToggleFullscreen}
          onDisconnect={handleDisconnect}
          permissions={sessionInfo?.permissions}
        />
      )}

      {reconnectMsg && <div className="toast-banner">{reconnectMsg}</div>}
      {!reconnectMsg && toast && <div className="toast-banner">{toast}</div>}

      <main className={`workspace-main mode-${effectiveTab}`}>
        {(effectiveTab === 'screen' || effectiveTab === 'split') && (
          <div className="pane-primary">
            <RemoteCanvas
              tier={env.tier}
              isTouch={env.isTouch}
              transport={transportRef.current}
              frameRef={latestFrameRef}
              frameQueueRef={frameQueueRef}
              frameTick={frameTick}
              videoRef={videoRef}
              canControl={sessionInfo?.permissions?.control !== false}
              immersive={immersive}
              onToggleImmersive={() => setImmersive((v) => !v)}
              onDisconnect={handleDisconnect}
              onZoomChange={handleZoomChange}
              onDropFiles={handleDropFiles}
              dropUploadProgress={dropUploadProgress}
              onCancelDropUpload={() => {
                dropUploadCancelRef.current = true;
              }}
              pointerLockTrigger={pointerLockTrigger}
              onPointerLockChange={setPointerLocked}
              onNotify={notify}
            />
          </div>
        )}

        {effectiveTab === 'split' && (
          <div className="pane-secondary">
            <TerminalPanel
              tier={env.tier}
              transport={transportRef.current}
              ptyEventsRef={ptyEventsRef}
              ptyTick={ptyTick}
            />
          </div>
        )}

        {effectiveTab === 'terminal' && (
          <div className="pane-full">
            <TerminalPanel
              tier={env.tier}
              transport={transportRef.current}
              ptyEventsRef={ptyEventsRef}
              ptyTick={ptyTick}
            />
          </div>
        )}

        {effectiveTab === 'files' && (
          <div className="pane-full">
            <FilePanel
              tier={env.tier}
              transport={transportRef.current}
              fsEventsRef={fsEventsRef}
              fsTick={fsTick}
              onNotify={notify}
            />
          </div>
        )}

        {effectiveTab === 'phones' && (
          <div className="pane-full" style={{ padding: '14px', overflowY: 'auto' }}>
            <PhoneMirrorPane transport={transportRef.current} phoneHubRef={phoneHubRef} />
          </div>
        )}
      </main>
    </div>
  );
}
