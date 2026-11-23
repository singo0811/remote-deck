import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getCachedBinaryPath() {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const baseDir =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'remote-deck', 'bin')
      : path.join(os.homedir(), '.local', 'share', 'remote-deck', 'bin');
  return path.join(baseDir, name);
}

function getDownloadUrl() {
  if (process.platform === 'win32') {
    return process.arch === 'ia32'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz';
  }
  return process.arch === 'arm64'
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
}

function isRunnableBinary(binPath) {
  try {
    execFileSync(binPath, ['--version'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function getDownloadCandidates() {
  const raw = getDownloadUrl();
  if (raw.endsWith('.tgz')) return [raw];
  return [
    raw,
    `https://ghfast.top/${raw}`,
    `https://gh-proxy.com/${raw}`,
  ];
}

function resolveExistingBinary() {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const bundledBin = path.resolve(__dirname, '../bin', name);
  const candidates = [bundledBin, getCachedBinaryPath()];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'cloudflared.exe',
    );
  } else {
    candidates.push('/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared', 'cloudflared');
  }
  for (const cand of candidates) {
    if (cand.includes(path.sep) && !existsSync(cand)) continue;
    if (isRunnableBinary(cand)) return cand;
  }
  return null;
}

async function downloadCloudflared(destPath) {
  const candidates = getDownloadCandidates();
  if (candidates[0].endsWith('.tgz')) {
    throw new Error('请先通过 brew install cloudflared 安装隧道组件');
  }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp`;
  let lastErr = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
      if (!resp.ok || !resp.body) {
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
      await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmpPath));
      if (process.platform !== 'win32') {
        await fs.chmod(tmpPath, 0o755);
      }
      await fs.rename(tmpPath, destPath);
      if (!isRunnableBinary(destPath)) {
        lastErr = new Error('下载的隧道组件无法执行');
        continue;
      }
      return destPath;
    } catch (err) {
      lastErr = err;
      try {
        await fs.rm(tmpPath, { force: true });
      } catch {}
    }
  }
  throw new Error(`下载隧道组件失败: ${lastErr?.message || '网络不可达'}`);
}

/**
 * Cloudflare tunnel launcher.
 * - Quick tunnel: zero-config random `*.trycloudflare.com` hostname (default).
 * - Named tunnel: `cloudflared tunnel run --token <t>` with a fixed hostname the
 *   user bound in the Cloudflare dashboard, so the URL never changes.
 */
export class QuickTunnel {
  constructor({ localPort, onUrl, onLog, onStatus, token = '', hostname = '' }) {
    this.localPort = localPort;
    this.onUrl = onUrl;
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.token = String(token || '').trim();
    this.hostname = String(hostname || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    this.proc = null;
    this.publicUrl = null;
    this.active = false;
    this.state = 'idle';
    this.error = '';
  }

  #emitStatus(state, error = '') {
    this.state = state;
    this.error = error;
    this.onStatus?.({ state, url: this.publicUrl, error });
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.publicUrl = null;

    let bin = resolveExistingBinary();
    if (!bin) {
      this.#emitStatus('downloading', '');
      try {
        bin = await downloadCloudflared(getCachedBinaryPath());
      } catch (err) {
        if (!this.active) return;
        this.active = false;
        this.#emitStatus('error', err?.message || '隧道组件准备失败');
        return;
      }
    }

    if (!this.active) return;
    this.#emitStatus('connecting', '');

    const namedMode = Boolean(this.token);
    const args = namedMode
      ? ['tunnel', '--no-autoupdate', 'run', '--token', this.token]
      : ['tunnel', '--url', `http://127.0.0.1:${this.localPort}`, '--protocol', 'http2', '--no-autoupdate'];

    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    if (namedMode && this.hostname) {
      // Named tunnels do not print the public hostname; use the configured one.
      this.publicUrl = `https://${this.hostname}`;
    }

    const handleLine = (chunk) => {
      const text = chunk.toString('utf8');
      if (namedMode) {
        if (/Registered tunnel connection|Connection registered|connIndex=/i.test(text)) {
          if (this.publicUrl && this.state !== 'ready') {
            this.#emitStatus('ready', '');
            this.onUrl?.(this.publicUrl);
          }
        }
      } else {
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && match[0] !== this.publicUrl) {
          this.publicUrl = match[0];
          this.#emitStatus('ready', '');
          this.onUrl?.(this.publicUrl);
        }
      }
      if (this.onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) this.onLog(line.trim());
        }
      }
    };

    proc.stdout.on('data', handleLine);
    proc.stderr.on('data', handleLine);
    proc.on('error', (err) => {
      if (this.proc === proc) this.proc = null;
      this.publicUrl = null;
      this.onUrl?.(null);
      if (this.active) {
        this.active = false;
        this.#emitStatus('error', err?.message || '隧道启动失败');
      }
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      const wasActive = this.active;
      const hadUrl = Boolean(this.publicUrl);
      this.publicUrl = null;
      this.active = false;
      this.onUrl?.(null);
      if (wasActive && !hadUrl) {
        this.#emitStatus('error', code ? `隧道连接失败 (退出码 ${code})` : '隧道已退出');
      } else {
        this.#emitStatus('idle', '');
      }
    });
  }

  stop() {
    this.active = false;
    this.publicUrl = null;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
    this.#emitStatus('idle', '');
  }
}
