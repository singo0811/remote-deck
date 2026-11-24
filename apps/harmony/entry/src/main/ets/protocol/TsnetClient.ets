import tsnetBridge from 'libremotedeck_ts.so';
import { jsonArr, jsonAsObject, jsonBool, jsonStr, parseJsonObject } from './Protocol';

export interface TsnetPeer {
  id: string;
  name: string;
  ip: string;
  os: string;
  online: boolean;
  curAddr: string;
  relay: string;
}

export interface TsnetStatus {
  enabled: boolean;
  state: string;
  tailscaleIp: string;
  hostname: string;
  authUrl: string;
  lastError: string;
  peers: TsnetPeer[];
  logs?: string[];
}

export function emptyTsnetStatus(): TsnetStatus {
  return {
    enabled: false,
    state: 'Stopped',
    tailscaleIp: '',
    hostname: '',
    authUrl: '',
    lastError: '',
    peers: [],
  };
}

export function isTailscaleIp(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 100 && b >= 64 && b <= 127;
}

interface ParsedHostPort {
  scheme: string;
  host: string;
  port: number;
  suffix: string;
}

function splitUrlHostPort(rawUrl: string): ParsedHostPort | null {
  const idx = rawUrl.indexOf('://');
  if (idx < 0) return null;
  const scheme = rawUrl.slice(0, idx);
  const rest = rawUrl.slice(idx + 3);
  const slashIdx = rest.indexOf('/');
  const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  const suffix = slashIdx >= 0 ? rest.slice(slashIdx) : '';
  if (!authority || authority.startsWith('[')) {
    return null;
  }
  const colonIdx = authority.indexOf(':');
  const host = colonIdx >= 0 ? authority.slice(0, colonIdx) : authority;
  const port = colonIdx >= 0
    ? Number(authority.slice(colonIdx + 1))
    : (scheme === 'https' || scheme === 'wss' ? 443 : 80);
  if (!host || Number.isNaN(port) || port <= 0) return null;
  return { scheme, host, port, suffix };
}

export class TsnetClient {
  static lastStartError: string = '';

  static start(stateDir: string, hostname: string, authKey: string = ''): boolean {
    TsnetClient.lastStartError = '';
    try {
      const raw = tsnetBridge.start(stateDir, hostname, authKey);
      const parsed = parseJsonObject(raw);
      const ok = jsonBool(parsed, 'ok', false);
      if (!ok) {
        TsnetClient.lastStartError = jsonStr(parsed, 'error', raw || 'start returned false');
        console.error('[RemoteDeck-Tsnet] start failed:', TsnetClient.lastStartError);
      }
      return ok;
    } catch (e) {
      TsnetClient.lastStartError = e instanceof Error ? e.message : String(e);
      console.error('[RemoteDeck-Tsnet] start exception:', TsnetClient.lastStartError);
      return false;
    }
  }

  static stop(): void {
    try {
      tsnetBridge.stop();
    } catch {
      // Ignore native stop error
    }
  }

  static logout(): void {
    try {
      tsnetBridge.logout();
    } catch {
      // Ignore native logout error
    }
  }

  static getStatus(): TsnetStatus {
    try {
      const raw = tsnetBridge.getStatus();
      const obj = parseJsonObject(raw);
      if (!obj) return emptyTsnetStatus();
      const rawPeers = jsonArr(obj, 'peers');
      const peers: TsnetPeer[] = [];
      for (let i = 0; i < rawPeers.length; i++) {
        const p = jsonAsObject(rawPeers[i]);
        if (!p) continue;
        const ip = jsonStr(p, 'ip');
        if (!ip) continue;
        peers.push({
          id: jsonStr(p, 'id'),
          name: jsonStr(p, 'name', ip),
          ip,
          os: jsonStr(p, 'os'),
          online: jsonBool(p, 'online', false),
          curAddr: jsonStr(p, 'curAddr'),
          relay: jsonStr(p, 'relay'),
        });
      }
      const rawLogs = jsonArr(obj, 'logs');
      const logs: string[] = [];
      for (let i = 0; i < rawLogs.length; i++) {
        if (typeof rawLogs[i] === 'string') {
          logs.push(rawLogs[i] as string);
        }
      }
      // tsnet reports warming-up as health warnings while the node starts; that is
      // normal progress, not a failure worth showing in red.
      const rawError = jsonStr(obj, 'lastError');
      const lastError = /warming-up|is starting|Please wait/i.test(rawError) ? '' : rawError;
      return {
        enabled: jsonBool(obj, 'enabled', false),
        state: jsonStr(obj, 'state', 'Stopped'),
        tailscaleIp: jsonStr(obj, 'tailscaleIp'),
        hostname: jsonStr(obj, 'hostname'),
        authUrl: jsonStr(obj, 'authUrl'),
        lastError,
        peers,
        logs,
      };
    } catch {
      return emptyTsnetStatus();
    }
  }

  static openTunnel(targetIp: string, targetPort: number = 9601): number {
    try {
      return tsnetBridge.openTunnel(targetIp, targetPort);
    } catch {
      return 0;
    }
  }

  static closeAllTunnels(): void {
    try {
      tsnetBridge.closeAllTunnels();
    } catch {
      // Ignore
    }
  }

  /**
   * When embedded tsnet is active and a URL targets a Tailscale 100.64/10 IP,
   * open a local loopback forwarder and return the rewritten 127.0.0.1:<port> URL.
   */
  static rewriteUrlThroughTunnel(rawUrl: string): string {
    const parts = splitUrlHostPort(rawUrl);
    if (!parts || !isTailscaleIp(parts.host)) {
      return rawUrl;
    }
    const st = TsnetClient.getStatus();
    if (!st.enabled || !st.tailscaleIp) {
      return rawUrl;
    }
    const localPort = TsnetClient.openTunnel(parts.host, parts.port);
    if (localPort <= 0) {
      return rawUrl;
    }
    return `${parts.scheme}://127.0.0.1:${localPort}${parts.suffix}`;
  }

  static opusInit(sampleRate: number, channels: number, head?: ArrayBuffer): boolean {
    try {
      return tsnetBridge.audioOpusInit(sampleRate, channels, head);
    } catch {
      return false;
    }
  }

  static opusDecode(packet: ArrayBuffer, sampleRate: number, channels: number, head?: ArrayBuffer): Uint8Array {
    try {
      const ab = tsnetBridge.audioOpusDecode(packet, sampleRate, channels, head);
      return ab && ab.byteLength > 0 ? new Uint8Array(ab) : new Uint8Array(0);
    } catch {
      return new Uint8Array(0);
    }
  }

  static opusDestroy(): void {
    try {
      tsnetBridge.audioOpusDestroy();
    } catch {
      // Ignore
    }
  }
}
