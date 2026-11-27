/**
 * Proxy support for the relay WebSocket.
 *
 * Many Windows machines route all traffic through a local HTTP proxy
 * (Clash / V2Ray mixed port) and block direct connections. Node and `ws` ignore
 * the system proxy, so the relay handshake hangs forever there. This module
 * builds an https.Agent that CONNECTs through the proxy and then runs TLS to the
 * real host, preserving the certificate hostname.
 */
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

function parseProxy(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (url.protocol !== 'http:') return null;
    return { host: url.hostname, port: Number(url.port || 80) };
  } catch {
    return null;
  }
}

/** Proxy from the environment first, then the Windows Internet Settings. */
export function resolveProxy() {
  const env = process.env;
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const proxy = parseProxy(env[key]);
    if (proxy) return proxy;
  }
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { encoding: 'utf8', windowsHide: true },
    );
    const match = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!match) return null;
    const first = match[1].split(';')[0];
    const spec = first.includes('=') ? first.split('=')[1] : first;
    const proxy = parseProxy(spec);
    return proxy;
  } catch {
    return null;
  }
}

/** https.Agent whose sockets tunnel through the given HTTP proxy. */
export function createProxyAgent(proxy, targetHost) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const host = options.host || targetHost;
    const port = options.port || 443;
    const raw = net.connect({ host: proxy.host, port: proxy.port });

    const secure = tls.connect({ socket: raw, servername: host, host });
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk.toString('latin1');
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = buffered.split('\r\n')[0] || '';
      raw.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(status)) {
        const err = new Error(`proxy CONNECT rejected: ${status}`);
        secure.destroy(err);
        raw.destroy();
        return;
      }
      const rest = buffered.slice(end + 4);
      if (rest) raw.unshift(Buffer.from(rest, 'latin1'));
    };
    raw.on('data', onData);
    raw.once('connect', () => {
      raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });
    raw.once('error', (err) => secure.destroy(err));

    if (typeof callback === 'function') {
      secure.once('secureConnect', () => callback(null, secure));
      secure.once('error', (err) => callback(err));
    }
    return secure;
  };
  return agent;
}
