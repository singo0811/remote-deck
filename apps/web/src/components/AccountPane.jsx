import React, { useEffect, useState } from 'react';
import * as account from '../lib/account.js';

export default function AccountPane({ onConnectDevice, selfDevice }) {
  const [token, setTokenState] = useState(() => account.getToken());
  const [user, setUser] = useState(() => (account.getToken() ? account.loadProfile() : null));
  const [devices, setDevices] = useState([]);
  const [checking, setChecking] = useState(() => Boolean(account.getToken()) && !account.loadProfile());
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);

  const emailMode = mode === 'register' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(name.trim());

  const sendCode = async () => {
    if (busy || !emailMode) return;
    setBusy(true);
    setError('');
    try {
      const res = await account.requestEmailCode(name.trim());
      if (!res.ok) { setError(res.error || '发送失败'); return; }
      setCodeSent(true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    if (!token) {
      setUser(null);
      setChecking(false);
      return () => { alive = false; };
    }
    // Never leave the page stuck on the loading card if the request stalls.
    const guard = setTimeout(() => { if (alive) setChecking(false); }, 4000);
    account.me(token).then((res) => {
      if (!alive) return;
      clearTimeout(guard);
      if (res.ok) { setUser(res.user); account.saveProfile(res.user); }
      else { account.setToken(''); setTokenState(''); }
      setChecking(false);
    }).catch(() => { if (alive) { clearTimeout(guard); setChecking(false); } });
    return () => { alive = false; clearTimeout(guard); };
  }, [token]);

  // Sign this machine in as one of the account's devices, then keep its
  // liveness fresh so other devices see it as online.
  useEffect(() => {
    if (!token || !user || !selfDevice?.deviceId) return undefined;
    let alive = true;
    const push = async () => {
      const res = await account.registerDevice(selfDevice, token);
      if (alive && res.ok) setUser(res.user);
    };
    push();
    const timer = setInterval(push, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, [token, user?.username, selfDevice?.deviceId]);

  useEffect(() => {
    if (!token || !user) return undefined;
    let alive = true;
    const load = async () => {
      const res = await account.listDevices(token);
      if (alive && res.ok) setDevices(res.devices || []);
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, [token, user?.username]);

  useEffect(() => {
    if (!token || !user) return;
    // The account token may arrive from a WeChat/browser callback.
    const fromUrl = account.consumeTokenFromUrl();
    if (fromUrl && fromUrl !== 'wechat_failed') setTokenState(fromUrl);
  }, [token, user]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = mode === 'register'
        ? await account.register(name.trim(), password, code.trim())
        : await account.login(name.trim(), password);
      if (!res.ok || !res.token) {
        setError(res.error || '操作失败');
        return;
      }
      account.setToken(res.token);
      setTokenState(res.token);
      setUser(res.user || null);
      account.saveProfile(res.user);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  if (!token || !user) {
    if (checking) {
      return (
        <div className="rd-auth-wrap">
          <div className="rd-auth-card rd-auth-loading">正在恢复登录...</div>
        </div>
      );
    }
    return (
      <div className="rd-auth-wrap">
        <div className="rd-auth-card">
          <div className="rd-auth-brand">
            <img src="/icon.svg" alt="" className="rd-auth-logo" />
            <h2>{mode === 'register' ? '创建账号' : '登录'}</h2>
          </div>

          <form className="rd-auth-form" onSubmit={submit}>
            <label className="rd-auth-field">
              <span>账号</span>
              <input
                className="rd-auth-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="用户名或邮箱"
                autoComplete="username"
                required
              />
            </label>
            <label className="rd-auth-field">
              <span>密码</span>
              <input
                className="rd-auth-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? '至少 6 位' : '输入密码'}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                required
              />
            </label>

            {emailMode && (
              <label className="rd-auth-field">
                <span>邮箱验证码</span>
                <div className="rd-auth-code-row">
                  <input
                    className="rd-auth-input"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="6 位验证码"
                    inputMode="numeric"
                    required
                  />
                  <button type="button" className="rd-auth-code-btn" onClick={sendCode} disabled={busy}>
                    {codeSent ? '重发' : '获取'}
                  </button>
                </div>
              </label>
            )}

            {error && <div className="rd-auth-error">{error}</div>}

            <button type="submit" className="rd-auth-submit" disabled={busy}>
              {busy ? '请稍候...' : mode === 'register' ? '注册并登录' : '登录'}
            </button>
          </form>

          <button
            type="button"
            className="rd-auth-switch"
            onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(''); }}
          >
            {mode === 'register' ? '已有账号，去登录' : '没有账号，去注册'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rd-section-stack">
      <div className="rd-page-head">
        <div><h2>{user.email || user.username}</h2></div>
        <button
          type="button"
          className="btn-ghost btn-xs"
          onClick={() => { account.setToken(''); setTokenState(''); setUser(null); setDevices([]); }}
        >
          退出
        </button>
      </div>

      <section className="rd-card rd-feature-card">
        <div className="rd-card-head">
          <div className="rd-title-group">
            <span className="dot online" />
            <div><h3>我的设备</h3></div>
          </div>
        </div>
        {devices.length ? (
          <div className="device-list">
            {devices.map((dev) => (
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
                <div className="rd-auth-device-actions">
                  {dev.deviceId === selfDevice?.deviceId ? (
                    <span className="rd-self-badge">本机</span>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary btn-xs"
                      disabled={!dev.online}
                      onClick={() => onConnectDevice?.(dev.deviceId)}
                    >
                      连接
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={async () => {
                      const res = await account.unbindDevice(dev.deviceId, token);
                      if (res.ok) { setUser(res.user); account.saveProfile(res.user); }
                      setDevices((cur) => cur.filter((d) => d.deviceId !== dev.deviceId));
                    }}
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="rd-muted-note">这台机器登录后会出现在这里</p>
        )}
      </section>
    </div>
  );
}
