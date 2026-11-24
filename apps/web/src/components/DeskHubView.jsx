import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FRAME_KIND, MSG } from '../lib/protocol.js';
import { RemoteTransport } from '../lib/transport.js';

const META_KEY = 'rd_deskhub_meta_v1';
const DEFAULT_GROUPS = ['默认', '办公', '家庭', '服务器'];

function loadMetaMap() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveMetaMap(map) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(map));
  } catch {}
}

function resolveTileTarget(item) {
  const eps = item.lanEndpoints || [];
  const lan = eps.find((e) => !e.virtual && e.kind === 'lan') || eps.find((e) => e.kind === 'tailscale') || eps[0];
  const serverUrl = lan?.httpUrl || item.serverUrl || item.tunnelUrl || '';
  const fallbackUrl = item.tunnelUrl || '';
  const mode = item.mode === 'relay' && !lan && !item.tunnelUrl ? 'relay' : 'direct';
  return { mode, serverUrl, fallbackUrl };
}

function DeskHubTile({
  item,
  meta,
  selected,
  groupControl,
  onToggleSelect,
  onUpdateMeta,
  onEnterFullControl,
  onRegisterTransport,
  onBroadcastMouse,
}) {
  const canvasRef = useRef(null);
  const transportRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | connected | error
  const [channel, setChannel] = useState('');
  const [rttMs, setRttMs] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const [editing, setEditing] = useState(false);
  const [aliasDraft, setAliasDraft] = useState(meta?.alias || '');
  const [groupDraft, setGroupDraft] = useState(meta?.group || '默认');

  useEffect(() => {
    return () => {
      onRegisterTransport(item.deviceId, null);
      transportRef.current?.disconnect(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.deviceId]);

  const drawJpegToCanvas = async (jpegBytes) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
    try {
      const bmp = await createImageBitmap(blob);
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close?.();
    } catch {}
  };

  const connectPreview = async () => {
    if (!item.pin) {
      setErrMsg('请先连接一次以记住密码');
      setStatus('error');
      return;
    }
    const { mode, serverUrl, fallbackUrl } = resolveTileTarget(item);
    if (!serverUrl) {
      setErrMsg('无可用连接地址');
      setStatus('error');
      return;
    }
    setErrMsg('');
    setStatus('connecting');
    transportRef.current?.disconnect(true);

    const t = new RemoteTransport({
      onStatus: ({ status: st, channel: ch }) => {
        if (st === 'connected') {
          setStatus('connected');
          setChannel(ch || '');
        } else if (st === 'disconnected' || st === 'idle') {
          setStatus((cur) => (cur === 'error' ? cur : 'idle'));
        }
      },
      onTelemetry: ({ rttMs: rtt, channel: ch }) => {
        if (rtt != null) setRttMs(rtt);
        if (ch) setChannel(ch);
      },
      onAuthenticated: () => {
        onRegisterTransport(item.deviceId, t);
        t.sendJson({
          type: MSG.SCREEN_START,
          displayId: 0,
          fps: 2,
          scale: 0.35,
          quality: 54,
          auto: false,
          allowDirty: false,
        });
      },
      onScreenFrame: (metaFrame, payload) => {
        if (!metaFrame?.dirty) {
          void drawJpegToCanvas(payload);
        }
      },
    });
    transportRef.current = t;
    try {
      await t.connect({
        mode,
        serverUrl,
        deviceId: item.deviceId,
        pin: item.pin,
        fallbackUrl,
      });
    } catch (err) {
      setStatus('error');
      setErrMsg(err?.message || '连接失败');
      onRegisterTransport(item.deviceId, null);
    }
  };

  const disconnectPreview = () => {
    onRegisterTransport(item.deviceId, null);
    transportRef.current?.disconnect(true);
    transportRef.current = null;
    setStatus('idle');
    setRttMs(null);
  };

  useEffect(() => {
    if (item.autoConnectSignal > 0 && status === 'idle' && item.pin) {
      void connectPreview();
    } else if (item.autoDisconnectSignal > 0 && status !== 'idle') {
      disconnectPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.autoConnectSignal, item.autoDisconnectSignal]);

  const handleCanvasClick = (e) => {
    if (status !== 'connected') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
    if (groupControl && selected) {
      onBroadcastMouse({ action: 'click', x, y, button: 'left' });
    } else {
      transportRef.current?.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', x, y, button: 'left' });
    }
  };

  const displayName = meta?.alias || item.deviceName || item.deviceId;
  const groupName = meta?.group || '默认';

  return (
    <article className={`deskhub-tile ${selected ? 'selected' : ''}`}>
      <header className="deskhub-tile-head">
        <label className="deskhub-check">
          <input type="checkbox" checked={selected} onChange={onToggleSelect} />
          <span className={`dot ${status === 'connected' || item.online ? 'online' : ''}`} />
          <strong title={item.deviceId}>{displayName}</strong>
        </label>
        <div className="deskhub-badges">
          <span className="mini-tag">{groupName}</span>
          {status === 'connected' && (
            <span className="mini-tag tag-ok">
              {channel === 'tailscale' ? '组网' : channel === 'lan' ? '局域网' : '公网'}
              {rttMs != null ? ` ${rttMs}ms` : ''}
            </span>
          )}
        </div>
      </header>

      <div className="deskhub-screen-box" onClick={handleCanvasClick} title={groupControl && selected ? '群控同步已开启：点击会同步到所有选中在线桌面' : '点击进入或预览'}>
        <canvas ref={canvasRef} className={`deskhub-canvas ${status === 'connected' ? 'active' : ''}`} />
        {status !== 'connected' && (
          <div className="deskhub-placeholder">
            <span className="deskhub-id">{item.deviceId}</span>
            <small>
              {status === 'connecting'
                ? '正在建立预览通道...'
                : errMsg || (item.online ? '在线 · 点击「连接预览」或「进入控制」' : '离线或尚未记忆 PIN')}
            </small>
          </div>
        )}
      </div>

      {editing && (
        <div className="deskhub-meta-edit">
          <input
            type="text"
            value={aliasDraft}
            onChange={(e) => setAliasDraft(e.target.value)}
            placeholder="设备备注名"
          />
          <select value={groupDraft} onChange={(e) => setGroupDraft(e.target.value)}>
            {DEFAULT_GROUPS.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              onUpdateMeta(item.deviceId, { alias: aliasDraft.trim(), group: groupDraft });
              setEditing(false);
            }}
          >
            保存
          </button>
        </div>
      )}

      <footer className="deskhub-tile-foot">
        {status === 'connected' ? (
          <button type="button" className="btn-ghost" onClick={disconnectPreview}>
            断开预览
          </button>
        ) : (
          <button type="button" className="btn-secondary" onClick={connectPreview} disabled={status === 'connecting'}>
            {status === 'connecting' ? '连接中...' : '连接预览'}
          </button>
        )}
        <button type="button" className="btn-ghost" onClick={() => setEditing((v) => !v)}>
          分组/备注
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            disconnectPreview();
            onEnterFullControl(item);
          }}
        >
          进入控制
        </button>
      </footer>
    </article>
  );
}

export function DeskHubView({ devices, recent, onPickDevice, onPickRecent }) {
  const [metaMap, setMetaMap] = useState(() => loadMetaMap());
  const [groupFilter, setGroupFilter] = useState('全部');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [groupControl, setGroupControl] = useState(false);
  const [connectSeq, setConnectSeq] = useState(0);
  const [disconnectSeq, setDisconnectSeq] = useState(0);
  const [batchMsg, setBatchMsg] = useState('');
  const activeTransportsRef = useRef(new Map());
  const fileInputRef = useRef(null);

  const wallItems = useMemo(() => {
    const map = new Map();
    for (const r of recent) {
      if (!r?.deviceId) continue;
      map.set(r.deviceId, {
        deviceId: r.deviceId,
        deviceName: r.deviceName || r.deviceId,
        mode: r.mode || 'direct',
        serverUrl: r.serverUrl || '',
        tunnelUrl: r.tunnelUrl || '',
        pin: r.pin || '',
        lanEndpoints: [],
        online: false,
      });
    }
    for (const d of devices) {
      if (!d?.deviceId) continue;
      const prev = map.get(d.deviceId) || {};
      map.set(d.deviceId, {
        ...prev,
        ...d,
        pin: prev.pin || '',
        tunnelUrl: d.tunnelUrl || prev.tunnelUrl || '',
        lanEndpoints: d.lanEndpoints?.length ? d.lanEndpoints : prev.lanEndpoints || [],
        online: Boolean(d.online),
      });
    }
    return Array.from(map.values()).map((it) => ({
      ...it,
      autoConnectSignal: connectSeq,
      autoDisconnectSignal: disconnectSeq,
    }));
  }, [devices, recent, connectSeq, disconnectSeq]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return wallItems.filter((it) => {
      const m = metaMap[it.deviceId] || {};
      const grp = m.group || '默认';
      if (groupFilter !== '全部' && grp !== groupFilter) return false;
      if (!q) return true;
      return (
        it.deviceId.toLowerCase().includes(q) ||
        (it.deviceName || '').toLowerCase().includes(q) ||
        (m.alias || '').toLowerCase().includes(q)
      );
    });
  }, [wallItems, metaMap, groupFilter, search]);

  const updateMeta = (deviceId, next) => {
    setMetaMap((prev) => {
      const updated = { ...prev, [deviceId]: { ...(prev[deviceId] || {}), ...next } };
      saveMetaMap(updated);
      return updated;
    });
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const registerTransport = (deviceId, transport) => {
    if (transport) activeTransportsRef.current.set(deviceId, transport);
    else activeTransportsRef.current.delete(deviceId);
  };

  const handleBroadcastMouse = (ev) => {
    for (const id of selectedIds) {
      const t = activeTransportsRef.current.get(id);
      t?.sendJson({ type: MSG.INPUT_MOUSE, ...ev });
    }
  };

  const handleBatchDistributeFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const targets = selectedIds
      .map((id) => ({ id, t: activeTransportsRef.current.get(id) }))
      .filter((x) => Boolean(x.t));
    if (targets.length === 0) {
      setBatchMsg('请先勾选并连接至少一台设备预览');
      setTimeout(() => setBatchMsg(''), 2600);
      return;
    }
    setBatchMsg(`正在向 ${targets.length} 台设备分发 ${file.name}...`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const CHUNK = 64 * 1024;
    await Promise.all(
      targets.map(async ({ id, t }) => {
        try {
          const rootsRes = await new Promise((resolve) => {
            const reqId = `dh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const origMsg = t.handlers.onMessage;
            const timer = setTimeout(() => {
              t.handlers.onMessage = origMsg;
              resolve('');
            }, 3000);
            t.handlers.onMessage = (msg) => {
              origMsg?.(msg);
              if (msg?.type === MSG.FS_RESULT && msg.reqId === reqId) {
                clearTimeout(timer);
                t.handlers.onMessage = origMsg;
                resolve(msg.roots?.[0]?.path || '');
              }
            };
            t.sendJson({ type: MSG.FS_ROOTS, reqId });
          });
          if (!rootsRes) return;
          const transferId = `batch-${id}-${Date.now()}`;
          t.sendJson({
            type: MSG.FS_UPLOAD_START,
            reqId: transferId,
            transferId,
            dirPath: rootsRes,
            fileName: file.name,
            total: bytes.byteLength,
          });
          await new Promise((r) => setTimeout(r, 120));
          for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
            const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + CHUNK));
            const done = offset + slice.byteLength >= bytes.byteLength;
            t.sendBinary(FRAME_KIND.FILE_UP, { transferId, done }, slice);
          }
          if (bytes.byteLength === 0) {
            t.sendBinary(FRAME_KIND.FILE_UP, { transferId, done: true }, new Uint8Array(0));
          }
        } catch {}
      }),
    );
    setBatchMsg(`已向 ${targets.length} 台设备下发 ${file.name}`);
    setTimeout(() => setBatchMsg(''), 3200);
  };

  return (
    <section className="deskhub-shell">
      <div className="deskhub-toolbar card">
        <div className="deskhub-groups">
          {['全部', ...DEFAULT_GROUPS].map((g) => (
            <button
              key={g}
              type="button"
              className={`qr-tab ${groupFilter === g ? 'active' : ''}`}
              onClick={() => setGroupFilter(g)}
            >
              {g}
            </button>
          ))}
        </div>

        <input
          type="search"
          className="deskhub-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索设备名或 ID..."
        />

        <div className="deskhub-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              setSelectedIds(
                selectedIds.length === filteredItems.length ? [] : filteredItems.map((i) => i.deviceId),
              )
            }
          >
            {selectedIds.length === filteredItems.length && filteredItems.length > 0 ? '取消全选' : '全选'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setConnectSeq((n) => n + 1)}>
            批量预览
          </button>
          <button type="button" className="btn-ghost" onClick={() => setDisconnectSeq((n) => n + 1)}>
            批量断开
          </button>
          <label className="toggle-chip" title="开启后在任意选中设备的预览画面点击，将同步操作所有选中预览设备">
            <input
              type="checkbox"
              checked={groupControl}
              onChange={(e) => setGroupControl(e.target.checked)}
            />
            <span>同步群控</span>
          </label>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={selectedIds.length === 0}
          >
            批量分发文件
          </button>
          <input ref={fileInputRef} type="file" hidden onChange={handleBatchDistributeFile} />
        </div>
      </div>

      {batchMsg && <div className="copied-pill">{batchMsg}</div>}

      {filteredItems.length === 0 ? (
        <div className="card empty-box">
          <p>桌面墙暂无可展示的设备</p>
          <small>先连接过至少一台设备。</small>
        </div>
      ) : (
        <div className="deskhub-grid">
          {filteredItems.map((it) => (
            <DeskHubTile
              key={it.deviceId}
              item={it}
              meta={metaMap[it.deviceId]}
              selected={selectedIds.includes(it.deviceId)}
              groupControl={groupControl}
              onToggleSelect={() => toggleSelect(it.deviceId)}
              onUpdateMeta={updateMeta}
              onRegisterTransport={registerTransport}
              onBroadcastMouse={handleBroadcastMouse}
              onEnterFullControl={(item) => {
                const live = devices.find((d) => d.deviceId === item.deviceId);
                if (live) onPickDevice(live);
                else onPickRecent(item);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
