const TOKEN_KEY = 'rd_account_token';
const PROFILE_KEY = 'rd_account_profile';
const PUBLIC_SERVER = 'https://miaosizhineng.online';

/**
 * Account calls must reach the relay, which owns /api/auth. When the page is
 * opened from the host itself (127.0.0.1 or a LAN address) that origin has no
 * account API, so fall back to the public relay.
 */
export function accountApiBase() {
  if (typeof window === 'undefined') return PUBLIC_SERVER;
  const { hostname, origin } = window.location;
  const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i.test(hostname);
  const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
  if (isLoopback || isPrivate) return PUBLIC_SERVER;
  return origin;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(PROFILE_KEY);
    }
  } catch {}
}

/** Cache the last profile so the account page renders instantly on reopen. */
export function saveProfile(user) {
  try {
    if (user) localStorage.setItem(PROFILE_KEY, JSON.stringify(user));
  } catch {}
}

export function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${accountApiBase()}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, ...data };
}

export const login = (username, password) => call('/api/auth/login', { method: 'POST', body: { username, password } });
export const bindDevice = (deviceId, token) => call('/api/auth/bind', { method: 'POST', body: { deviceId }, token });
export const register = (username, password, code) => call('/api/auth/register', { method: 'POST', body: { username, password, code } });
export const requestEmailCode = (email) => call('/api/auth/email/code', { method: 'POST', body: { email } });
export const verifyEmailCode = (email, code) => call('/api/auth/email/verify', { method: 'POST', body: { email, code } });
export const me = (token) => call('/api/auth/me', { token });
export const listDevices = (token) => call('/api/auth/devices', { token });
export const registerDevice = (device, token) => call('/api/auth/device', { method: 'POST', body: device, token });
export const unbindDevice = (deviceId, token) => call('/api/auth/unbind', { method: 'POST', body: { deviceId }, token });

/**
 * The WeChat callback redirects back with ?account_token=...; pick it up once,
 * persist it, and strip it from the address bar.
 */
export function consumeTokenFromUrl() {
  if (typeof window === 'undefined') return '';
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('account_token') || '';
    const failed = url.searchParams.get('login') === 'wechat_failed';
    if (!token && !failed) return '';
    if (token) setToken(token);
    url.searchParams.delete('account_token');
    url.searchParams.delete('login');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return failed ? 'wechat_failed' : token;
  } catch {
    return '';
  }
}
