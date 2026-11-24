import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Account store: password, email one-time code and WeChat openid logins all
 * resolve to the same user record (username = email or wx_<openid>).
 * Persisted as JSON so the relay stays dependency-free and easy to back up.
 */
export function createAccountStore({ dataDir, secret, tokenTtlSec = 30 * 24 * 3600 } = {}) {
  const dir = dataDir ? path.resolve(dataDir) : null;
  const file = dir ? path.join(dir, 'accounts.json') : null;
  const signingSecret = secret || crypto.randomBytes(32).toString('hex');
  let state = { users: {} };
  let saveTimer = null;
  const emailCodes = new Map(); // email -> { code, exp, tries }

  const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');

  const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || ''));
  const normalizeName = (value) => String(value || '').trim().toLowerCase();

  async function load() {
    if (!file) return;
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed && typeof parsed.users === 'object') state = { users: parsed.users };
    } catch {}
  }

  function scheduleSave() {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await fs.mkdir(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
        await fs.rename(tmp, file);
      } catch {}
    }, 200);
  }

  const sign = (payload) => crypto.createHmac('sha256', signingSecret).update(payload).digest('base64url');

  function issueToken(username) {
    const body = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + tokenTtlSec * 1000 })).toString('base64url');
    return `${body}.${sign(body)}`;
  }

  function verifyToken(token) {
    const [body, mac] = String(token || '').trim().split('.');
    if (!body || !mac) return null;
    const expected = sign(body);
    if (mac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!data?.u || !data?.exp || Date.now() > data.exp) return null;
      return state.users[data.u] ? data.u : null;
    } catch {
      return null;
    }
  }

  const publicUser = (user) => ({
    username: user.username,
    email: user.email || '',
    wechatBound: Boolean(user.wechatOpenId),
    nickname: user.nickname || '',
    devices: Array.isArray(user.devices) ? user.devices : [],
    createdAt: user.createdAt,
  });

  function ensureUser(name, extra = {}) {
    if (!state.users[name]) {
      state.users[name] = {
        username: name,
        devices: [],
        createdAt: Date.now(),
        ...extra,
      };
      scheduleSave();
    }
    return state.users[name];
  }

  return {
    async init() {
      await load();
      return this;
    },

    register(username, password, code) {
      const name = normalizeName(username);
      const pass = String(password || '');
      const emailAccount = isEmail(name);
      if (!emailAccount && !/^[a-z0-9_.-]{3,32}$/.test(name)) {
        return { ok: false, error: '用户名需 3-32 位字母数字，或使用邮箱' };
      }
      if (pass.length < 6) return { ok: false, error: '密码至少 6 位' };
      if (state.users[name]) return { ok: false, error: '账号已存在' };
      // An email address is only a valid account id once the owner proved it.
      if (emailAccount) {
        const entry = emailCodes.get(name);
        if (!entry) return { ok: false, error: '请先获取邮箱验证码', needsEmailCode: true };
        if (Date.now() > entry.exp) {
          emailCodes.delete(name);
          return { ok: false, error: '验证码已过期', needsEmailCode: true };
        }
        if (String(code || '').trim() !== entry.code) {
          entry.tries += 1;
          if (entry.tries > 6) emailCodes.delete(name);
          return { ok: false, error: '验证码不正确', needsEmailCode: true };
        }
        emailCodes.delete(name);
      }
      const salt = crypto.randomBytes(16).toString('hex');
      state.users[name] = {
        username: name,
        salt,
        hash: hashPassword(pass, salt),
        email: emailAccount ? name : '',
        devices: [],
        createdAt: Date.now(),
      };
      scheduleSave();
      return { ok: true, token: issueToken(name), user: publicUser(state.users[name]) };
    },

    login(username, password) {
      const name = normalizeName(username);
      const user = state.users[name];
      if (!user || !user.hash) return { ok: false, error: '账号或密码错误' };
      const hash = hashPassword(String(password || ''), user.salt);
      if (hash.length !== user.hash.length) return { ok: false, error: '账号或密码错误' };
      if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.hash))) {
        return { ok: false, error: '账号或密码错误' };
      }
      return { ok: true, token: issueToken(name), user: publicUser(user) };
    },

    auth(token) {
      const username = verifyToken(token);
      if (!username) return null;
      return publicUser(state.users[username]);
    },

    /** Create a 6-digit code. The caller is responsible for delivering it. */
    issueEmailCode(emailRaw) {
      const email = normalizeName(emailRaw);
      if (!isEmail(email)) return { ok: false, error: '邮箱格式不正确' };
      const code = String(crypto.randomInt(100000, 1000000));
      emailCodes.set(email, { code, exp: Date.now() + 10 * 60 * 1000, tries: 0 });
      return { ok: true, email, code };
    },

    verifyEmailCode(emailRaw, codeRaw) {
      const email = normalizeName(emailRaw);
      const entry = emailCodes.get(email);
      if (!entry) return { ok: false, error: '请先获取验证码' };
      if (Date.now() > entry.exp) {
        emailCodes.delete(email);
        return { ok: false, error: '验证码已过期' };
      }
      entry.tries += 1;
      if (entry.tries > 6) {
        emailCodes.delete(email);
        return { ok: false, error: '尝试次数过多，请重新获取' };
      }
      if (String(codeRaw || '').trim() !== entry.code) return { ok: false, error: '验证码不正确' };
      emailCodes.delete(email);
      const user = ensureUser(email, { email });
      return { ok: true, token: issueToken(email), user: publicUser(user) };
    },

    /** Upsert a WeChat user by openid and return a token. */
    loginWithWechat(openid, nickname) {
      const key = `wx_${String(openid || '').trim()}`;
      if (!openid) return { ok: false, error: '微信授权失败' };
      const user = ensureUser(key, { wechatOpenId: String(openid), nickname: nickname || '' });
      if (nickname && !user.nickname) {
        user.nickname = nickname;
        scheduleSave();
      }
      return { ok: true, token: issueToken(key), user: publicUser(user) };
    },

    bindDevice(token, deviceId) {
      const username = verifyToken(token);
      const id = String(deviceId || '').trim().toUpperCase();
      if (!username || !id) return { ok: false, error: '未登录' };
      const user = state.users[username];
      user.devices = Array.isArray(user.devices) ? user.devices : [];
      if (!user.devices.includes(id)) user.devices.push(id);
      scheduleSave();
      return { ok: true, user: publicUser(user) };
    },

    unbindDevice(token, deviceId) {
      const username = verifyToken(token);
      const id = String(deviceId || '').trim().toUpperCase();
      if (!username) return { ok: false, error: '未登录' };
      const user = state.users[username];
      user.devices = (user.devices || []).filter((d) => d !== id);
      if (user.deviceMeta) delete user.deviceMeta[id];
      scheduleSave();
      return { ok: true, user: publicUser(user) };
    },

    /** Register/refresh one machine that is signed in to this account. */
    upsertDevice(token, device) {
      const username = verifyToken(token);
      const id = String(device?.deviceId || '').trim().toUpperCase();
      if (!username || !id) return { ok: false, error: '未登录' };
      const user = state.users[username];
      user.devices = Array.isArray(user.devices) ? user.devices : [];
      if (!user.devices.includes(id)) user.devices.push(id);
      user.deviceMeta = user.deviceMeta || {};
      user.deviceMeta[id] = {
        name: String(device.name || '').slice(0, 48),
        platform: String(device.platform || '').slice(0, 16),
        kind: String(device.kind || 'pc').slice(0, 16),
        lastSeenAt: Date.now(),
      };
      scheduleSave();
      return { ok: true, user: publicUser(user) };
    },

    /** Detailed view of an account's machines with liveness. */
    listDevices(token, isOnline) {
      const username = verifyToken(token);
      if (!username) return { ok: false, error: '未登录' };
      const user = state.users[username];
      const meta = user.deviceMeta || {};
      const devices = (user.devices || []).map((id) => {
        const info = meta[id] || {};
        const lastSeen = Number(info.lastSeenAt || 0);
        const fresh = lastSeen > 0 && Date.now() - lastSeen < 120000;
        return {
          deviceId: id,
          name: info.name || id,
          platform: info.platform || '',
          kind: info.kind || 'pc',
          lastSeenAt: lastSeen,
          online: Boolean(isOnline ? isOnline(id) || fresh : fresh),
        };
      });
      return { ok: true, devices };
    },
  };
}

/** Deliver a login code through a generic HTTP email API (Resend/SendGrid/self-hosted). */
export async function sendLoginCodeEmail({ to, code, apiUrl, apiKey, from }) {
  if (!apiUrl) return { ok: false, error: '邮件服务未配置' };
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        from: from || 'RemoteDeck <no-reply@remotedeck.local>',
        to,
        subject: 'RemoteDeck 登录验证码',
        text: `你的登录验证码是 ${code}，10 分钟内有效。`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `邮件发送失败 (${res.status})` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '邮件发送失败' };
  }
}
