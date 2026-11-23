import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MSG, buildIceServers } from '@remote-deck/shared';

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
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type');
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
