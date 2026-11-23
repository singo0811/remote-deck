import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveTsnetBinary() {
  const name = process.platform === 'win32' ? 'remote-tsnet.exe' : 'remote-tsnet';
  const candidates = [
    path.resolve(__dirname, '../bin', name),
    path.join(path.dirname(process.execPath), name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export class TsnetBridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.rl = null;
    this.pendingTunnels = new Map();
    this.status = {
      available: Boolean(resolveTsnetBinary()),
      enabled: false,
      state: 'Stopped',
      tailscaleIp: '',
      hostname: '',
      authUrl: '',
      lastError: '',
      peers: [],
    };
  }

  get available() {
    return Boolean(resolveTsnetBinary());
  }

  getStatus() {
    return { ...this.status, available: this.available };
  }

  #ensureProcess() {
    if (this.proc) return true;
    const bin = resolveTsnetBinary();
    if (!bin) {
      this.status = {
        ...this.status,
        available: false,
        state: 'Unavailable',
        lastError: '未找到内置组网组件 (remote-tsnet)',
      };
      this.emit('status', this.getStatus());
      return false;
    }

    const proc = spawn(bin, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    this.rl = rl;
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg && msg.type === 'tunnel' && msg.reqId) {
          const entry = this.pendingTunnels.get(msg.reqId);
          if (entry) {
            this.pendingTunnels.delete(msg.reqId);
            clearTimeout(entry.timer);
            if (msg.port > 0) {
              entry.resolve(msg.port);
            } else {
              entry.reject(new Error(msg.error || 'openTunnel failed'));
            }
          }
          return;
        }
        if (msg && msg.type === 'status') {
          this.status = {
            available: true,
            enabled: Boolean(msg.enabled),
            state: msg.state || 'Stopped',
            tailscaleIp: msg.tailscaleIp || '',
            hostname: msg.hostname || '',
            authUrl: msg.authUrl || '',
            lastError: msg.lastError || '',
            peers: Array.isArray(msg.peers) ? msg.peers : [],
          };
          this.emit('status', this.getStatus());
        }
      } catch {
        // Ignore malformed status lines
      }
    });

    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null;
        this.rl?.close();
        this.rl = null;
        this.status = {
          ...this.status,
          enabled: false,
          state: 'Stopped',
          tailscaleIp: '',
          authUrl: '',
          peers: [],
        };
        this.emit('status', this.getStatus());
      }
    });

    return true;
  }

  #sendCmd(obj) {
    if (!this.proc?.stdin?.writable) return false;
    try {
      this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  start({ stateDir, hostname, authKey = '', forwardPort = 9601 }) {
    if (!this.#ensureProcess()) return false;
    this.status = {
      ...this.status,
      enabled: true,
      state: 'Starting',
      lastError: '',
    };
    this.emit('status', this.getStatus());
    return this.#sendCmd({
      op: 'start',
      stateDir,
      hostname,
      authKey,
      forwardPort,
    });
  }

  async openTunnel(targetIp, targetPort) {
    if (!this.proc) throw new Error('tsnet not running');
    const reqId = `tun-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingTunnels.has(reqId)) {
          this.pendingTunnels.delete(reqId);
          reject(new Error('tsnet openTunnel timeout'));
        }
      }, 6000);
      this.pendingTunnels.set(reqId, { resolve, reject, timer });
      const sent = this.#sendCmd({
        op: 'openTunnel',
        reqId,
        targetIp,
        targetPort: Number(targetPort) || 9603,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingTunnels.delete(reqId);
        reject(new Error('failed to send openTunnel command'));
      }
    });
  }

  logout() {
    if (!this.proc) return false;
    return this.#sendCmd({ op: 'logout' });
  }

  stop() {
    if (this.proc) {
      this.#sendCmd({ op: 'stop' });
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
    if (this.rl) {
      try {
        this.rl.close();
      } catch {}
      this.rl = null;
    }
    this.status = {
      ...this.status,
      enabled: false,
      state: 'Stopped',
      tailscaleIp: '',
      authUrl: '',
      peers: [],
    };
    this.emit('status', this.getStatus());
  }
}
