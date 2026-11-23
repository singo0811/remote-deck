import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  FRAME_KIND,
  MSG,
  computeChallengeProof,
  decodeBinaryEnvelope,
} from '../packages/shared/src/index.mjs';
import { HostAgent } from '../packages/host-agent/src/agent.mjs';
import { FileService } from '../packages/host-agent/src/file-service.mjs';
import { decodePhoneStreamPackets, parseJpegDimensions } from '../packages/host-agent/src/phone-bridge.mjs';
import net from 'node:net';
import { renderJpegToAnsi } from '../packages/cli/src/renderer.mjs';
import { buildDevecocliArgs } from '../packages/mcp-server/src/phone.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(__dirname, '../apps/web/dist');

function connectAndAuthWs(wsUrl, pin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout connecting ${wsUrl}`));
    }, 8000);
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === MSG.AUTH_CHALLENGE) {
        const proof = computeChallengeProof(pin, msg.nonce, msg.deviceId);
        ws.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof }));
      } else if (msg.type === MSG.AUTH_OK) {
        clearTimeout(timer);
        resolve({ ws, auth: msg });
      } else if (msg.type === MSG.AUTH_ERROR) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(msg.error));
      }
    });
  });
}

test('Upload resume continues from the host-reported offset', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotedeck-resume-'));
  const svc = new FileService({ allowedRoots: [dir] });
  try {
    // First attempt: only the first 5 bytes made it, then the session ended cleanly.
    await svc.startUpload({ transferId: 'u1', dirPath: dir, fileName: 'big.bin', total: 10 });
    await svc.appendUploadChunk('u1', Buffer.from('hello'));
    await svc.finishUpload('u1');

    // Resume: the host truncates to the requested offset and keeps appending.
    const start = await svc.startUpload({
      transferId: 'u2',
      dirPath: dir,
      fileName: 'big.bin',
      total: 10,
      offset: 5,
    });
    assert.equal(start.offset, 5);
    await svc.appendUploadChunk('u2', Buffer.from('world'));
    const done = await svc.finishUpload('u2');
    assert.equal(done.size, 10);
    const content = await fs.readFile(path.join(dir, 'big.bin'), 'utf8');
    assert.equal(content, 'helloworld');
  } finally {
    svc.closeAllUploads();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Folder ZIP download streams a valid archive to the controller', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remotedeck-zip-'));
  await fs.mkdir(path.join(tempRoot, 'nested'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'notes.txt'), 'remote-deck zip check 中文\n'.repeat(40));
  await fs.writeFile(path.join(tempRoot, 'nested', 'data.json'), JSON.stringify({ ok: true }));

  const agent = new HostAgent({
    lanPort: 0,
    lanHost: '127.0.0.1',
    discoveryPort: 0,
    deviceId: 'RD-9010-0010',
    pin: 'ZIPPIN99',
    deviceName: 'Zip-Host',
    allowedRoots: [tempRoot],
    webDistDir,
  });

  try {
    const info = await agent.start();
    const { ws, auth } = await connectAndAuthWs(`ws://127.0.0.1:${info.lanPort}/ws`, 'ZIPPIN99');
    assert.ok(Array.isArray(auth.lanEndpoints), 'AUTH_OK should include lanEndpoints');
    assert.equal(typeof auth.tunnelUrl, 'string', 'AUTH_OK should include tunnelUrl string');

    const chunks = [];
    let done = false;
    let fileName = '';

    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('zip download timed out')), 10000);
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeBinaryEnvelope(data);
        if (env.kind !== FRAME_KIND.FILE_DOWN) return;
        fileName = env.meta.fileName || fileName;
        if (env.payload.byteLength > 0) chunks.push(Buffer.from(env.payload));
        if (env.meta.done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });

    ws.send(JSON.stringify({
      type: MSG.FS_ZIP_DOWNLOAD,
      reqId: 'zip-1',
      transferId: 'zip-1',
      paths: [tempRoot],
    }));

    await finished;
    const buf = Buffer.concat(chunks);
    assert.equal(done, true);
    assert.match(fileName, /\.zip$/i);
    // Local file header signature proves the archive is a real ZIP stream.
    assert.equal(buf.subarray(0, 4).toString('binary'), 'PK\u0003\u0004');
    assert.ok(buf.length > 200, `zip too small: ${buf.length}`);
    // Central directory must carry every packed entry path.
    const asText = buf.toString('utf8');
    assert.ok(asText.includes('notes.txt'), 'missing notes.txt entry');
    assert.ok(asText.includes('nested/data.json') || asText.includes('nested\\data.json'), 'missing nested entry');

    // Clipboard watch toggle must be acknowledged without side effects.
    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('clipboard watch ack timed out')), 5000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === MSG.CLIPBOARD_DATA && msg.watch) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws.send(JSON.stringify({ type: MSG.CLIPBOARD_WATCH, enabled: true }));
    });
    assert.equal(ack.enabled, true);

    ws.close();
  } finally {
    await agent.stop();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('MCP stdio server captures real JPEG screenshot and CLI ANSI renderer decodes it', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remotedeck-mcp-'));
  await fs.writeFile(path.join(tempRoot, 'hello.txt'), 'mcp-ok', 'utf8');
  const agent = new HostAgent({
    lanPort: 0,
    lanHost: '127.0.0.1',
    discoveryPort: 0,
    deviceId: 'RD-9020-0020',
    pin: 'MCP12345',
    deviceName: 'MCP-Host',
    allowedRoots: [tempRoot],
    webDistDir,
  });

  let proc = null;
  try {
    const info = await agent.start();
    const mcpEntry = path.resolve(__dirname, '../packages/mcp-server/src/index.mjs');
    proc = spawn(
      process.execPath,
      [mcpEntry, '--url', `ws://127.0.0.1:${info.lanPort}/ws`, '--pin', 'MCP12345'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const rl = readline.createInterface({ input: proc.stdout });
    const pending = new Map();
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        const w = pending.get(msg.id);
        if (w) {
          pending.delete(msg.id);
          w.resolve(msg);
        }
      } catch {}
    });

    let seq = 1;
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = seq++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP timeout for ${method}`));
        }, 10000);
        pending.set(id, {
          resolve: (res) => { clearTimeout(timer); resolve(res); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    const initRes = await rpc('initialize', {});
    assert.equal(initRes.result.serverInfo.name, 'remote-deck-mcp');

    const toolsRes = await rpc('tools/list', {});
    assert.ok(toolsRes.result.tools.some((t) => t.name === 'rd_screenshot'));
    for (const name of ['rd_phone_devices', 'rd_phone_layout', 'rd_phone_tap', 'rd_phone_swipe', 'rd_phone_text', 'rd_phone_screenshot']) {
      assert.ok(toolsRes.result.tools.some((t) => t.name === name), `missing MCP tool ${name}`);
    }

    const shotRes = await rpc('tools/call', { name: 'rd_screenshot', arguments: { scale: 0.3, quality: 55 } });
    const imgItem = shotRes.result.content.find((c) => c.type === 'image');
    assert.ok(imgItem && imgItem.data.length > 500, 'expected base64 JPEG screenshot');

    const ansi = renderJpegToAnsi(Buffer.from(imgItem.data, 'base64'), 48, 16);
    assert.ok(ansi.text.includes('\x1b[38;2;') && ansi.text.includes('▀'));

    const filesRes = await rpc('tools/call', { name: 'rd_list_files', arguments: { path: tempRoot } });
    assert.ok(filesRes.result.content[0].text.includes('hello.txt'));
  } finally {
    try { proc?.kill(); } catch {}
    await agent.stop();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('HarmonyOS DevEco CLI arg builder validates tap, swipe, layout, and Unicode text', () => {
  assert.deepEqual(buildDevecocliArgs('devices'), ['device', 'list']);
  assert.deepEqual(
    buildDevecocliArgs('layout', { depth: 3, format: 'json', device: '192.168.3.2:36903' }),
    ['ui', 'layout', '--depth', '3', '--format', 'json', '--device', '192.168.3.2:36903'],
  );
  assert.deepEqual(
    buildDevecocliArgs('tap', { kind: 'doubleclick', x: 500.4, y: 383.6, device: 'dev1' }),
    ['ui', 'doubleclick', '500', '384', '--device', 'dev1'],
  );
  assert.deepEqual(
    buildDevecocliArgs('swipe', { direction: 'up', device: 'dev1' }),
    ['ui', 'dircfling', 'up', '--device', 'dev1'],
  );
  assert.deepEqual(
    buildDevecocliArgs('text', { text: '瓜皮野起来', id: 'editorId_1', device: 'dev1' }),
    ['ui', 'text', '瓜皮野起来', '--id', 'editorId_1', '--device', 'dev1'],
  );
  assert.throws(() => buildDevecocliArgs('tap', {}));
  assert.throws(() => buildDevecocliArgs('swipe', { direction: 'diagonal' }));
});

test('parseJpegDimensions extracts width and height from JPEG SOF marker', () => {
  // Minimal JPEG with SOI + SOF0 (width=1320, height=2120)
  const buf = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x0b, // length 11
    0x08,       // precision
    0x08, 0x48, // height = 2120
    0x05, 0x28, // width = 1320
    0x03, 0x01, 0x11, 0x00,
    0xff, 0xd9, // EOI
  ]);
  assert.deepEqual(parseJpegDimensions(buf), { width: 1320, height: 2120 });
  assert.deepEqual(parseJpegDimensions(Buffer.from([1, 2, 3])), { width: 0, height: 0 });
});

test('HarmonyOS H.264 phone stream decoder and /ws/phone-stream relay work end-to-end', async () => {
  const buildPkt = (flags, w, h, ptsUs, payload) => {
    const hdr = Buffer.alloc(17);
    hdr.writeUInt32BE(13 + payload.length, 0);
    hdr[4] = flags;
    hdr.writeUInt16BE(w, 5);
    hdr.writeUInt16BE(h, 7);
    hdr.writeBigInt64BE(BigInt(ptsUs), 9);
    return Buffer.concat([hdr, payload]);
  };

  const sps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xe0, 0x1e]);
  const idr = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21]);
  const p1 = buildPkt(0x02, 720, 1280, 1000, sps);
  const p2 = buildPkt(0x01, 720, 1280, 33333, idr);

  // Fragment across TCP boundary to test packet reassembly
  const combined = Buffer.concat([p1, p2]);
  const state = { buf: Buffer.alloc(0) };
  const firstHalf = decodePhoneStreamPackets(state, combined.subarray(0, 20));
  const secondHalf = decodePhoneStreamPackets(state, combined.subarray(20));
  const all = [...firstHalf, ...secondHalf];
  assert.equal(all.length, 2);
  assert.equal(all[0].codecData, true);
  assert.equal(all[1].key, true);
  assert.equal(all[1].width, 720);
  assert.equal(all[1].height, 1280);

  const tcpSrv = net.createServer((sock) => {
    sock.write(p1);
    sock.write(p2);
  });
  await new Promise((r) => tcpSrv.listen(0, '127.0.0.1', r));
  const tcpPort = tcpSrv.address().port;

  const agent = new HostAgent({
    lanPort: 0,
    lanHost: '127.0.0.1',
    discoveryPort: 0,
    deviceId: 'RD-9012-0012',
    pin: 'ZIPPIN99',
    deviceName: 'PhoneProxy-Host',
    webDistDir,
  });

  try {
    await agent.start();
    const ws = new WebSocket(`ws://127.0.0.1:${agent.lanPort}/ws/phone-stream?host=127.0.0.1&port=${tcpPort}`);
    ws.binaryType = 'arraybuffer';

    const received = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('phone stream timeout')), 5000);
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeBinaryEnvelope(data);
        if (env.kind === FRAME_KIND.VIDEO) {
          received.push(env);
          if (received.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    ws.close();
    assert.equal(received[0].meta.width, 720);
    assert.equal(received[1].meta.key, true);
    assert.deepEqual(Buffer.from(received[1].payload), idr);
  } finally {
    await agent.stop();
    await new Promise((r) => tcpSrv.close(r));
  }
});
