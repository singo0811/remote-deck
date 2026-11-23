import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const modelCache = new Map();
const screenSizeCache = new Map();
const inflightFrames = new Map();

export function findHdcBinary() {
  if (process.env.HDC_PATH && existsSync(process.env.HDC_PATH)) {
    return process.env.HDC_PATH;
  }
  const exe = process.platform === 'win32' ? 'hdc.exe' : 'hdc';
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const p = path.join(dir, exe);
    if (existsSync(p)) return p;
  }
  const winFallbacks = [
    'D:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe',
    'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe',
  ];
  for (const p of winFallbacks) {
    if (existsSync(p)) return p;
  }
  return exe;
}

function findDevecocliRunner() {
  const candidates = [];
  if (process.env.DEVECO_CLI_JS) candidates.push(process.env.DEVECO_CLI_JS);
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deveco', 'deveco-cli', 'dist', 'cli.js'));
    }
    candidates.push('D:\\Tools\\npm-global\\node_modules\\@deveco\\deveco-cli\\dist\\cli.js');
  }
  for (const p of candidates) {
    if (p && existsSync(p)) return { cmd: process.execPath, prefixArgs: [p] };
  }
  return { cmd: process.platform === 'win32' ? 'devecocli.cmd' : 'devecocli', prefixArgs: [] };
}

export function parseJpegDimensions(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { width: 0, height: 0 };
  }
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) {
      i += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2 || i + 2 + segLen > buf.length) break;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (i + 8 < buf.length) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { width, height };
      }
      break;
    }
    i += 2 + segLen;
  }
  return { width: 0, height: 0 };
}

async function runHdc(args, timeoutMs = 6000) {
  const hdc = findHdcBinary();
  const { stdout, stderr } = await execFileAsync(hdc, args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

export async function listConnectedPhones() {
  let out = '';
  try {
    out = await runHdc(['list', 'targets'], 3000);
  } catch {
    return [];
  }
  const serials = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.includes('[Empty]') && !s.startsWith('[Fail]'));

  const devices = [];
  for (const serial of serials) {
    let model = modelCache.get(serial);
    if (!model) {
      try {
        const m = await runHdc(['-t', serial, 'shell', 'param', 'get', 'const.product.model'], 2500);
        model = m && !m.includes('[Fail]') ? m.split(/\r?\n/)[0].trim() : 'HarmonyOS Device';
      } catch {
        model = 'HarmonyOS Device';
      }
      modelCache.set(serial, model);
    }
    let dims = screenSizeCache.get(serial);
    if (!dims) {
      dims = { width: 0, height: 0 };
      try {
        const dump = await runHdc(['-t', serial, 'shell', 'hidumper -s RenderService -a screen'], 2500);
        const m = dump.match(/physical\s+resolution\s*[:=]\s*(\d+)\s*[xX*]\s*(\d+)/i)
          || dump.match(/activeMode:\s*(\d+)\s*x\s*(\d+)/i);
        if (m) {
          dims = { width: Number(m[1]) || 0, height: Number(m[2]) || 0 };
        }
      } catch {
        // Ignore
      }
      if (dims.width > 0 && dims.height > 0) {
        screenSizeCache.set(serial, dims);
      }
    }
    devices.push({
      serial,
      name: model,
      platform: 'harmonyos',
      screenWidth: dims.width,
      screenHeight: dims.height,
    });
  }
  return devices;
}

export async function connectWirelessPhone(target) {
  const clean = String(target || '').trim();
  if (!clean) throw new Error('target address (ip:port) is required');
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(clean)) {
    throw new Error('invalid wireless target address');
  }
  const out = await runHdc(['tconn', clean], 6000);
  if (/fail|error|unable/i.test(out) && !/already/i.test(out)) {
    throw new Error(out || `hdc tconn ${clean} failed`);
  }
  return { ok: true, target: clean, output: out };
}

export async function capturePhoneFrame(serial) {
  const cleanSerial = String(serial || '').trim();
  if (!cleanSerial) throw new Error('device serial is required');
  if (inflightFrames.has(cleanSerial)) {
    return inflightFrames.get(cleanSerial);
  }
  const task = (async () => {
    const tmpDir = path.join(os.tmpdir(), 'remotedeck-phone-mirror');
    mkdirSync(tmpDir, { recursive: true });
    const safeName = cleanSerial.replace(/[^a-zA-Z0-9._-]/g, '_');
    const localFile = path.join(tmpDir, `${safeName}-${Date.now()}.jpeg`);
    const remoteFile = '/data/local/tmp/rd_mirror_frame.jpeg';
    try {
      await runHdc(['-t', cleanSerial, 'shell', `snapshot_display -f ${remoteFile}`], 5000);
      await runHdc(['-t', cleanSerial, 'file', 'recv', remoteFile, localFile], 5000);
      if (!existsSync(localFile)) {
        throw new Error('snapshot_display did not produce output file');
      }
      const buffer = readFileSync(localFile);
      const dims = parseJpegDimensions(buffer);
      return { buffer, width: dims.width, height: dims.height };
    } finally {
      try {
        unlinkSync(localFile);
      } catch {}
    }
  })();
  inflightFrames.set(cleanSerial, task);
  try {
    return await task;
  } finally {
    inflightFrames.delete(cleanSerial);
  }
}

export async function sendPhoneInput(serial, msg = {}) {
  const cleanSerial = String(serial || '').trim();
  if (!cleanSerial) throw new Error('device serial is required');
  const action = String(msg.action || 'tap');

  if (action === 'tap' || action === 'click' || action === 'doubleclick' || action === 'longclick') {
    const x = Math.round(Number(msg.x) || 0);
    const y = Math.round(Number(msg.y) || 0);
    const sub = action === 'doubleclick' ? 'doubleClick' : action === 'longclick' ? 'longClick' : 'click';
    await runHdc(['-t', cleanSerial, 'shell', `uitest uiInput ${sub} ${x} ${y}`], 4000);
    return { ok: true, action: sub, x, y };
  }

  if (action === 'swipe') {
    const x1 = Math.round(Number(msg.x1) || 0);
    const y1 = Math.round(Number(msg.y1) || 0);
    const x2 = Math.round(Number(msg.x2) || 0);
    const y2 = Math.round(Number(msg.y2) || 0);
    const speed = Math.max(200, Math.min(40000, Math.round(Number(msg.speed) || 2400)));
    await runHdc(['-t', cleanSerial, 'shell', `uitest uiInput swipe ${x1} ${y1} ${x2} ${y2} ${speed}`], 5000);
    return { ok: true, action: 'swipe', x1, y1, x2, y2, speed };
  }

  if (action === 'key') {
    const key = String(msg.key || 'Back');
    if (!/^[a-zA-Z0-9_]+$/.test(key)) throw new Error('invalid key');
    await runHdc(['-t', cleanSerial, 'shell', `uitest uiInput keyEvent ${key}`], 4000);
    return { ok: true, action: 'key', key };
  }

  if (action === 'text') {
    const text = String(msg.text || '');
    if (!text) return { ok: true, action: 'text', length: 0 };
    const { cmd, prefixArgs } = findDevecocliRunner();
    await execFileAsync(cmd, [...prefixArgs, 'ui', 'text', text, '--device', cleanSerial], {
      timeout: 15000,
      windowsHide: true,
    });
    return { ok: true, action: 'text', length: text.length };
  }

  throw new Error(`Unsupported phone input action: ${action}`);
}

/**
 * Decodes length-prefixed RDH1 packets streamed from HarmonyOS ScreenShareServer:
 * [4B bodyLen][1B flags][2B width][2B height][8B ptsUs][Annex-B H.264]
 */
export function decodePhoneStreamPackets(state, chunk) {
  if (!state.buf) state.buf = Buffer.alloc(0);
  if (chunk && chunk.length > 0) {
    state.buf = Buffer.concat([state.buf, Buffer.from(chunk)]);
  }
  const packets = [];
  while (state.buf.length >= 4) {
    const bodyLen = state.buf.readUInt32BE(0);
    if (bodyLen < 13 || bodyLen > 16 * 1024 * 1024) {
      throw new Error(`Invalid phone stream packet length: ${bodyLen}`);
    }
    if (state.buf.length < 4 + bodyLen) break;
    const body = state.buf.subarray(4, 4 + bodyLen);
    state.buf = state.buf.subarray(4 + bodyLen);
    const flags = body[0];
    const width = body.readUInt16BE(1);
    const height = body.readUInt16BE(3);
    const ptsUs = Number(body.readBigInt64BE(5));
    const payload = Buffer.from(body.subarray(13));
    if ((flags & 0x04) !== 0) {
      packets.push({
        audio: true,
        codec: 'ima_adpcm',
        sampleRate: width || 48000,
        channels: 2,
        frames: height,
        ptsUs,
        payload,
      });
    } else {
      packets.push({
        key: (flags & 0x01) !== 0,
        codecData: (flags & 0x02) !== 0,
        width,
        height,
        ptsUs,
        payload,
      });
    }
  }
  return packets;
}

async function resolvePhoneShareTarget(serial, explicitHost, defaultPort = 9603) {
  const hostSpec = String(explicitHost || '').trim();
  if (hostSpec) {
    const m = hostSpec.match(/^\[?([^\]]+)\]?:(\d+)$/);
    if (m) return { host: m[1], port: Number(m[2]) || defaultPort };
    return { host: hostSpec, port: defaultPort };
  }
  const cleanSerial = String(serial || '').trim();
  const ipMatch = cleanSerial.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipMatch) {
    return { host: ipMatch[1], port: defaultPort };
  }
  if (cleanSerial) {
    try {
      await runHdc(['-t', cleanSerial, 'fport', 'tcp:19603', `tcp:${defaultPort}`], 3000);
      return { host: '127.0.0.1', port: 19603 };
    } catch {
      // Fall through to wlan0 IP probe if fport failed
    }
    try {
      const ipOut = await runHdc(['-t', cleanSerial, 'shell', 'ip -4 addr show wlan0'], 2500);
      const m = ipOut.match(/inet\s+(\d+\.\d+\.\d+\.\d+)\//);
      if (m) return { host: m[1], port: defaultPort };
    } catch {
      // Ignore
    }
  }
  return null;
}

export async function connectPhoneH264Stream({ serial = '', host = '', port = 9603, onPacket, onError, onClose }) {
  const target = await resolvePhoneShareTarget(serial, host, port);
  if (!target) {
    throw new Error('无法解析手机共享 TCP 地址（请先在手机端开启投屏共享，或填入手机 IP）');
  }
  const state = { buf: Buffer.alloc(0) };
  let closed = false;
  const sock = net.createConnection({ host: target.host, port: target.port, noDelay: true });
  sock.setTimeout(15000, () => {
    if (!closed) {
      onError?.(new Error(`连接手机投屏端口 ${target.host}:${target.port} 超时`));
      sock.destroy();
    }
  });
  sock.on('connect', () => {
    sock.setTimeout(0);
  });
  sock.on('data', (chunk) => {
    try {
      const pkts = decodePhoneStreamPackets(state, chunk);
      for (const pkt of pkts) {
        onPacket?.(pkt);
      }
    } catch (err) {
      onError?.(err);
      sock.destroy();
    }
  });
  sock.on('error', (err) => {
    if (!closed) onError?.(err);
  });
  sock.on('close', () => {
    if (!closed) {
      closed = true;
      onClose?.();
    }
  });
  return {
    target,
    close: () => {
      if (!closed) {
        closed = true;
        sock.destroy();
      }
    },
  };
}
