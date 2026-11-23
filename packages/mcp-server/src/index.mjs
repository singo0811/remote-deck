#!/usr/bin/env node
import readline from 'node:readline';
import { MSG } from '@remote-deck/shared';
import { RemoteControllerClient } from './client.mjs';
import { buildDevecocliArgs, capturePhoneScreenshotBase64, runDevecocli } from './phone.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--pin' && argv[i + 1]) out.pin = argv[++i];
    else if (a === '--device-id' && argv[i + 1]) out.deviceId = argv[++i];
    else if (a === '--mode' && argv[i + 1]) out.mode = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const client = new RemoteControllerClient({
  url: args.url || process.env.REMOTEDECK_URL || 'ws://127.0.0.1:9601/ws',
  pin: args.pin || process.env.REMOTEDECK_PIN || '',
  deviceId: args.deviceId || process.env.REMOTEDECK_DEVICE_ID || '',
  mode: args.mode || process.env.REMOTEDECK_MODE || 'direct',
});

const TOOLS = [
  {
    name: 'rd_status',
    description: 'Connect to the RemoteDeck host and inspect device identity, displays, and permissions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rd_screenshot',
    description: 'Capture a full screenshot of the remote desktop and return it as a JPEG image.',
    inputSchema: {
      type: 'object',
      properties: {
        displayId: { type: 'number', description: 'Display index (default 0).' },
        scale: { type: 'number', description: 'Scale factor 0.25..1.0 (default 0.85).' },
        quality: { type: 'number', description: 'JPEG quality 30..95 (default 82).' },
      },
    },
  },
  {
    name: 'rd_mouse_click',
    description: 'Click or double-click at coordinates on the remote screen (normalized 0..1 by default, or pixel coords when normalized=false).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean' },
        normalized: { type: 'boolean', description: 'True if x/y are 0..1 normalized (default true).' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'rd_mouse_move',
    description: 'Move the remote mouse cursor to (x, y).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        normalized: { type: 'boolean' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'rd_mouse_drag',
    description: 'Drag the mouse from (fromX, fromY) to (toX, toY).',
    inputSchema: {
      type: 'object',
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        normalized: { type: 'boolean' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
  },
  {
    name: 'rd_mouse_scroll',
    description: 'Scroll the mouse wheel (negative deltaY scrolls down, positive scrolls up).',
    inputSchema: {
      type: 'object',
      properties: {
        deltaY: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
        normalized: { type: 'boolean' },
      },
      required: ['deltaY'],
    },
  },
  {
    name: 'rd_type_text',
    description: 'Type Unicode text directly on the remote computer (works for Chinese and ASCII).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'rd_hotkey',
    description: 'Send a key press or shortcut combination (e.g. key="c", ctrl=true; or key="Enter").',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        ctrl: { type: 'boolean' },
        alt: { type: 'boolean' },
        shift: { type: 'boolean' },
        meta: { type: 'boolean' },
      },
      required: ['key'],
    },
  },
  {
    name: 'rd_clipboard_get',
    description: 'Read current text or PNG image from the remote clipboard.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rd_clipboard_set',
    description: 'Write text into the remote clipboard.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'rd_list_files',
    description: 'List roots or directory entries on the remote computer.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path; omit to list root drives.' } },
    },
  },
  {
    name: 'rd_read_file',
    description: 'Read a text file on the remote computer.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'rd_write_file',
    description: 'Write a text file on the remote computer.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'rd_exec',
    description: 'Execute a shell command on the remote host via ConPTY and return its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'rd_phone_devices',
    description: 'List HarmonyOS devices connected via DevEco CLI / hdc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rd_phone_layout',
    description: 'Dump on-screen ArkUI accessibility layout tree and node bounds from a connected HarmonyOS device.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Optional device serial or name.' },
        depth: { type: 'number', description: 'Max tree depth (0=unlimited).' },
        format: { type: 'string', enum: ['default', 'json'] },
        mode: { type: 'string', enum: ['simplified', 'full'] },
        id: { type: 'string' },
        window: { type: 'number' },
        allWindows: { type: 'boolean' },
      },
    },
  },
  {
    name: 'rd_phone_tap',
    description: 'Tap, double-tap, or long-press on a HarmonyOS device by (x, y) pixel coords or node id.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['click', 'doubleclick', 'longclick'] },
        x: { type: 'number' },
        y: { type: 'number' },
        id: { type: 'string' },
        window: { type: 'number' },
        device: { type: 'string' },
      },
    },
  },
  {
    name: 'rd_phone_swipe',
    description: 'Swipe between (x1, y1) and (x2, y2) or fling in a direction on a HarmonyOS device.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        speed: { type: 'number', description: 'Swipe speed in px/s (200..40000).' },
        device: { type: 'string' },
      },
    },
  },
  {
    name: 'rd_phone_text',
    description: 'Input text (including Chinese) into the focused field or target node/coordinates on a HarmonyOS device.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        id: { type: 'string' },
        window: { type: 'number' },
        device: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'rd_phone_screenshot',
    description: 'Capture a screenshot from a connected HarmonyOS device and return it as a PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string' },
        display: { type: 'number' },
      },
    },
  },
];

async function runTool(name, params = {}) {
  switch (name) {
    case 'rd_status': {
      const info = await client.connect();
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
    case 'rd_screenshot': {
      const frame = await client.captureFullFrame({
        displayId: params.displayId ?? 0,
        scale: params.scale ?? 0.85,
        quality: params.quality ?? 82,
      });
      return {
        content: [
          {
            type: 'image',
            data: frame.jpeg.toString('base64'),
            mimeType: 'image/jpeg',
          },
          {
            type: 'text',
            text: JSON.stringify({
              width: frame.meta.width,
              height: frame.meta.height,
              fullWidth: frame.meta.fullWidth,
              fullHeight: frame.meta.fullHeight,
            }),
          },
        ],
      };
    }
    case 'rd_mouse_click': {
      const pt = await client.click(params);
      return { content: [{ type: 'text', text: `Clicked at (${pt.x.toFixed(4)}, ${pt.y.toFixed(4)})` }] };
    }
    case 'rd_mouse_move': {
      const pt = await client.move(params);
      return { content: [{ type: 'text', text: `Moved to (${pt.x.toFixed(4)}, ${pt.y.toFixed(4)})` }] };
    }
    case 'rd_mouse_drag': {
      const res = await client.drag(params);
      return { content: [{ type: 'text', text: `Dragged ${JSON.stringify(res)}` }] };
    }
    case 'rd_mouse_scroll': {
      await client.scroll(params);
      return { content: [{ type: 'text', text: `Scrolled deltaY=${params.deltaY}` }] };
    }
    case 'rd_type_text': {
      await client.typeText(params.text);
      return { content: [{ type: 'text', text: `Typed ${String(params.text || '').length} chars` }] };
    }
    case 'rd_hotkey': {
      const vk = await client.sendKey(params);
      return { content: [{ type: 'text', text: `Sent key vk=${vk}` }] };
    }
    case 'rd_clipboard_get': {
      const data = await client.getClipboard();
      if (data.imageBase64) {
        return {
          content: [
            { type: 'image', data: data.imageBase64, mimeType: 'image/png' },
            { type: 'text', text: data.text || '(image clipboard)' },
          ],
        };
      }
      return { content: [{ type: 'text', text: data.text || '' }] };
    }
    case 'rd_clipboard_set': {
      await client.setClipboard(params.text);
      return { content: [{ type: 'text', text: 'Clipboard updated' }] };
    }
    case 'rd_list_files': {
      const res = params.path
        ? await client.fsRequest(MSG.FS_LIST, { path: params.path })
        : await client.fsRequest(MSG.FS_ROOTS);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'rd_read_file': {
      const res = await client.fsRequest(MSG.FS_READ_TEXT, { path: params.path });
      return { content: [{ type: 'text', text: res.content || '' }] };
    }
    case 'rd_write_file': {
      const res = await client.fsRequest(MSG.FS_WRITE_TEXT, { path: params.path, content: params.content });
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    }
    case 'rd_exec': {
      const out = await client.execCommand(params.command, { timeoutMs: params.timeoutMs || 8000 });
      return { content: [{ type: 'text', text: out }] };
    }
    case 'rd_phone_devices': {
      const out = await runDevecocli(buildDevecocliArgs('devices', params));
      return { content: [{ type: 'text', text: out }] };
    }
    case 'rd_phone_layout': {
      const out = await runDevecocli(buildDevecocliArgs('layout', params));
      return { content: [{ type: 'text', text: out }] };
    }
    case 'rd_phone_tap': {
      const out = await runDevecocli(buildDevecocliArgs('tap', params));
      return { content: [{ type: 'text', text: out }] };
    }
    case 'rd_phone_swipe': {
      const out = await runDevecocli(buildDevecocliArgs('swipe', params));
      return { content: [{ type: 'text', text: out }] };
    }
    case 'rd_phone_text': {
      const out = await runDevecocli(buildDevecocliArgs('text', params));
      return { content: [{ type: 'text', text: out }] };
    }
    case 'rd_phone_screenshot': {
      const shot = await capturePhoneScreenshotBase64(params);
      return {
        content: [
          { type: 'image', data: shot.base64, mimeType: 'image/png' },
          { type: 'text', text: shot.output || 'Captured phone screenshot' },
        ],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendRpc(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export function startMcpStdioServer() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params } = req;
    if (method === 'notifications/initialized' || id === undefined) {
      return;
    }
    try {
      if (method === 'initialize') {
        sendRpc({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'remote-deck-mcp', version: '1.0.0' },
          },
        });
      } else if (method === 'tools/list') {
        sendRpc({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const result = await runTool(params?.name, params?.arguments || {});
        sendRpc({ jsonrpc: '2.0', id, result });
      } else if (method === 'ping') {
        sendRpc({ jsonrpc: '2.0', id, result: {} });
      } else {
        sendRpc({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
    } catch (err) {
      if (method === 'tools/call') {
        sendRpc({
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] },
        });
      } else {
        sendRpc({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err?.message || String(err) },
        });
      }
    }
  });
  rl.on('close', () => {
    client.disconnect();
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  startMcpStdioServer();
} else if (!process.env.REMOTEDECK_MCP_NO_AUTO) {
  startMcpStdioServer();
}
