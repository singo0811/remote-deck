import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Resolve the installed @deveco/deveco-cli Node entrypoint when available so
 * arguments (including non-ASCII UI text) pass directly via execFile without cmd.exe.
 */
export function resolveDevecocliRunner() {
  const candidates = [];
  if (process.env.DEVECO_CLI_JS) {
    candidates.push(process.env.DEVECO_CLI_JS);
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    candidates.push(path.join(dir, 'node_modules', '@deveco', 'deveco-cli', 'dist', 'cli.js'));
  }
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deveco', 'deveco-cli', 'dist', 'cli.js'));
    }
    candidates.push('D:\\Tools\\npm-global\\node_modules\\@deveco\\deveco-cli\\dist\\cli.js');
  }
  for (const file of candidates) {
    if (file && existsSync(file)) {
      return { cmd: process.execPath, prefixArgs: [file] };
    }
  }
  return { cmd: 'devecocli', prefixArgs: [] };
}

function appendDevice(args, device) {
  if (device && String(device).trim()) {
    args.push('--device', String(device).trim());
  }
}

/**
 * Build validated argument vector for `devecocli` subcommands.
 */
export function buildDevecocliArgs(action, params = {}) {
  switch (action) {
    case 'devices':
      return ['device', 'list'];

    case 'layout': {
      const args = ['ui', 'layout'];
      if (Number.isFinite(params.depth)) {
        args.push('--depth', String(Math.max(0, Math.min(20, Math.round(params.depth)))));
      }
      if (params.format === 'json' || params.format === 'default') {
        args.push('--format', params.format);
      }
      if (params.mode === 'full' || params.mode === 'simplified') {
        args.push('--mode', params.mode);
      }
      if (params.id) args.push('--id', String(params.id));
      if (Number.isFinite(params.window)) args.push('--window', String(params.window));
      if (params.allWindows) args.push('--all-windows');
      appendDevice(args, params.device);
      return args;
    }

    case 'tap': {
      const kind = params.kind === 'doubleclick' || params.kind === 'longclick' ? params.kind : 'click';
      const args = ['ui', kind];
      if (params.id) {
        args.push('--id', String(params.id));
        if (Number.isFinite(params.window)) args.push('--window', String(params.window));
      } else {
        if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
          throw new Error('Provide either id or numeric (x, y) coordinates');
        }
        args.push(String(Math.round(params.x)), String(Math.round(params.y)));
      }
      appendDevice(args, params.device);
      return args;
    }

    case 'swipe': {
      if (params.direction) {
        const dir = String(params.direction).toLowerCase();
        if (!['up', 'down', 'left', 'right'].includes(dir)) {
          throw new Error('direction must be one of up, down, left, right');
        }
        const args = ['ui', 'dircfling', dir];
        appendDevice(args, params.device);
        return args;
      }
      if (
        !Number.isFinite(params.x1) ||
        !Number.isFinite(params.y1) ||
        !Number.isFinite(params.x2) ||
        !Number.isFinite(params.y2)
      ) {
        throw new Error('Provide either direction or numeric (x1, y1, x2, y2)');
      }
      const args = [
        'ui',
        'swipe',
        String(Math.round(params.x1)),
        String(Math.round(params.y1)),
        String(Math.round(params.x2)),
        String(Math.round(params.y2)),
      ];
      if (Number.isFinite(params.speed)) {
        args.push('--speed', String(Math.max(200, Math.min(40000, Math.round(params.speed)))));
      }
      appendDevice(args, params.device);
      return args;
    }

    case 'text': {
      if (typeof params.text !== 'string' || params.text.length === 0) {
        throw new Error('text must be a non-empty string');
      }
      const args = ['ui', 'text', params.text];
      if (params.id) {
        args.push('--id', String(params.id));
        if (Number.isFinite(params.window)) args.push('--window', String(params.window));
      } else if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
        args.push(String(Math.round(params.x)), String(Math.round(params.y)));
      }
      appendDevice(args, params.device);
      return args;
    }

    case 'screenshot': {
      if (!params.path) {
        throw new Error('screenshot path is required');
      }
      const args = ['ui', 'screenshot', '--path', String(params.path)];
      if (Number.isFinite(params.display)) {
        args.push('--display', String(params.display));
      }
      appendDevice(args, params.device);
      return args;
    }

    default:
      throw new Error(`Unsupported phone action: ${action}`);
  }
}

export async function runDevecocli(args, timeoutMs = 20000) {
  const { cmd, prefixArgs } = resolveDevecocliRunner();
  const { stdout, stderr } = await execFileAsync(cmd, [...prefixArgs, ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

export async function capturePhoneScreenshotBase64(params = {}) {
  const tmpDir = path.join(os.tmpdir(), 'remotedeck-phone-shots');
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  try {
    const args = buildDevecocliArgs('screenshot', {
      device: params.device,
      display: params.display,
      path: tmpFile,
    });
    const output = await runDevecocli(args, 25000);
    if (!existsSync(tmpFile)) {
      throw new Error(`Screenshot file was not created (${output || 'unknown error'})`);
    }
    const base64 = readFileSync(tmpFile).toString('base64');
    return { base64, output };
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {}
  }
}
