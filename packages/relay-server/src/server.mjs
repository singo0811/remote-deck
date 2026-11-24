import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MSG, buildIceServers } from '@remote-deck/shared';
import { createAccountStore, sendLoginCodeEmail } from './accounts.mjs';

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

const SIGNALING_TYPES = new Set([MSG.RTC_OFFER, MSG.RTC_ANSWER, MSG.RTC_ICE]);

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

export function createRelayServer(options = {}) {
  const port = Number(options.port ?? 9600);
  const host = options.host ?? '0.0.0.0';
  const relaySecret = options.relaySecret ?? '';
  const webDistDir = options.webDistDir ? path.resolve(options.webDistDir) : null;
  const iceServers = buildIceServers(options.iceServers);
  const startedAt = Date.now();
  const accounts = createAccountStore({
    dataDir: options.dataDir ?? process.env.RELAY_DATA_DIR ?? '',
    secret: options.accountSecret ?? process.env.ACCOUNT_SECRET ?? '',
  });

  /** @type {Map<string, any>} */
  const devices = new Map(); // deviceId -> device record
  /** @type {Map<string, any>} */
  const sessions = new Map(); // sessionId -> { sessionId, deviceId, controllerWs, agentSessionWs, relayReady, pendingFrames }

  async function serveStatic(req, res) {
    if (!webDistDir) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Web UI dist not configured' }));
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    let relPath = decodeURIComponent(url.pathname);
    if (relPath === '/') relPath = '/index.html';

    const resolved = path.resolve(webDistDir, `.${relPath}`);
    if (!resolved.startsWith(webDistDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let filePath = resolved;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch {
      // SPA fallback for route paths without file extension
      if (!path.extname(relPath)) {
        filePath = path.join(webDistDir, 'index.html');
      } else {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }

    try {
      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME_TYPES[ext] || 'application/octet-stream',
        'cache-control': ext === '.html' || ext === '.webmanifest' || relPath === '/sw.js'
          ? 'no-cache'
          : 'public, max-age=3600',
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        service: 'remote-deck-relay',
        onlineDevices: devices.size,
        activeSessions: sessions.size,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      }));
      return;
    }

    if (url.pathname.startsWith('/api/auth/')) {
      const action = url.pathname.slice('/api/auth/'.length);
      const readBody = () => new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; if (raw.length > 8192) req.destroy(); });
        req.on('end', () => {
          try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
        });
        req.on('error', () => resolve({}));
      });
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

      if (action === 'register' && req.method === 'POST') {
        const body = await readBody();
        const result = accounts.register(body.username, body.password, body.code);
        json(result.ok ? 200 : 400, result);
        return;
      }
      if (action === 'login' && req.method === 'POST') {
        const body = await readBody();
        const result = accounts.login(body.username, body.password);
        json(result.ok ? 200 : 401, result);
        return;
      }
      if (action === 'email/code' && req.method === 'POST') {
        const body = await readBody();
        const issued = accounts.issueEmailCode(body.email);
        if (!issued.ok) { json(400, issued); return; }
        const sent = await sendLoginCodeEmail({
          to: issued.email,
          code: issued.code,
          apiUrl: process.env.EMAIL_API_URL || '',
          apiKey: process.env.EMAIL_API_KEY || '',
          from: process.env.EMAIL_FROM || '',
        });
        json(sent.ok ? 200 : 503, sent.ok ? { ok: true } : { ok: false, error: sent.error });
        return;
      }
      if (action === 'email/verify' && req.method === 'POST') {
        const body = await readBody();
        const result = accounts.verifyEmailCode(body.email, body.code);
        json(result.ok ? 200 : 401, result);
        return;
      }
      if (action === 'wechat/start' && req.method === 'GET') {
        const appId = process.env.WECHAT_APP_ID || '';
        if (!appId) { json(503, { ok: false, error: '微信登录未配置' }); return; }
        const redirect = `${url.origin}/api/auth/wechat/callback`;
        const target = new URL('https://open.weixin.qq.com/connect/qrconnect');
        target.searchParams.set('appid', appId);
        target.searchParams.set('redirect_uri', redirect);
        target.searchParams.set('response_type', 'code');
        target.searchParams.set('scope', 'snsapi_login');
        target.searchParams.set('state', crypto.randomBytes(8).toString('hex'));
        res.writeHead(302, { location: target.toString() });
        res.end();
        return;
      }
      if (action === 'wechat/callback' && req.method === 'GET') {
        const appId = process.env.WECHAT_APP_ID || '';
        const appSecret = process.env.WECHAT_APP_SECRET || '';
        const code = url.searchParams.get('code') || '';
        if (!appId || !appSecret || !code) {
          res.writeHead(302, { location: '/?login=wechat_failed' });
          res.end();
          return;
        }
        try {
          const tokenRes = await fetch(
            'https://api.weixin.qq.com/sns/oauth2/access_token' +
              `?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}` +
              `&code=${encodeURIComponent(code)}&grant_type=authorization_code`,
            { signal: AbortSignal.timeout(10000) },
          );
          const tokenJson = await tokenRes.json();
          const openid = tokenJson?.openid;
          if (!openid) throw new Error(tokenJson?.errmsg || '微信授权失败');
          const result = accounts.loginWithWechat(openid, '');
          res.writeHead(302, { location: `/?account_token=${encodeURIComponent(result.token)}` });
          res.end();
        } catch {
          res.writeHead(302, { location: '/?login=wechat_failed' });
          res.end();
        }
        return;
      }
      if (action === 'device' && req.method === 'POST') {
        const body = await readBody();
        const result = accounts.upsertDevice(token, body);
        json(result.ok ? 200 : 401, result);
        return;
      }
      if (action === 'devices' && req.method === 'GET') {
        const result = accounts.listDevices(token, (id) => {
          const dev = devices.get(id);
          return Boolean(dev && dev.controlWs && dev.controlWs.readyState === WebSocket.OPEN);
        });
        json(result.ok ? 200 : 401, result);
        return;
      }
      if (action === 'me' && req.method === 'GET') {
        const user = accounts.auth(token);
        json(user ? 200 : 401, user ? { ok: true, user } : { ok: false, error: '未登录' });
        return;
      }
      if (action === 'bind' && req.method === 'POST') {
        const body = await readBody();
        const result = accounts.bindDevice(token, body.deviceId);
        json(result.ok ? 200 : 401, result);
        return;
      }
      if (action === 'unbind' && req.method === 'POST') {
        const body = await readBody();
        const result = accounts.unbindDevice(token, body.deviceId);
        json(result.ok ? 200 : 401, result);
        return;
      }
      json(404, { ok: false, error: '未知接口' });
      return;
    }

    if (url.pathname === '/api/ice-servers') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ iceServers }));
      return;
    }

    if (url.pathname === '/api/devices') {
      const list = Array.from(devices.values()).map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        platform: d.platform,
        capabilities: d.capabilities,
        displays: d.displays,
        lanEndpoints: d.lanEndpoints,
        tunnelUrl: d.tunnelUrl || null,
        online: d.controlWs.readyState === WebSocket.OPEN,
        lastSeenAt: d.lastSeenAt,
      }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ devices: list }));
      return;
    }

    await serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url);
    });
  });

  function cleanupSession(sessionId, leaverRole) {
    const sess = sessions.get(sessionId);
    if (!sess) return;
    sessions.delete(sessionId);
    if (leaverRole === 'controller') {
      if (sess.agentSessionWs && sess.agentSessionWs.readyState === WebSocket.OPEN) {
        sendJson(sess.agentSessionWs, { type: MSG.PEER_LEFT, sessionId, role: 'controller' });
        sess.agentSessionWs.close(1000, 'controller left');
      }
      const dev = devices.get(sess.deviceId);
      if (dev) {
        sendJson(dev.controlWs, { type: MSG.PEER_LEFT, sessionId, role: 'controller' });
      }
    } else if (leaverRole === 'agent') {
      if (sess.controllerWs && sess.controllerWs.readyState === WebSocket.OPEN) {
        sendJson(sess.controllerWs, { type: MSG.PEER_LEFT, sessionId, role: 'agent' });
      }
    }
  }

  wss.on('connection', (ws, _req, url) => {
    const roleParam = url.searchParams.get('role');
    const sessionParam = url.searchParams.get('sessionId');
    const deviceParam = url.searchParams.get('deviceId');
    const tokenParam = url.searchParams.get('token');

    // Dedicated data-tunnel socket opened by Host Agent for one controller session
    if (roleParam === 'agent-session' && sessionParam && deviceParam) {
      const dev = devices.get(deviceParam);
      const sess = sessions.get(sessionParam);
      if (!dev || !sess || dev.sessionBindSecret !== tokenParam || sess.deviceId !== deviceParam) {
        ws.close(4003, 'invalid agent session binding');
        return;
      }

      sess.agentSessionWs = ws;
      sess.relayReady = true;

      // Flush buffered frames sent while agent session socket was connecting
      for (const frame of sess.pendingFrames) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(frame.data, { binary: frame.isBinary });
        }
      }
      sess.pendingFrames = [];

      sendJson(sess.controllerWs, { type: MSG.RELAY_READY, sessionId: sessionParam });

      ws.on('message', (data, isBinary) => {
        if (sess.controllerWs && sess.controllerWs.readyState === WebSocket.OPEN) {
          sess.controllerWs.send(data, { binary: isBinary });
        }
      });

      ws.on('close', () => {
        cleanupSession(sessionParam, 'agent');
      });
      return;
    }

    // Control / Signaling / Controller connection
    let boundDeviceId = null;
    let boundControllerSessionId = null;

    ws.on('message', (data, isBinary) => {
      if (boundControllerSessionId) {
        const sess = sessions.get(boundControllerSessionId);
        if (!sess) return;

        // Check if this is a WebRTC signaling message intended for agent's control WS
        if (!isBinary) {
          const text = data.toString('utf8');
          if (text.startsWith('{')) {
            try {
              const parsed = JSON.parse(text);
              if (parsed && SIGNALING_TYPES.has(parsed.type)) {
                const dev = devices.get(sess.deviceId);
                if (dev && dev.controlWs.readyState === WebSocket.OPEN) {
                  sendJson(dev.controlWs, { ...parsed, sessionId: sess.sessionId });
                }
                return;
              }
            } catch {
              // Fall through to relay data
            }
          }
        }

        if (sess.agentSessionWs && sess.agentSessionWs.readyState === WebSocket.OPEN) {
          sess.agentSessionWs.send(data, { binary: isBinary });
        } else if (sess.pendingFrames.length < 128) {
          sess.pendingFrames.push({ data, isBinary });
        }
        return;
      }

      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      // Host Agent registers on Relay
      if (msg.type === MSG.AGENT_REGISTER) {
        if (relaySecret && msg.relaySecret !== relaySecret) {
          sendJson(ws, { type: MSG.ERROR, code: 'invalid_relay_secret', error: 'Invalid relay secret' });
          ws.close(4001, 'invalid relay secret');
          return;
        }
        const deviceId = String(msg.deviceId || '').trim();
        if (!deviceId) {
          sendJson(ws, { type: MSG.ERROR, code: 'missing_device_id', error: 'deviceId is required' });
          return;
        }
        const existing = devices.get(deviceId);
        if (existing && existing.controlWs !== ws && existing.controlWs.readyState === WebSocket.OPEN) {
          existing.controlWs.close(4009, 'replaced by new agent connection');
        }

        const sessionBindSecret = crypto.randomBytes(24).toString('hex');
        boundDeviceId = deviceId;
        devices.set(deviceId, {
          deviceId,
          deviceName: msg.deviceName || deviceId,
          platform: msg.platform || 'unknown',
          capabilities: msg.capabilities || {},
          displays: Array.isArray(msg.displays) ? msg.displays : [],
          lanEndpoints: Array.isArray(msg.lanEndpoints) ? msg.lanEndpoints : [],
          tunnelUrl: msg.tunnelUrl || null,
          controlWs: ws,
          sessionBindSecret,
          lastSeenAt: Date.now(),
        });

        sendJson(ws, {
          type: MSG.AGENT_REGISTERED,
          deviceId,
          sessionBindSecret,
          iceServers,
        });
        return;
      }

      if (msg.type === MSG.AGENT_HEARTBEAT && boundDeviceId) {
        const dev = devices.get(boundDeviceId);
        if (dev) {
          dev.lastSeenAt = Date.now();
          if (Array.isArray(msg.displays)) dev.displays = msg.displays;
          if (Array.isArray(msg.lanEndpoints)) dev.lanEndpoints = msg.lanEndpoints;
          if (msg.tunnelUrl !== undefined) dev.tunnelUrl = msg.tunnelUrl;
        }
        return;
      }

      // Agent sends WebRTC signaling back to Controller
      if (boundDeviceId && SIGNALING_TYPES.has(msg.type) && msg.sessionId) {
        const sess = sessions.get(msg.sessionId);
        if (sess && sess.deviceId === boundDeviceId && sess.controllerWs.readyState === WebSocket.OPEN) {
          sendJson(sess.controllerWs, msg);
        }
        return;
      }

      // Controller initiates connection to a target deviceId
      if (msg.type === MSG.CONTROLLER_CONNECT) {
        const targetId = String(msg.deviceId || '').trim();
        const dev = devices.get(targetId);
        if (!dev || dev.controlWs.readyState !== WebSocket.OPEN) {
          sendJson(ws, {
            type: MSG.ERROR,
            code: 'device_offline',
            error: `Device ${targetId || '(empty)'} is offline`,
          });
          return;
        }

        const sessionId = crypto.randomUUID();
        boundControllerSessionId = sessionId;
        sessions.set(sessionId, {
          sessionId,
          deviceId: targetId,
          controllerWs: ws,
          agentSessionWs: null,
          relayReady: false,
          pendingFrames: [],
        });

        sendJson(ws, {
          type: MSG.ROUTE_CANDIDATES,
          sessionId,
          deviceId: dev.deviceId,
          deviceName: dev.deviceName,
          platform: dev.platform,
          displays: dev.displays,
          lanEndpoints: dev.lanEndpoints,
          tunnelUrl: dev.tunnelUrl || null,
          iceServers,
          relayAvailable: true,
        });

        sendJson(dev.controlWs, {
          type: MSG.CONTROLLER_CONNECT,
          sessionId,
          iceServers,
        });
      }
    });

    ws.on('close', () => {
      if (boundDeviceId) {
        const dev = devices.get(boundDeviceId);
        if (dev && dev.controlWs === ws) {
          devices.delete(boundDeviceId);
          for (const [sid, sess] of sessions.entries()) {
            if (sess.deviceId === boundDeviceId) {
              cleanupSession(sid, 'agent');
            }
          }
        }
      }
      if (boundControllerSessionId) {
        cleanupSession(boundControllerSessionId, 'controller');
      }
    });
  });

  return {
    httpServer,
    wss,
    devices,
    sessions,
    async start() {
      await accounts.init();
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      const addr = httpServer.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      // A relay without a shared secret accepts any agent that registers, so a
      // publicly reachable instance would let anyone inject a fake device into
      // the controller's device list. Warn loudly instead of failing silently.
      if (!relaySecret) {
        const loopbackOnly =
          host === '127.0.0.1' || host === '::1' || host === 'localhost';
        const banner = loopbackOnly
          ? `[relay] listening on ${host}:${boundPort} without --secret (loopback only, OK)`
          : `[relay] WARNING: listening on ${host}:${boundPort} WITHOUT --secret/RELAY_SECRET — ` +
            'any client can register an agent. Set a secret before exposing this port.';
        if (loopbackOnly) console.log(banner);
        else console.warn(banner);
      } else {
        console.log(`[relay] listening on ${host}:${boundPort} (secret required)`);
      }
      return {
        port: boundPort,
        host,
      };
    },
    async stop() {
      for (const client of wss.clients) {
        client.close(1001, 'server shutting down');
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
