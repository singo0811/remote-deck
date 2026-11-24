import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';

/** Public host (domain[:port]) the host is reachable at, or '' when offline. */
export function publicAddressOf(hostStatus) {
  const raw = hostStatus?.tunnelUrl || hostStatus?.relayUrl || '';
  if (!raw) return '';
  try {
    const url = new URL(String(raw).replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:'));
    return url.host;
  } catch {
    return '';
  }
}

export function useHostDesk(desktopApi) {
  const [hostStatus, setHostStatus] = useState(null);
  const [showPin, setShowPin] = useState(true);
  const [qrTarget, setQrTarget] = useState('lan'); // 'lan' | 'mesh' | 'wan'
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [adminAuto, setAdminAuto] = useState(false);
  const [tunnelToken, setTunnelToken] = useState('');
  const [tunnelHostname, setTunnelHostname] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [relaySecret, setRelaySecret] = useState('');
  const [tsnetAuthKey, setTsnetAuthKey] = useState('');
  const [tsAuthQrUrl, setTsAuthQrUrl] = useState('');
  const [svcStatus, setSvcStatus] = useState(null);
  const [svcMsg, setSvcMsg] = useState('');
  const [copiedMsg, setCopiedMsg] = useState('');
  const prevTunnelRef = useRef('');

  useEffect(() => {
    if (!desktopApi) return;
    let mounted = true;
    desktopApi.getHostStatus().then((st) => {
      if (!mounted || !st) return;
      setHostStatus(st);
      if (st.tunnelUrl) {
        prevTunnelRef.current = st.tunnelUrl;
        setQrTarget('wan');
      } else if (st.tsnet?.tailscaleIp) {
        setQrTarget('mesh');
      }
    });
    desktopApi.getAutoLaunch?.().then((val) => {
      if (mounted) setAutoLaunch(Boolean(val));
    });
    desktopApi.getAdminAutostart?.().then((val) => {
      if (mounted) setAdminAuto(Boolean(val));
    });
    desktopApi.getTunnelConfig?.().then((cfg) => {
      if (!mounted || !cfg) return;
      setTunnelToken(cfg.token || '');
      setTunnelHostname(cfg.hostname || '');
    });
    desktopApi.getRelayConfig?.().then((cfg) => {
      if (!mounted || !cfg) return;
      setRelayUrl(cfg.relayUrl || '');
      setRelaySecret(cfg.relaySecret || '');
    });
    desktopApi.getServiceStatus?.().then((st) => {
      if (mounted) setSvcStatus(st);
    });
    const unsub = desktopApi.onHostStatus((st) => {
      if (!mounted) return;
      setHostStatus(st);
      if (st.tunnelUrl && !prevTunnelRef.current) {
        prevTunnelRef.current = st.tunnelUrl;
        setQrTarget('wan');
      } else if (!st.tunnelUrl && prevTunnelRef.current) {
        prevTunnelRef.current = '';
        setQrTarget(st.tsnet?.tailscaleIp ? 'mesh' : 'lan');
      }
    });
    return () => {
      mounted = false;
      unsub?.();
    };
  }, [desktopApi]);

  const pinSuffix = showPin && hostStatus?.pin ? `&pin=${encodeURIComponent(hostStatus.pin)}` : '';

  const primaryLanUrl = useMemo(() => {
    const eps = hostStatus?.shareEndpoints?.length
      ? hostStatus.shareEndpoints
      : hostStatus?.lanEndpoints || [];
    const lan =
      eps.find((e) => !e.virtual && e.kind === 'lan') ||
      eps.find((e) => !e.virtual) ||
      eps.find((e) => e.kind === 'lan') ||
      eps[0];
    if (!lan) return `http://127.0.0.1:${hostStatus?.lanPort || 9601}`;
    return `${lan.httpUrl}/?mode=direct&id=${encodeURIComponent(hostStatus.deviceId || '')}${pinSuffix}`;
  }, [hostStatus, pinSuffix]);

  const meshShareUrl = useMemo(() => {
    const tsIp = hostStatus?.tsnet?.tailscaleIp;
    if (!tsIp) return '';
    return `http://${tsIp}:${hostStatus?.lanPort || 9601}/?mode=direct&id=${encodeURIComponent(hostStatus.deviceId || '')}${pinSuffix}`;
  }, [hostStatus, pinSuffix]);

  const wanShareUrl = useMemo(() => {
    if (hostStatus?.tunnelUrl) {
      return `${hostStatus.tunnelUrl}/?mode=direct&id=${encodeURIComponent(hostStatus.deviceId || '')}${pinSuffix}`;
    }
    if (hostStatus?.relayUrl && hostStatus.relayConnected) {
      const httpRelay = hostStatus.relayUrl
        .replace(/^ws:/i, 'http:')
        .replace(/^wss:/i, 'https:')
        .replace(/\/ws$/i, '');
      return `${httpRelay}/?mode=relay&id=${encodeURIComponent(hostStatus.deviceId || '')}${pinSuffix}`;
    }
    return '';
  }, [hostStatus, pinSuffix]);

  const activeQrUrl =
    qrTarget === 'wan' && wanShareUrl
      ? wanShareUrl
      : qrTarget === 'mesh' && meshShareUrl
        ? meshShareUrl
        : primaryLanUrl;

  useEffect(() => {
    if (!activeQrUrl) {
      setQrDataUrl('');
      return;
    }
    QRCode.toDataURL(activeQrUrl, {
      width: 176,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [activeQrUrl]);

  useEffect(() => {
    const url = hostStatus?.tsnet?.authUrl;
    if (!url) {
      setTsAuthQrUrl('');
      return;
    }
    QRCode.toDataURL(url, {
      width: 132,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then(setTsAuthQrUrl)
      .catch(() => setTsAuthQrUrl(''));
  }, [hostStatus?.tsnet?.authUrl]);

  const mcpSnippet = useMemo(() => {
    if (!hostStatus) return '';
    return JSON.stringify(
      {
        mcpServers: {
          remotedeck: {
            command: 'node',
            args: [
              'packages/mcp-server/src/index.mjs',
              '--url',
              `ws://127.0.0.1:${hostStatus.lanPort || 9601}/ws`,
              '--pin',
              hostStatus.pin || '',
            ],
          },
        },
      },
      null,
      2,
    );
  }, [hostStatus]);

  const flashMsg = (text, ms = 2200) => {
    setCopiedMsg(text);
    setTimeout(() => setCopiedMsg((cur) => (cur === text ? '' : cur)), ms);
  };

  const copyText = (text, label) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    flashMsg(`已复制${label}`);
  };

  const handleTogglePerm = (key) => {
    if (!hostStatus) return;
    desktopApi?.setPermissions({
      ...hostStatus.permissions,
      [key]: !hostStatus.permissions?.[key],
    });
  };

  const refreshSvc = async () => {
    const st = await desktopApi?.getServiceStatus?.();
    setSvcStatus(st || null);
    return st;
  };

  const installSvc = async (mode) => {
    setSvcMsg('正在安装开机服务（需要管理员权限）...');
    const res = await desktopApi?.installService?.(mode);
    if (res?.ok) {
      setSvcMsg(
        mode === 'system'
          ? '已安装 SYSTEM 会话服务（锁屏增强为实验特性）'
          : '已安装开机服务：开机后自动拉起被控端',
      );
    } else {
      setSvcMsg(`安装失败：${res?.error || '需要以管理员身份运行本程序'}（可先点「管理员重启」）`);
    }
    await refreshSvc();
    setTimeout(() => setSvcMsg(''), 6000);
  };

  const uninstallSvc = async () => {
    const res = await desktopApi?.uninstallService?.();
    setSvcMsg(res?.ok ? '已卸载开机服务' : `卸载失败：${res?.error || '未知错误'}`);
    await refreshSvc();
    setTimeout(() => setSvcMsg(''), 4000);
  };

  return {
    hostStatus,
    showPin,
    setShowPin,
    qrTarget,
    setQrTarget,
    qrDataUrl,
    autoLaunch,
    setAutoLaunch,
    adminAuto,
    setAdminAuto,
    tunnelToken,
    setTunnelToken,
    tunnelHostname,
    setTunnelHostname,
    relayUrl,
    setRelayUrl,
    relaySecret,
    setRelaySecret,
    tsnetAuthKey,
    setTsnetAuthKey,
    tsAuthQrUrl,
    svcStatus,
    svcMsg,
    copiedMsg,
    flashMsg,
    copyText,
    handleTogglePerm,
    installSvc,
    uninstallSvc,
    meshShareUrl,
    wanShareUrl,
    activeQrUrl,
    mcpSnippet,
  };
}

export function HostHeroPanel({ desktopApi, state, onOpenSection }) {
  const {
    hostStatus,
    showPin,
    setShowPin,
    qrTarget,
    setQrTarget,
    qrDataUrl,
    copiedMsg,
    flashMsg,
    copyText,
    meshShareUrl,
    wanShareUrl,
    activeQrUrl,
  } = state;

  if (!desktopApi || !hostStatus) return null;

  const eps = hostStatus.shareEndpoints?.length ? hostStatus.shareEndpoints : hostStatus.lanEndpoints || [];
  const primaryLanIp = eps.find((e) => !e.virtual && e.kind === 'lan' && e.family === 4)?.ip || eps[0]?.ip || '';
  const ipv6Count = eps.filter((e) => e.family === 6 && !e.virtual).length;

  return (
    <section className="rd-card rd-host-hero">
      <div className="rd-card-head">
        <div className="rd-title-group">
          <span className="dot online" />
          <div>
            <h2>本机</h2>
          </div>
        </div>
        <div className="rd-head-actions">
          {copiedMsg && <span className="copied-pill">{copiedMsg}</span>}
          {hostStatus.activeSessions > 0 && (
            <span className="status-pill">{hostStatus.activeSessions} 路控制中</span>
          )}
          {!hostStatus.elevated && desktopApi.relaunchAdmin && (
            <button
              type="button"
              className="btn-secondary btn-xs"
              onClick={() => desktopApi.relaunchAdmin()}
              title="以管理员身份重启后，可远程操作 UAC 弹窗与任务管理器"
            >
              管理员重启
            </button>
          )}
        </div>
      </div>

      <div className="rd-hero-split">
        <div className="rd-cred-stack">
          <div className="rd-cred-tile">
            <div className="rd-cred-meta">
              <span>本机设备代码</span>
              <span className="rd-host-alias">{hostStatus.deviceName || 'Windows 主机'}</span>
            </div>
            <div className="rd-cred-row">
              <strong className="rd-cred-number">{hostStatus.deviceId}</strong>
              <button
                type="button"
                className="btn-secondary btn-xs"
                onClick={() => copyText(hostStatus.deviceId, '设备代码')}
              >
                复制 ID
              </button>
            </div>
          </div>

          <div className="rd-cred-tile">
            <div className="rd-cred-meta">
              <span>临时访问密码 (PIN)</span>
              <span className="rd-cred-hint">{hostStatus.autoRotatePin ? '断开自动更新' : '本轮会话有效'}</span>
            </div>
            <div className="rd-cred-row">
              <strong className="rd-cred-number rd-pin-number">
                {showPin ? hostStatus.pin : '••••••••'}
              </strong>
              <div className="rd-cred-btns">
                <button type="button" className="btn-ghost btn-xs" onClick={() => setShowPin((v) => !v)}>
                  {showPin ? '隐藏' : '显示'}
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-xs"
                  onClick={() => copyText(hostStatus.pin, '访问密码')}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={() => desktopApi.regeneratePin()}
                  title="更换临时访问密码"
                >
                  刷新
                </button>
              </div>
            </div>
          </div>

          <div className="rd-channel-strip">
            {primaryLanIp && <span className="link-badge badge-lan">局域网</span>}
            <button
              type="button"
              className={`link-badge badge-btn ${hostStatus.tsnet?.tailscaleIp ? 'badge-lan' : 'badge-muted'}`}
              onClick={() => onOpenSection?.('network')}
            >
              组网
            </button>
            <button
              type="button"
              className={`link-badge badge-btn ${hostStatus?.tunnelUrl || hostStatus?.relayConnected ? 'badge-relay' : 'badge-muted'}`}
              onClick={() => onOpenSection?.('network')}
            >
              公网
            </button>
          </div>

          <div className="rd-quick-toggles">
            <label className="toggle-chip compact-chip" title="新设备连接时在本机弹窗确认允许/拒绝">
              <input
                type="checkbox"
                checked={Boolean(hostStatus.requireApproval)}
                onChange={(e) => desktopApi.setSecurity?.({ requireApproval: e.target.checked })}
              />
              <span>连接需审批</span>
            </label>
            <label className="toggle-chip compact-chip" title="允许远程端鼠标和键盘控制">
              <input
                type="checkbox"
                checked={hostStatus.permissions?.control !== false}
                onChange={() => state.handleTogglePerm('control')}
              />
              <span>允许键鼠控制</span>
            </label>
            {hostStatus.activeSessions > 0 && (
              <label className="toggle-chip compact-chip" title="本机屏幕显示防窥黑屏，仅远程控制端可见">
                <input
                  type="checkbox"
                  checked={Boolean(hostStatus.privacyEnabled)}
                  onChange={async (e) => {
                    const res = await desktopApi.setPrivacy?.(e.target.checked);
                    if (res && !res.ok && res.error) {
                      flashMsg(res.error, 2600);
                    }
                  }}
                />
                <span>防窥黑屏</span>
              </label>
            )}
          </div>
        </div>

        <div className="rd-qr-panel">
          <div className="qr-tabs">
            <button
              type="button"
              className={`qr-tab ${qrTarget === 'lan' ? 'active' : ''}`}
              onClick={() => setQrTarget('lan')}
            >
              局域网
            </button>
            {meshShareUrl && (
              <button
                type="button"
                className={`qr-tab ${qrTarget === 'mesh' ? 'active' : ''}`}
                onClick={() => setQrTarget('mesh')}
              >
                组网
              </button>
            )}
            <button
              type="button"
              className={`qr-tab ${qrTarget === 'wan' ? 'active' : ''}`}
              onClick={() => setQrTarget('wan')}
              disabled={!wanShareUrl}
            >
              公网
            </button>
          </div>

          {qrDataUrl ? (
            <img className="qr-img" src={qrDataUrl} alt="连接二维码" />
          ) : (
            <div className="qr-placeholder">二维码</div>
          )}

          <button
            type="button"
            className="btn-secondary btn-xs rd-qr-copy"
            onClick={() => copyText(activeQrUrl, '连接口令')}
          >
            复制口令
          </button>
        </div>
      </div>
    </section>
  );
}

export function HostNetworkPanel({ desktopApi, state }) {
  const {
    hostStatus,
    tunnelToken,
    setTunnelToken,
    tunnelHostname,
    setTunnelHostname,
    relayUrl,
    setRelayUrl,
    relaySecret,
    setRelaySecret,
    tsnetAuthKey,
    setTsnetAuthKey,
    tsAuthQrUrl,
    copiedMsg,
    flashMsg,
    copyText,
  } = state;

  if (!desktopApi || !hostStatus) return null;
  const peers = hostStatus.tsnet?.peers || [];

  return (
    <div className="rd-section-stack">
      <div className="rd-page-head">
        <div>
          <h2>连接方式</h2>
        </div>
        {copiedMsg && <span className="copied-pill">{copiedMsg}</span>}
      </div>

      <div className="rd-three-grid">
        <section className="rd-card rd-feature-card">
          <div className="rd-card-head">
            <div className="rd-title-group">
              <span className={`dot ${hostStatus.tsnet?.tailscaleIp ? 'online' : ''}`} />
              <div>
                <h3>组网</h3>
              </div>
            </div>
            {desktopApi.setTsnetConfig && hostStatus.tsnet?.available !== false && (
              <label className="toggle-chip compact-chip">
                <input
                  type="checkbox"
                  checked={Boolean(hostStatus.tsnet?.enabled)}
                  onChange={(e) => desktopApi.setTsnetConfig({ enabled: e.target.checked, authKey: tsnetAuthKey })}
                />
                <span>{hostStatus.tsnet?.enabled ? '已开启' : '开启'}</span>
              </label>
            )}
          </div>

          {hostStatus.tsnet?.enabled ? (
            <div className="svc-head">
              <span className={`link-badge ${hostStatus.tsnet.tailscaleIp ? 'badge-lan' : 'badge-relay'}`}>
                {hostStatus.tsnet.tailscaleIp ? '在线' : hostStatus.tsnet.authUrl ? '待授权' : '连接中'}
              </span>
              {hostStatus.tsnet.authUrl ? (
                <a
                  href={hostStatus.tsnet.authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-primary btn-xs"
                  style={{ textDecoration: 'none' }}
                >
                  登录
                </a>
              ) : hostStatus.tsnet.tailscaleIp ? (
                <button type="button" className="btn-ghost btn-xs" onClick={() => desktopApi.logoutTsnet?.()}>
                  退出
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="rd-card rd-feature-card">
          <div className="rd-card-head">
            <div className="rd-title-group">
              <span className={`dot ${hostStatus.tunnelState === 'ready' ? 'online' : ''}`} />
              <div>
                <h3>临时隧道</h3>
              </div>
            </div>
            <label className="toggle-chip compact-chip">
              <input
                type="checkbox"
                checked={Boolean(hostStatus.quickTunnelEnabled)}
                onChange={(e) => desktopApi.setQuickTunnel(e.target.checked)}
              />
              <span>{hostStatus.quickTunnelEnabled ? '已开启' : '开启'}</span>
            </label>
          </div>

          {hostStatus.quickTunnelEnabled ? (
            <div className="tunnel-cfg-box">
              <div className="svc-head">
                <small className="rd-break-url">{hostStatus.tunnelUrl || `状态：${hostStatus.tunnelState}`}</small>
                {hostStatus.tunnelUrl && (
                  <button
                    type="button"
                    className="btn-secondary btn-xs"
                    onClick={() => copyText(hostStatus.tunnelUrl, '隧道地址')}
                  >
                    复制
                  </button>
                )}
              </div>
              {desktopApi.setTunnelConfig && (
                <>
                  <div className="tunnel-cfg-inputs">
                    <input
                      type="password"
                      value={tunnelToken}
                      onChange={(e) => setTunnelToken(e.target.value)}
                      placeholder="Tunnel Token（可选）"
                    />
                    <input
                      type="text"
                      value={tunnelHostname}
                      onChange={(e) => setTunnelHostname(e.target.value)}
                      placeholder="固定域名，如 rd.example.com"
                    />
                  </div>
                  <div className="tunnel-cfg-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={async () => {
                        await desktopApi.setTunnelConfig({ token: tunnelToken, hostname: tunnelHostname });
                        flashMsg('固定域名配置已保存');
                      }}
                    >
                      保存并重启隧道
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-xs"
                      onClick={() => {
                        setTunnelToken('');
                        setTunnelHostname('');
                        desktopApi.setTunnelConfig({ token: '', hostname: '' });
                      }}
                    >
                      恢复随机域名
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="rd-muted-note">未开启</p>
          )}
        </section>

        {desktopApi.setRelayConfig && (
          <section className="rd-card rd-feature-card">
            <div className="rd-card-head">
              <div className="rd-title-group">
                <span className={`dot ${hostStatus.relayConnected ? 'online' : ''}`} />
                <div>
                  <h3>公网</h3>
                </div>
              </div>
              <span className={`link-badge ${hostStatus.relayConnected ? 'badge-lan' : 'badge-err'}`}>
                {hostStatus.relayConnected ? '已连接' : '未连接'}
              </span>
            </div>

            <div className="svc-head">
              <button
                type="button"
                className="btn-secondary btn-xs"
                onClick={async () => {
                  await desktopApi.setRelayConfig({ relayUrl, relaySecret });
                  flashMsg('已保存');
                }}
              >
                {hostStatus.relayConnected ? '重新连接' : '连接'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export function HostSettingsPanel({ desktopApi, state }) {
  const {
    hostStatus,
    autoLaunch,
    setAutoLaunch,
    adminAuto,
    setAdminAuto,
    svcStatus,
    svcMsg,
    copiedMsg,
    flashMsg,
    copyText,
    handleTogglePerm,
    installSvc,
    uninstallSvc,
    mcpSnippet,
  } = state;

  if (!desktopApi || !hostStatus) return null;

  return (
    <div className="rd-section-stack">
      <div className="rd-page-head">
        <div>
          <h2>权限、守护服务与 AI 接入</h2>
          <p>控制远程访问权限边界、配置开机自启服务以及 AI Agent MCP / 终端 CLI</p>
        </div>
        {copiedMsg && <span className="copied-pill">{copiedMsg}</span>}
      </div>

      <div className="rd-two-grid">
        <section className="rd-card rd-feature-card">
          <h3>权限与安全策略</h3>
          <div className="perm-row">
            {[
              ['view', '观看画面'],
              ['control', '键鼠控制'],
              ['audio', '系统声音'],
              ['terminal', '远程终端'],
              ['files', '文件管理'],
            ].map(([key, label]) => (
              <label key={key} className="perm-check">
                <input
                  type="checkbox"
                  checked={hostStatus.permissions?.[key] !== false}
                  onChange={() => handleTogglePerm(key)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          <div className="host-switches">
            <label className="toggle-chip" title="新设备连接时在本机弹窗确认允许/拒绝">
              <input
                type="checkbox"
                checked={Boolean(hostStatus.requireApproval)}
                onChange={(e) => desktopApi.setSecurity?.({ requireApproval: e.target.checked })}
              />
              <span>新连接需本机审批</span>
            </label>
            <label className="toggle-chip" title="全部断开后自动更换新密码">
              <input
                type="checkbox"
                checked={Boolean(hostStatus.autoRotatePin)}
                onChange={(e) => desktopApi.setSecurity?.({ autoRotatePin: e.target.checked })}
              />
              <span>断开自动换新码</span>
            </label>
            <label className="toggle-chip">
              <input
                type="checkbox"
                checked={autoLaunch}
                onChange={async (e) => {
                  const next = await desktopApi.setAutoLaunch(e.target.checked);
                  setAutoLaunch(Boolean(next));
                }}
              />
              <span>开机自启动</span>
            </label>
            {desktopApi.setAdminAutostart && (
              <label className="toggle-chip" title="以管理员权限随登录自启，可远程操作 UAC 弹窗">
                <input
                  type="checkbox"
                  checked={adminAuto}
                  onChange={async (e) => {
                    const next = await desktopApi.setAdminAutostart(e.target.checked);
                    setAdminAuto(Boolean(next));
                    if (Boolean(next) !== Boolean(e.target.checked)) {
                      flashMsg('需要先点「管理员重启」以管理员权限运行，才能创建高权限计划任务', 3400);
                    }
                  }}
                />
                <span>管理员权限自启</span>
              </label>
            )}
          </div>

          {desktopApi.getServiceStatus && (
            <div className="svc-box">
              <div className="svc-head">
                <strong>Windows 开机看护服务</strong>
                <span
                  className={`link-badge ${
                    svcStatus?.running ? 'badge-lan' : svcStatus?.installed ? 'badge-relay' : 'badge-err'
                  }`}
                >
                  {svcStatus?.running
                    ? '看护中'
                    : svcStatus?.installed
                      ? `已安装 · ${svcStatus.mode === 'system' ? 'SYSTEM 会话' : '用户会话'}`
                      : '未安装'}
                </span>
              </div>
              <small>开机时由守护进程自动拉起被控端并在意外退出时自动重启。</small>
              <div className="svc-actions">
                <button type="button" className="btn-secondary btn-xs" onClick={() => installSvc('user')}>
                  安装（用户会话）
                </button>
                <button type="button" className="btn-ghost btn-xs" onClick={() => installSvc('system')}>
                  安装（SYSTEM 会话）
                </button>
                {svcStatus?.installed && (
                  <button type="button" className="btn-danger-ghost btn-xs" onClick={uninstallSvc}>
                    卸载服务
                  </button>
                )}
              </div>
              {svcMsg && <div className="svc-msg">{svcMsg}</div>}
            </div>
          )}
        </section>

        <section className="rd-card rd-feature-card">
          <div className="svc-head">
            <h3>AI Agent (MCP) & 终端 CLI</h3>
            <button
              type="button"
              className="btn-secondary btn-xs"
              onClick={() => copyText(mcpSnippet, 'MCP 配置 JSON')}
            >
              复制 MCP 配置
            </button>
          </div>
          <p className="rd-muted-note">让支持 Model Context Protocol 的 AI 助手直接截屏看屏、点击输入、执行命令与读写文件。</p>
          <pre className="mcp-code-preview">{mcpSnippet}</pre>
          <div className="svc-box">
            <div className="svc-head">
              <strong>终端 CLI 直连（ANSI TrueColor / Kitty 像素看屏）</strong>
              <button
                type="button"
                className="btn-secondary btn-xs"
                onClick={() =>
                  copyText(
                    `node packages/cli/src/cli.mjs ws://127.0.0.1:${hostStatus.lanPort || 9601}/ws --pin ${hostStatus.pin}`,
                    'CLI 命令',
                  )
                }
              >
                复制 CLI 命令
              </button>
            </div>
            <small>支持无桌面环境 SSH 终端里直接看屏、键鼠交互与 `doctor --json` 自检。</small>
          </div>
        </section>
      </div>
    </div>
  );
}

export function HostDeskCard({ desktopApi }) {
  const state = useHostDesk(desktopApi);
  return <HostHeroPanel desktopApi={desktopApi} state={state} />;
}
