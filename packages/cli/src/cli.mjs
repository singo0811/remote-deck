#!/usr/bin/env node
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MSG, collectLocalAddresses } from '@remote-deck/shared';
import { RemoteControllerClient } from '@remote-deck/mcp-server/src/client.mjs';
import { detectRendererPreference, renderJpegToAnsi, renderJpegToKitty } from './renderer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

function parseCliArgs(argv) {
  const opts = {
    command: 'connect',
    target: '',
    pin: '',
    relay: '',
    fps: 4,
    renderer: 'auto',
    json: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === 'doctor') opts.command = 'doctor';
    else if (a === '--json') opts.json = true;
    else if (a === '--pin' && argv[i + 1]) opts.pin = argv[++i];
    else if (a === '--relay' && argv[i + 1]) opts.relay = argv[++i];
    else if (a === '--fps' && argv[i + 1]) opts.fps = Math.max(1, Math.min(30, Number(argv[++i]) || 4));
    else if (a === '--renderer' && argv[i + 1]) opts.renderer = argv[++i];
    else if (a === '-h' || a === '--help') opts.command = 'help';
    else rest.push(a);
  }
  if (rest.length > 0 && opts.command === 'connect') {
    opts.target = rest[0];
  }
  return opts;
}

function runDoctor(jsonMode) {
  const binDir = path.join(repoRoot, 'packages/host-agent/bin');
  const nativeBin = path.join(binDir, process.platform === 'win32' ? 'remote-native.exe' : 'remote-native');
  const tsnetBin = path.join(binDir, process.platform === 'win32' ? 'remote-tsnet.exe' : 'remote-tsnet');
  const cloudflaredCached = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'remote-deck/bin',
    process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
  );
  const endpoints = collectLocalAddresses(9601);
  const report = {
    ok: true,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    terminalSize: { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 },
    detectedRenderer: detectRendererPreference(),
    binaries: {
      nativeHelper: existsSync(nativeBin),
      tsnetHelper: existsSync(tsnetBin),
      cloudflared: existsSync(cloudflaredCached) || existsSync(path.join(binDir, 'cloudflared.exe')),
    },
    endpoints: endpoints.map((e) => ({ iface: e.iface, ip: e.ip, family: e.family, kind: e.kind, virtual: e.virtual })),
  };
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('RemoteDeck CLI Doctor');
    console.log(`  Node: ${report.nodeVersion} (${report.platform}/${report.arch})`);
    console.log(`  Terminal: ${report.terminalSize.cols}x${report.terminalSize.rows} (renderer: ${report.detectedRenderer})`);
    console.log(`  Native Helper: ${report.binaries.nativeHelper ? 'OK' : 'MISSING'}`);
    console.log(`  Tailscale (tsnet): ${report.binaries.tsnetHelper ? 'OK' : 'MISSING'}`);
    console.log(`  Cloudflared: ${report.binaries.cloudflared ? 'OK' : 'MISSING'}`);
    console.log('  Local Endpoints:');
    for (const ep of report.endpoints) {
      console.log(`    - [${ep.kind}${ep.virtual ? '/virtual' : ''}] ${ep.ip} (${ep.iface})`);
    }
  }
}

function promptPinHidden() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('请输入访问配对码 (PIN): ', (ans) => {
      rl.close();
      resolve(ans.trim().toUpperCase());
    });
  });
}

async function runCliConnect(opts) {
  if (!opts.target) {
    console.error('用法: remote-deck-cli <主机URL或设备ID> [--pin PIN] [--relay URL] [--renderer auto|ansi|kitty]');
    console.error('环境检查: remote-deck-cli doctor [--json]');
    process.exit(1);
  }
  let pin = opts.pin;
  if (!pin) {
    pin = await promptPinHidden();
  }
  const isAddr = opts.target.includes('.') || opts.target.includes(':') || opts.target.startsWith('http') || opts.target.startsWith('ws');
  const client = new RemoteControllerClient({
    url: isAddr ? opts.target : (opts.relay || 'ws://127.0.0.1:9601/ws'),
    deviceId: isAddr ? '' : opts.target.toUpperCase(),
    mode: isAddr ? 'direct' : 'relay',
    pin,
  });

  const auth = await client.connect(12000);
  const renderer = opts.renderer === 'auto' ? detectRendererPreference() : opts.renderer;
  let controlEnabled = false;
  let zoom = 1;
  let panX = 0.5;
  let panY = 0.5;
  let lastJpeg = null;

  const drawFrame = (jpegBuf) => {
    lastJpeg = jpegBuf;
    const cols = process.stdout.columns || 100;
    const rows = Math.max(12, (process.stdout.rows || 30) - 2);
    const rendered = renderer === 'kitty'
      ? renderJpegToKitty(jpegBuf)
      : renderJpegToAnsi(jpegBuf, cols, rows, { zoom, panX, panY });
    const statusBar = `\x1b[7m RemoteDeck CLI | ${auth.deviceName || auth.deviceId} | ${controlEnabled ? '控制模式 (Ctrl+] 暂停)' : '只读模式 (c 开启控制)'} | 缩放 ${zoom.toFixed(1)}x (+/-) | q 退出 \x1b[0m`;
    process.stdout.write(`\x1b[2J\x1b[H${rendered.text}\n${statusBar}`);
  };

  client.on('screen', (frame) => {
    if (frame?.jpeg?.length > 0) {
      drawFrame(frame.jpeg);
    }
  });

  client.sendJson({
    type: MSG.SCREEN_START,
    displayId: 0,
    fps: opts.fps,
    scale: 0.6,
    maxWidth: 1600,
    singleFrame: true,
    quality: 70,
    auto: false,
    allowDirty: false,
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      const s = buf.toString('utf8');
      if (s === '\x1d') { // Ctrl+]
        controlEnabled = false;
        if (lastJpeg) drawFrame(lastJpeg);
        return;
      }
      if (!controlEnabled) {
        if (s === 'q' || s === '\x03') {
          cleanup();
        } else if (s === 'c') {
          controlEnabled = true;
          if (lastJpeg) drawFrame(lastJpeg);
        } else if (s === '+' || s === '=') {
          zoom = Math.min(4, zoom + 0.4);
          if (lastJpeg) drawFrame(lastJpeg);
        } else if (s === '-') {
          zoom = Math.max(1, zoom - 0.4);
          if (lastJpeg) drawFrame(lastJpeg);
        } else if (s === '\x1b[A') { panY = Math.max(0.1, panY - 0.1); if (lastJpeg) drawFrame(lastJpeg); }
        else if (s === '\x1b[B') { panY = Math.min(0.9, panY + 0.1); if (lastJpeg) drawFrame(lastJpeg); }
        else if (s === '\x1b[D') { panX = Math.max(0.1, panX - 0.1); if (lastJpeg) drawFrame(lastJpeg); }
        else if (s === '\x1b[C') { panX = Math.min(0.9, panX + 0.1); if (lastJpeg) drawFrame(lastJpeg); }
        return;
      }

      if (s === '\r' || s === '\n') client.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x0d });
      else if (s === '\x7f' || s === '\b') client.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x08 });
      else if (s === '\x1b') client.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x1b });
      else if (s === '\t') client.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x09 });
      else if (s === '\x1b[A') client.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x26 });
      else if (s === '\x1b[B') client.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x28 });
      else if (s === '\x1b[D') client.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x25 });
      else if (s === '\x1b[C') client.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: 0x27 });
      else client.sendJson({ type: MSG.INPUT_TEXT, text: s });
    });
  }

  function cleanup() {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {}
    process.stdout.write('\x1b[0m\n');
    client.disconnect();
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
}

const opts = parseCliArgs(process.argv.slice(2));
if (opts.command === 'help') {
  console.log('RemoteDeck CLI\n  remote-deck-cli doctor [--json]\n  remote-deck-cli <url_or_deviceId> [--pin PIN] [--relay URL] [--fps 4] [--renderer auto|ansi|kitty]');
} else if (opts.command === 'doctor') {
  runDoctor(opts.json);
} else {
  await runCliConnect(opts);
}
