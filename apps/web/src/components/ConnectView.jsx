import React, { useEffect, useMemo, useState } from 'react';
import { toHttpBase } from '../lib/transport.js';
import {
  HostHeroPanel,
  HostNetworkPanel,
  HostSettingsPanel,
  useHostDesk,
} from './HostDeskCard.jsx';
import { DeskHubView } from './DeskHubView.jsx';
import { PhoneMirrorPane } from './PhoneMirrorPane.jsx';
import AccountPane from './AccountPane.jsx';
import { accountApiBase, setAccountApiBase } from '../lib/account.js';

const STORAGE_RECENT_KEY = 'remotedeck.recent.v1';

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveRecentDevice(entry) {
  try {
    const list = loadRecent().filter((item) => item.deviceId !== entry.deviceId);
    list.unshift({ ...entry, updatedAt: Date.now() });
    localStorage.setItem(STORAGE_RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {}
}

function NavIcon({ name }) {
  switch (name) {
    case 'home':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="14" rx="2.5" />
          <path d="M8 21h8M12 18v3" />
        </svg>
      );
    case 'devices':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="13" height="10" rx="2" />
          <path d="M7 18h5M9.5 14v4" />
          <rect x="16" y="9" width="5" height="11" rx="1.2" />
        </svg>
      );
    case 'deskhub':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="8" height="8" rx="1.6" />
          <rect x="13" y="3" width="8" height="8" rx="1.6" />
          <rect x="3" y="13" width="8" height="8" rx="1.6" />
          <rect x="13" y="13" width="8" height="8" rx="1.6" />
        </svg>
      );
    case 'phones':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="2" width="10" height="20" rx="2" />
          <path d="M11 18h2" />
        </svg>
      );
    case 'account':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="3.6" />
          <path d="M4.5 20c1.6-3.4 4.3-5 7.5-5s5.9 1.6 7.5 5" />
        </svg>
      );
    case 'network':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="5" r="2.5" />
          <circle cx="5" cy="18" r="2.5" />
          <circle cx="19" cy="18" r="2.5" />
          <path d="M10.8 7.2L6.2 15.8M13.2 7.2l4.6 8.6M7.5 18h9" />
        </svg>
      );
    case 'settings':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
}

export function ConnectView({
  tier,
  onConnect,
  connecting,
  errorMsg,
  logs,
  layoutOverride,
  onChangeLayoutOverride,
  desktopApi,
}) {
  const initialQuery = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const initialMode = initialQuery?.get('mode') === 'direct' ? 'direct' : 'relay';
  const initialDeviceId = initialQuery?.get('id') || '';
  const initialPin = initialQuery?.get('pin') || '';
  const [mode, setMode] = useState(initialMode);
  const [serverUrl, setServerUrl] = useState(() =>
    typeof window !== 'undefined' ? window.location.origin : '',
  );
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [pin, setPin] = useState(initialPin);
  const [devices, setDevices] = useState([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [recent, setRecent] = useState(() => loadRecent());
  const [recentOnlineMap, setRecentOnlineMap] = useState({});
  const [promptTarget, setPromptTarget] = useState(null);
  const [promptPin, setPromptPin] = useState('');
  const [workspaceTab, setWorkspaceTab] = useState('home'); // 'home' | 'devices' | 'deskhub' | 'network' | 'settings'
  const [showAdvancedRelay, setShowAdvancedRelay] = useState(false);

  const hostState = useHostDesk(desktopApi);

  // The server field is intentionally hidden: the page origin is the server.
  // Inside the desktop app the origin is loopback, so fall back to the relay the
  // host itself is connected to (and remember it for account calls).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(window.location.hostname);
    if (!isLoopback) return;
    const relay = hostState.hostStatus?.relayUrl;
    if (!relay) return;
    const http = String(relay).replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/ws$/i, '');
    setAccountApiBase(http);
    setServerUrl((cur) => (cur && !/^(https?:\/\/)?(127\.0\.0\.1|localhost)(:|\/|$)/i.test(cur) ? cur : http));
  }, [hostState.hostStatus?.relayUrl]);

  useEffect(() => {
    if (initialPin && typeof window !== 'undefined') {
      try {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('pin');
        window.history.replaceState({}, '', cleanUrl.toString());
      } catch {}
      if (initialMode === 'direct' || initialDeviceId) {
        onConnect({
          mode: initialMode,
          serverUrl: window.location.origin,
          deviceId: initialDeviceId.trim(),
          pin: initialPin.trim(),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const probeRecentStatus = async (recentList) => {
    if (!Array.isArray(recentList) || recentList.length === 0) return;
    const entries = await Promise.all(
      recentList.map(async (item) => {
        const candidates = [item?.serverUrl, item?.tunnelUrl].filter(Boolean);
        for (const url of candidates) {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 1800);
            const base = toHttpBase(url);
            const res = await fetch(`${base}/api/devices`, { signal: ctrl.signal });
            clearTimeout(t);
            if (!res.ok) continue;
            const data = await res.json();
            const hit = (data.devices || []).find((d) => d.deviceId === item.deviceId);
            if (hit && hit.online !== false) {
              return [item.deviceId, true];
            }
          } catch {}
        }
        return [item?.deviceId, false];
      }),
    );
    const nextMap = {};
    for (const [id, ok] of entries) {
      if (id) nextMap[id] = ok;
    }
    setRecentOnlineMap(nextMap);
  };

  const fetchDevices = async () => {
    setLoadingDevices(true);
    try {
      let selfId = '';
      if (desktopApi?.getHostStatus) {
        try {
          const st = await desktopApi.getHostStatus();
          selfId = st?.deviceId || '';
        } catch {}
      }
      const base = toHttpBase(serverUrl);
      const endpoint = desktopApi ? `${base}/api/lan-devices` : `${base}/api/devices`;
      const res = await fetch(endpoint);
      if (res.ok) {
        const data = await res.json();
        const rawList = data.devices || [];
        const list = selfId ? rawList.filter((d) => d.deviceId !== selfId) : rawList;
        setDevices(list);
        if (data.service === 'remote-deck-host' && !initialQuery?.get('mode')) {
          setMode('direct');
        }
        if (list.length === 1 && !deviceId) {
          setDeviceId(list[0].deviceId);
        }
      }
    } catch {
      setDevices([]);
    } finally {
      setLoadingDevices(false);
    }
    probeRecentStatus(recent);
  };

  useEffect(() => {
    fetchDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const looksLikeAddress = (val) => {
    const s = String(val || '').trim().toLowerCase();
    return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ws://') || s.startsWith('wss://') || s.includes('.') || s.includes(':');
  };

  const relayBase = () => {
    const base = (typeof accountApiBase === 'function' ? accountApiBase() : '') || serverUrl.trim();
    return String(base || '').replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/ws$/i, '');
  };

  /** LAN address for a device when we can reach it directly, otherwise empty. */
  const lanUrlFor = (dev) => {
    const eps = dev?.lanEndpoints || [];
    if (!eps.length) return '';
    const host = (() => {
      try {
        return new URL(toHttpBase(serverUrl || window.location.origin)).hostname;
      } catch {
        return window.location.hostname;
      }
    })();
    const sameSubnet = eps.find((ep) => {
      if (!ep.ip || ep.virtual) return false;
      const a = ep.ip.split('.');
      const b = String(host || '').split('.');
      return a.length === 4 && b.length === 4 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    });
    if (sameSubnet) return sameSubnet.httpUrl || sameSubnet.wsUrl || '';
    const nonVirtual = eps.find((ep) => !ep.virtual);
    // A device on the same LAN answers on a plain IP; anything else goes relay.
    return nonVirtual && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(nonVirtual.ip || '')
      ? (nonVirtual.httpUrl || nonVirtual.wsUrl || '')
      : '';
  };

  const routeFor = (dev) => {
    const lan = lanUrlFor(dev);
    if (lan) return { mode: 'direct', serverUrl: lan, fallbackUrl: dev?.tunnelUrl || relayBase() };
    if (dev?.tunnelUrl) return { mode: 'direct', serverUrl: dev.tunnelUrl, fallbackUrl: relayBase() };
    return { mode: 'relay', serverUrl: relayBase(), fallbackUrl: '' };
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const rawId = deviceId.trim();
    const rawPin = pin.trim();
    if (!rawPin) return;

    if (looksLikeAddress(rawId)) {
      onConnect({
        mode: 'direct',
        serverUrl: rawId,
        deviceId: '',
        pin: rawPin,
      });
      return;
    }

    const matchedDev = devices.find((d) => d.deviceId === rawId);
    const matchedRecent = recent.find((r) => r.deviceId === rawId);
    const route = matchedDev
      ? routeFor(matchedDev)
      : matchedRecent
        ? {
            mode: matchedRecent.mode === 'direct' && matchedRecent.serverUrl ? 'direct' : 'relay',
            serverUrl: matchedRecent.serverUrl || relayBase(),
            fallbackUrl: matchedRecent.tunnelUrl || '',
          }
        : { mode: 'relay', serverUrl: relayBase(), fallbackUrl: '' };

    if (!route.serverUrl) return;
    setMode(route.mode);
    setServerUrl(route.serverUrl);
    onConnect({
      mode: route.mode,
      serverUrl: route.serverUrl,
      deviceId: rawId,
      pin: rawPin,
      fallbackUrl: route.fallbackUrl,
    });
  };

  const handlePickDevice = (dev) => {
    const nextId = dev.deviceId;
    setDeviceId(nextId);
    const route = routeFor(dev);
    const nextMode = route.mode;
    const nextServer = route.serverUrl || serverUrl;
    setMode(nextMode);
    if (nextServer) setServerUrl(nextServer);
    const savedPin =
      (deviceId === nextId && pin.trim()) ||
      recent.find((r) => r.deviceId === nextId && r.pin)?.pin ||
      '';
    if (savedPin) {
      setPin(savedPin);
      onConnect({
        mode: nextMode,
        serverUrl: nextServer.trim(),
        deviceId: nextId,
        pin: savedPin,
        fallbackUrl: dev.tunnelUrl || '',
      });
      return;
    }
    setPromptPin(pin);
    setPromptTarget({
      deviceId: nextId,
      deviceName: dev.deviceName || nextId,
      mode: nextMode,
      serverUrl: nextServer.trim(),
      fallbackUrl: dev.tunnelUrl || '',
    });
  };

  const handlePickRecent = (item) => {
    const nextMode = item.mode || 'relay';
    const nextServer = item.serverUrl || item.tunnelUrl || serverUrl;
    const nextId = item.deviceId || '';
    const fallbackUrl = item.tunnelUrl || '';
    setMode(nextMode);
    if (item.serverUrl) setServerUrl(item.serverUrl);
    if (item.deviceId) setDeviceId(item.deviceId);
    if (item.pin) {
      setPin(item.pin);
      onConnect({
        mode: nextMode,
        serverUrl: nextServer.trim(),
        deviceId: nextId,
        pin: item.pin,
        fallbackUrl,
      });
      return;
    }
    setPromptPin(pin);
    setPromptTarget({
      deviceId: nextId,
      deviceName: item.deviceName || nextId,
      mode: nextMode,
      serverUrl: nextServer.trim(),
      fallbackUrl,
    });
  };

  const navItems = useMemo(() => {
    const items = [
      { id: 'home', label: '远程控制', badge: null },
      { id: 'devices', label: '设备列表', badge: devices.length > 0 ? devices.length : null },
      { id: 'deskhub', label: '桌面墙', badge: Math.max(devices.length, recent.length) || null },
      { id: 'phones', label: '手机反控', badge: null },
      { id: 'account', label: '我的', badge: null },
    ];
    if (desktopApi) {
      items.push({
        id: 'network',
        label: '连接方式',
        dotOnline: Boolean(hostState.hostStatus?.tsnet?.tailscaleIp || hostState.hostStatus?.tunnelState === 'ready' || hostState.hostStatus?.relayConnected),
      });
      items.push({ id: 'settings', label: '设置与 AI', badge: null });
    }
    return items;
  }, [desktopApi, devices.length, recent.length, hostState.hostStatus]);

  const [accountDevices, setAccountDevices] = useState([]);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('rd_account_token') : '';
    if (!token) { setAccountDevices([]); return undefined; }
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${accountApiBase()}/api/auth/devices`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (alive && data.ok) setAccountDevices(data.devices || []);
      } catch {}
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const filteredDevices = useMemo(() => {
    const q = deviceSearch.trim().toLowerCase();
    const acctIds = new Set(accountDevices.map((d) => d.deviceId));
    let list = devices.filter((d) => !acctIds.has(d.deviceId));
    if (!q) return list;
    return list.filter(
      (d) =>
        (d.deviceName || '').toLowerCase().includes(q) ||
        (d.deviceId || '').toLowerCase().includes(q) ||
        (d.platform || '').toLowerCase().includes(q),
    );
  }, [devices, deviceSearch, accountDevices]);

  const renderConnectControlCard = () => (
    <section className="rd-card rd-connect-hero">
      <div className="rd-card-head">
        <div className="rd-title-group">
          <div>
            <h2>连接</h2>
          </div>
        </div>
        <div className="qr-tabs" style={{ width: 'auto' }}>
          <button type="button" className="qr-tab" onClick={fetchDevices}>
            刷新
          </button>
        </div>
      </div>

      <form className="connect-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>设备识别码或口令</span>
          <input
            type="text"
            className="rd-hero-input"
            value={deviceId}
            onChange={(e) => {
              const v = e.target.value;
              if (v.includes('://') && v.includes('?')) {
                try {
                  const u = new URL(v.trim());
                  const m = u.searchParams.get('mode');
                  const id = u.searchParams.get('id');
                  const p = u.searchParams.get('pin');
                  setServerUrl(u.origin);
                  if (m === 'direct' || m === 'relay') setMode(m);
                  if (id) setDeviceId(id.toUpperCase());
                  else setDeviceId(u.origin);
                  if (p) setPin(p.toUpperCase());
                  return;
                } catch {}
              }
              setDeviceId(looksLikeAddress(v) ? v.trim() : v.toUpperCase());
            }}
            placeholder="RD-0000-0000"
            required={mode === 'relay'}
          />
        </label>

        <label className="field">
          <span>访问密码</span>
          <input
            type="password"
            className="rd-hero-input"
            value={pin}
            onChange={(e) => setPin(e.target.value.toUpperCase())}
            placeholder="8 位密码"
            autoComplete="current-password"
            required
          />
        </label>

        {errorMsg && <div className="alert-error">{errorMsg}</div>}

        <button type="submit" className="btn-primary btn-lg rd-connect-cta" disabled={connecting}>
          {connecting ? '连接中...' : '连接'}
        </button>
      </form>

      {logs.length > 0 && (
        <div className="connect-logs">
          {logs.slice(-4).map((line, i) => (
            <div key={i} className="log-line">{line}</div>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="recent-section">
          <div className="rd-recent-head">
            <h3>最近控制过</h3>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setWorkspaceTab('devices')}>
              全部设备 →
            </button>
          </div>
          <div className="recent-chips">
            {recent.slice(0, 5).map((item) => (
              <button
                key={item.deviceId}
                type="button"
                className="chip-btn"
                onClick={() => handlePickRecent(item)}
              >
                <span className={`dot ${recentOnlineMap[item.deviceId] ? 'online' : ''}`} />
                <span>{item.deviceName || item.deviceId}</span>
                <small className="rd-chip-id">{item.deviceId}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );

  const renderDeviceCard = (dev) => (
    <article
      key={dev.deviceId}
      className={`rd-device-card ${deviceId === dev.deviceId ? 'selected' : ''}`}
      onClick={() => handlePickDevice(dev)}
    >
      <div className="rd-device-card-top">
        <div className="rd-device-title-col">
          <div className="device-title">
            <span className={`dot ${dev.online ? 'online' : ''}`} />
            <strong>{dev.deviceName || dev.deviceId}</strong>
          </div>
          <div className="device-sub">
            <span>{dev.deviceId}</span>
          </div>
        </div>
      </div>

      <div className="rd-device-card-foot">
        <span className="rd-device-status-txt">{dev.online !== false ? '在线' : '离线'}</span>
        <button
          type="button"
          className="btn-primary btn-xs"
          onClick={(e) => {
            e.stopPropagation();
            handlePickDevice(dev);
          }}
        >
          立即远程
        </button>
      </div>
    </article>
  );

  return (
    <div className={`connect-shell rd-app-shell tier-${tier}`}>
      <aside className="rd-sidebar">
        <div className="rd-brand">
          <img src="/icon.svg" alt="RemoteDeck" className="brand-icon" />
          <div className="rd-brand-text">
            <strong>RemoteDeck</strong>
            <span>远程控制</span>
          </div>
        </div>

        <nav className="rd-nav" aria-label="主导航">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rd-nav-item ${workspaceTab === item.id ? 'active' : ''}`}
              onClick={() => setWorkspaceTab(item.id)}
            >
              <span className="rd-nav-icon">
                <NavIcon name={item.id} />
              </span>
              <span className="rd-nav-label">{item.label}</span>
              {item.badge != null && <span className="rd-nav-badge">{item.badge}</span>}
              {item.dotOnline && <span className="dot online" />}
            </button>
          ))}
        </nav>

        <div className="rd-sidebar-foot">
          {hostState.hostStatus ? (
            <div className="rd-self-pill">
              <span className="dot online" />
              <div className="rd-self-info">
                <strong>{hostState.hostStatus.deviceId}</strong>
                <small>{hostState.hostStatus.elevated ? '管理员模式' : '标准权限'}</small>
              </div>
            </div>
          ) : (
            <div className="rd-self-pill">
              <span className="dot online" />
              <div className="rd-self-info">
                <strong>Web 控制端</strong>
                <small>在线</small>
              </div>
            </div>
          )}

          <div className="rd-tier-row">
            <select
              className="compact-select"
              value={layoutOverride}
              onChange={(e) => onChangeLayoutOverride(e.target.value)}
              aria-label="界面适配模式"
            >
              <option value="auto">自适应</option>
              <option value="desktop">桌面</option>
              <option value="tablet">平板</option>
              <option value="phone">手机</option>
            </select>
          </div>
        </div>
      </aside>

      <main className="rd-main">
        {tier === 'phone' && (
          <header className="rd-mobile-header">
            <div className="brand-row">
              <img src="/icon.svg" alt="RemoteDeck" className="brand-icon" />
              <div>
                <h1>RemoteDeck</h1>
                <p>远程控制</p>
              </div>
            </div>
            <div className="tier-pill-group">
              <span className="tier-badge">{tier.toUpperCase()}</span>
              <select
                className="compact-select"
                value={layoutOverride}
                onChange={(e) => onChangeLayoutOverride(e.target.value)}
                aria-label="界面适配模式"
              >
                <option value="auto">自动</option>
                <option value="desktop">桌面</option>
                <option value="tablet">平板</option>
                <option value="phone">手机</option>
              </select>
            </div>
          </header>
        )}

        <div className="rd-main-scroll">
          {workspaceTab === 'home' && (
            <div className="rd-section-stack">
              <div className={`rd-hero-grid ${desktopApi ? 'has-host' : 'client-only'}`}>
                {desktopApi ? (
                  <HostHeroPanel
                    desktopApi={desktopApi}
                    state={hostState}
                    onOpenSection={(sec) => setWorkspaceTab(sec)}
                  />
                ) : (
                  <section className="rd-card devices-card">
                    <div className="rd-card-head">
                      <div className="rd-title-group">
                        <div>
                          <h2>设备 ({devices.length})</h2>
                        </div>
                      </div>
                      <button type="button" className="btn-secondary btn-xs" onClick={fetchDevices}>
                        {loadingDevices ? '扫描中...' : '刷新'}
                      </button>
                    </div>
                    {devices.length === 0 ? (
                      <div className="empty-box">
                        <p>没有在线设备</p>
                        <small>输入设备 ID 或扫码</small>
                      </div>
                    ) : (
                      <div className="device-list">
                        {devices.map((dev) => (
                          <div
                            key={dev.deviceId}
                            className={`device-item ${deviceId === dev.deviceId ? 'selected' : ''}`}
                            onClick={() => handlePickDevice(dev)}
                          >
                            <div className="device-main">
                              <div className="device-title">
                                <span className={`dot ${dev.online ? 'online' : ''}`} />
                                <strong>{dev.deviceName || dev.deviceId}</strong>
                              </div>
                              <div className="device-sub">
                                <span>{dev.deviceId}</span>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="btn-primary btn-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePickDevice(dev);
                              }}
                            >
                              连接
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}

                {renderConnectControlCard()}
              </div>

              {desktopApi && (
                <section className="rd-card rd-quick-devices">
                  <div className="rd-card-head">
                    <div className="rd-title-group">
                      <div>
                        <h3>设备 ({devices.length})</h3>
                      </div>
                    </div>
                    <div className="rd-head-actions">
                      <button type="button" className="btn-secondary btn-xs" onClick={fetchDevices}>
                        {loadingDevices ? '扫描中...' : '扫描'}
                      </button>
                      <button type="button" className="btn-ghost btn-xs" onClick={() => setWorkspaceTab('devices')}>
                        查看全部 →
                      </button>
                    </div>
                  </div>
                  {devices.length === 0 ? (
                    <div className="empty-box rd-compact-empty">
                      <span>暂未发现其他在线主机；可直接把左侧设备代码发给控制端，或在上方输入目标识别码发起远控。</span>
                    </div>
                  ) : (
                    <div className="rd-device-grid">
                      {devices.slice(0, 4).map(renderDeviceCard)}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {workspaceTab === 'devices' && (
            <div className="rd-section-stack">
              <div className="rd-page-head">
                <div>
                  <h2>设备与历史</h2>
                </div>
                <div className="rd-head-actions">
                  <input
                    type="search"
                    className="deskhub-search"
                    value={deviceSearch}
                    onChange={(e) => setDeviceSearch(e.target.value)}
                    placeholder="搜索设备名 / ID / 平台..."
                  />
                  <button type="button" className="btn-primary btn-xs" onClick={fetchDevices}>
                    {loadingDevices ? '扫描中...' : '刷新扫描'}
                  </button>
                </div>
              </div>

              {accountDevices.length > 0 && (
                <section className="rd-card">
                  <div className="rd-card-head">
                    <h3>我的设备 ({accountDevices.length})</h3>
                  </div>
                  <div className="device-list">
                    {accountDevices.map((dev) => (
                      <div key={dev.deviceId} className="device-item">
                        <div className="device-main">
                          <div className="device-title">
                            <span className={`dot ${dev.online ? 'online' : ''}`} />
                            <strong>{dev.name || dev.deviceId}</strong>
                          </div>
                          <div className="device-sub">
                            <span>{dev.deviceId}</span>
                            <span>{dev.online ? '在线' : '离线'}</span>
                          </div>
                        </div>
                        {dev.deviceId === hostState.hostStatus?.deviceId ? (
                          <span className="rd-self-badge">本机</span>
                        ) : (
                          <button
                            type="button"
                            className="btn-primary btn-xs"
                            disabled={!dev.online}
                            onClick={() => {
                              setDeviceId(dev.deviceId);
                              setPromptTarget({ deviceId: dev.deviceId, deviceName: dev.name || dev.deviceId, mode: 'relay', serverUrl: serverUrl.trim(), fallbackUrl: '' });
                            }}
                          >
                            连接
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {filteredDevices.length === 0 ? (
                <div className="rd-card empty-box">
                  <p>没有扫描到在线设备</p>
                </div>
              ) : (
                <div className="rd-device-grid">
                  {filteredDevices.map(renderDeviceCard)}
                </div>
              )}

              {recent.length > 0 && (
                <section className="rd-card">
                  <div className="rd-card-head">
                    <h3>最近连接设备 ({recent.length})</h3>
                  </div>
                  <div className="rd-device-grid">
                    {recent.map((item) => (
                      <article
                        key={item.deviceId}
                        className="rd-device-card"
                        onClick={() => handlePickRecent(item)}
                      >
                        <div className="rd-device-card-top">
                          <div className="rd-device-os-badge">{item.mode === 'relay' ? '公网' : '局域网'}</div>
                          <div className="rd-device-title-col">
                            <div className="device-title">
                              <span className={`dot ${recentOnlineMap[item.deviceId] ? 'online' : ''}`} />
                              <strong>{item.deviceName || item.deviceId}</strong>
                            </div>
                            <div className="device-sub">
                              <span>{item.deviceId}</span>
                            </div>
                          </div>
                        </div>
                        <div className="rd-device-card-foot">
                          <span className="rd-device-status-txt">
                            {recentOnlineMap[item.deviceId] ? '探测在线' : '已保存凭据'}
                          </span>
                          <button type="button" className="btn-secondary btn-xs">
                            重新连接
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {workspaceTab === 'deskhub' && (
            <DeskHubView
              devices={devices}
              recent={recent}
              onPickDevice={handlePickDevice}
              onPickRecent={handlePickRecent}
            />
          )}

          {workspaceTab === 'phones' && <PhoneMirrorPane />}
          {workspaceTab === 'account' && (
            <AccountPane
              selfDevice={
                desktopApi && hostState.hostStatus
                  ? {
                      deviceId: hostState.hostStatus.deviceId,
                      name: hostState.hostStatus.deviceName || '电脑',
                      platform: 'win32',
                      kind: 'pc',
                    }
                  : {
                      deviceId: `WEB-${(typeof window !== 'undefined' ? window.location.hostname : 'web')}`,
                      name: '网页',
                      platform: 'web',
                      kind: 'web',
                    }
              }
              onConnectDevice={(id) => {
                const dev = devices.find((d) => d.deviceId === id);
                if (dev && dev.online !== false) {
                  handlePickDevice(dev);
                  return;
                }
                setPromptTarget({ deviceId: id, deviceName: id, mode: 'relay', serverUrl: serverUrl.trim(), fallbackUrl: '' });
                setWorkspaceTab('home');
              }}
            />
          )}

          {workspaceTab === 'network' && desktopApi && (
            <HostNetworkPanel desktopApi={desktopApi} state={hostState} />
          )}

          {workspaceTab === 'settings' && desktopApi && (
            <HostSettingsPanel desktopApi={desktopApi} state={hostState} />
          )}
        </div>

        {tier === 'phone' && (
          <nav className="rd-bottom-nav" aria-label="移动端导航">
            {navItems.slice(0, 4).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`rd-bottom-item ${workspaceTab === item.id ? 'active' : ''}`}
                onClick={() => setWorkspaceTab(item.id)}
              >
                <span className="rd-nav-icon">
                  <NavIcon name={item.id} />
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        )}
      </main>

      {promptTarget && (
        <div className="modal-backdrop" onClick={() => setPromptTarget(null)}>
          <form
            className="modal-card modal-pin-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const p = promptPin.trim();
              if (!p) return;
              setPin(p);
              const target = promptTarget;
              setPromptTarget(null);
              onConnect({
                mode: target.mode,
                serverUrl: target.serverUrl,
                deviceId: target.deviceId,
                pin: p,
                fallbackUrl: target.fallbackUrl || '',
              });
            }}
          >
            <div className="modal-head">
              <strong>连接 {promptTarget.deviceName}</strong>
              <button type="button" className="btn-ghost" onClick={() => setPromptTarget(null)}>
                关闭
              </button>
            </div>
            <div className="field">
              <span>设备 ID: {promptTarget.deviceId}</span>
              <input
                type="password"
                value={promptPin}
                onChange={(e) => setPromptPin(e.target.value.toUpperCase())}
                placeholder="8 位密码"
                autoFocus
                required
              />
            </div>
            <div className="modal-foot">
              <button type="button" className="btn-secondary" onClick={() => setPromptTarget(null)}>
                取消
              </button>
              <button type="submit" className="btn-primary">
                立即远程
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
