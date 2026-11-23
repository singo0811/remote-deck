import crypto from 'node:crypto';
import os from 'node:os';

/**
 * Classify an IPv4 or IPv6 address for route prioritization.
 */
export function classifyIp(ip) {
  if (!ip || typeof ip !== 'string') return 'unknown';
  const clean = ip.replace(/^::ffff:/i, '').split('%')[0];
  if (clean === '127.0.0.1' || clean === '::1') return 'loopback';

  if (clean.includes(':')) {
    const lower = clean.toLowerCase();
    if (lower.startsWith('fe80:')) return 'link-local';
    if (lower.startsWith('fd7a:115c:a1e0:')) return 'tailscale';
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'lan';
    if (lower === '::') return 'unknown';
    return 'public';
  }

  const parts = clean.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'unknown';
  }
  const [a, b] = parts;
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10) return 'lan';
  if (a === 172 && b >= 16 && b <= 31) return 'lan';
  if (a === 192 && b === 168) return 'lan';
  // RFC 6598 CGNAT (used by Tailscale 100.64.0.0/10)
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  return 'public';
}

const VIRTUAL_IFACE_RE = /vethernet|hyper-v|wsl|docker|vmware|vmnet|vbox|virtual|meta|clash|mihomo|sing-box|zerotier|\btun\d*|\btap\d*|\butun\d*|\bwg\d*|br-|veth|virbr|loopback|isatap|teredo/i;

/**
 * Return true when an interface name or address belongs to a virtual switch / TUN adapter.
 */
export function isVirtualEndpoint(ifaceName, ip) {
  if (ifaceName && VIRTUAL_IFACE_RE.test(ifaceName)) return true;
  if (typeof ip === 'string') {
    const clean = ip.replace(/^::ffff:/, '');
    const parts = clean.split('.').map((n) => Number(n));
    // 198.18.0.0/15 benchmarking / Clash-Meta TUN fake-IP range
    if (parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) {
      return true;
    }
  }
  return false;
}

/**
 * Collect local IPv4 and IPv6 addresses sorted by route preference
 * (physical IPv4 LAN first, then Tailscale, then IPv4 public / IPv6, then virtual).
 */
export function collectLocalAddresses(port, { includeLoopback = false, includeIpv6 = true } = {}) {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [ifaceName, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4' && (!includeIpv6 || entry.family !== 'IPv6')) continue;
      const addr = String(entry.address || '').split('%')[0];
      if (!addr) continue;
      const kind = classifyIp(addr);
      if (kind === 'link-local' || kind === 'unknown') continue;
      if (kind === 'loopback' && !includeLoopback) continue;
      const isV6 = entry.family === 'IPv6' || addr.includes(':');
      const hostPart = isV6 ? `[${addr}]` : addr;
      candidates.push({
        iface: ifaceName,
        ip: addr,
        family: isV6 ? 6 : 4,
        kind,
        virtual: isVirtualEndpoint(ifaceName, addr),
        wsUrl: `ws://${hostPart}:${port}/ws`,
        httpUrl: `http://${hostPart}:${port}`,
      });
    }
  }
  const rank = { lan: 0, tailscale: 1, public: 2, loopback: 3 };
  candidates.sort((a, b) => {
    const virtDiff = Number(a.virtual) - Number(b.virtual);
    if (virtDiff !== 0) return virtDiff;
    const famDiff = (a.family || 4) - (b.family || 4);
    if (famDiff !== 0) return famDiff;
    return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
  });
  return candidates;
}

/**
 * Prefer real physical adapters; fall back to virtual ones only when nothing else exists
 * (e.g. a user whose only route is a VPN/TUN adapter).
 */
export function pickShareableEndpoints(endpoints, { max = 3 } = {}) {
  const list = Array.isArray(endpoints) ? endpoints : [];
  const physical = list.filter((e) => !e.virtual);
  const chosen = physical.length > 0 ? physical : list;
  return chosen.slice(0, max);
}

/**
 * Build ICE server list for WebRTC P2P negotiation.
 * Supports static TURN credentials or coturn REST API time-limited HMAC-SHA1 credentials.
 */
export function buildIceServers(customServers = [], turnConfig = {}) {
  const servers = Array.isArray(customServers) && customServers.length > 0
    ? [...customServers]
    : [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.miwifi.com:3478' },
        { urls: 'stun:stun.qq.com:3478' },
      ];

  const rawTurnUrls = turnConfig?.turnUrls ?? process.env.TURN_URLS ?? '';
  const turnUrls = Array.isArray(rawTurnUrls)
    ? rawTurnUrls.map((u) => String(u).trim()).filter(Boolean)
    : String(rawTurnUrls)
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean);

  if (turnUrls.length > 0) {
    const turnSecret = String(turnConfig?.turnSecret ?? process.env.TURN_SECRET ?? '').trim();
    const staticUser = String(turnConfig?.turnUsername ?? process.env.TURN_USERNAME ?? '').trim();
    const staticCred = String(turnConfig?.turnCredential ?? process.env.TURN_CREDENTIAL ?? '').trim();
    if (turnSecret) {
      const ttl = Number(turnConfig?.ttlSec || 86400);
      const username = `${Math.floor(Date.now() / 1000) + ttl}:remotedeck`;
      const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      servers.push({ urls: turnUrls, username, credential });
    } else if (staticUser && staticCred) {
      servers.push({ urls: turnUrls, username: staticUser, credential: staticCred });
    } else {
      servers.push({ urls: turnUrls });
    }
  }
  return servers;
}
