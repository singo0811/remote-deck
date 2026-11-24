import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'werift';
import {
  FRAME_KIND,
  MSG,
  computeChallengeProof,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
} from '../packages/shared/src/index.mjs';
import { createRelayServer } from '../packages/relay-server/src/server.mjs';
import { HostAgent } from '../packages/host-agent/src/agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(__dirname, '../apps/web/dist');

function connectAndAuthWs(wsUrl, pin, expectBadPin = false, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, options);
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
        if (expectBadPin) {
          resolve({ ws, authError: msg });
        } else {
          ws.close();
          reject(new Error(msg.error));
        }
      }
    });
  });
}

test('tunnel classifies the session and returns the native click result', async (t) => {
  const agent = new HostAgent({ lanPort: 0, lanHost: '127.0.0.1', discoveryPort: 0, pin: 'TESTPIN8' });
  t.after(() => agent.stop());
  const { lanPort } = await agent.start();
  const { ws, auth } = await connectAndAuthWs(`ws://127.0.0.1:${lanPort}/ws`, 'TESTPIN8', false, {
    headers: { 'cf-ray': 'test-ray' },
  });
  t.after(() => ws.terminate());
  assert.equal(auth.channel, 'tunnel');
  assert.equal(auth.inputAcknowledgements, true);

  const inject = t.mock.method(agent.native, 'injectMouse', async () => {});
  const click = (inputId) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Missing click result'));
    }, 2000);
    const onMessage = (data, binary) => {
      if (binary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'input_result' || msg.inputId !== inputId) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: MSG.INPUT_MOUSE, action: 'click', x: 0.25, y: 0.5, inputId }));
  });
  assert.deepEqual(await click(1), { type: 'input_result', inputId: 1, ok: true });
  assert.equal(inject.mock.calls[0].arguments[0].x, 0.25);
  assert.equal(inject.mock.calls[0].arguments[1], true);
  inject.mock.mockImplementation(async () => { throw new Error('SendInput failed'); });
  assert.deepEqual(await click(2), { type: 'input_result', inputId: 2, ok: false, error: 'SendInput failed' });
});

test('E2E LAN direct: auth, real screen JPEG capture, PTY execution, and file CRUD/transfer', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remotedeck-e2e-'));
  const agent = new HostAgent({
    lanPort: 0,
    lanHost: '127.0.0.1',
    discoveryPort: 0,
    deviceId: 'RD-9001-0001',
    pin: 'TESTPIN8',
    deviceName: 'Test-Host',
    allowedRoots: [tempRoot],
    webDistDir,
  });

  try {
    const info = await agent.start();
    assert.ok(info.lanPort > 0);
    assert.ok(info.displays.length >= 1);

    // HTTP info & PWA static check on LAN server
    const infoRes = await fetch(`http://127.0.0.1:${info.lanPort}/api/info`);
    assert.equal(infoRes.status, 200);
    const infoJson = await infoRes.json();
    assert.equal(infoJson.deviceId, 'RD-9001-0001');

    // Wrong PIN must be rejected
    const badAttempt = await connectAndAuthWs(`ws://127.0.0.1:${info.lanPort}/ws`, 'WRONGPIN', true);
    assert.match(badAttempt.authError.error, /失败|error/i);
    badAttempt.ws.close();

    // Valid auth over LAN WS
    const { ws, auth } = await connectAndAuthWs(`ws://127.0.0.1:${info.lanPort}/ws`, 'TESTPIN8');
    assert.equal(auth.deviceId, 'RD-9001-0001');
    assert.equal(auth.channel, 'lan');

    // 1. Real screen capture frame from Go native helper
    const firstFramePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No screen frame received')), 8000);
      const onMsg = (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeBinaryEnvelope(data);
        if (env.kind === FRAME_KIND.SCREEN) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(env);
        }
      };
      ws.on('message', onMsg);
    });

    ws.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 10, scale: 0.25, quality: 50 }));
    const frame = await firstFramePromise;
    assert.equal(frame.payload[0], 0xff);
    assert.equal(frame.payload[1], 0xd8);
    assert.ok(frame.meta.width >= 64 && frame.meta.height >= 64);
    ws.send(JSON.stringify({ type: MSG.SCREEN_STOP }));

    // 2. Real PTY open, command execution, output, and close
    const ptyId = 'pty-test-1';
    let inputSent = false;
    const ptyOutputPromise = new Promise((resolve, reject) => {
      let acc = '';
      const timer = setTimeout(() => reject(new Error(`PTY timeout; got: ${acc}`)), 12000);
      const onMsg = (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeBinaryEnvelope(data);
        if (env.kind === FRAME_KIND.PTY_OUT && env.meta.id === ptyId) {
          acc += Buffer.from(env.payload).toString('utf8');
          if (!inputSent && acc.includes('>')) {
            inputSent = true;
            ws.send(JSON.stringify({ type: MSG.PTY_INPUT, id: ptyId, data: 'echo REMOTEDECK_PTY_VERIFIED\r' }));
          }
          if (acc.includes('REMOTEDECK_PTY_VERIFIED') && inputSent) {
            clearTimeout(timer);
            ws.off('message', onMsg);
            resolve(acc);
          }
        }
      };
      ws.on('message', onMsg);
    });

    ws.send(JSON.stringify({ type: MSG.PTY_OPEN, id: ptyId, cols: 80, rows: 24, shell: 'cmd', cwd: tempRoot }));
    const ptyOut = await ptyOutputPromise;
    assert.match(ptyOut, /REMOTEDECK_PTY_VERIFIED/);
    ws.send(JSON.stringify({ type: MSG.PTY_RESIZE, id: ptyId, cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: MSG.PTY_CLOSE, id: ptyId }));

    // 3. File CRUD + chunked upload & download
    const rpc = (msg) =>
      new Promise((resolve, reject) => {
        const reqId = `req-${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => reject(new Error(`FS timeout: ${msg.type}`)), 5000);
        const onMsg = (data, isBinary) => {
          if (isBinary) return;
          const parsed = JSON.parse(data.toString('utf8'));
          if (parsed.reqId === reqId || (msg.transferId && parsed.transferId === msg.transferId && parsed.op === 'upload_done')) {
            clearTimeout(timer);
            ws.off('message', onMsg);
            if (parsed.type === MSG.FS_ERROR) reject(new Error(parsed.error));
            else resolve(parsed);
          }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ ...msg, reqId }));
      });

    const rootsRes = await rpc({ type: MSG.FS_ROOTS });
    assert.equal(rootsRes.roots[0].path, tempRoot);

    const subDir = path.join(tempRoot, 'demo-folder');
    await rpc({ type: MSG.FS_MKDIR, path: subDir });

    const transferId = 'up-1';
    const startAck = await rpc({
      type: MSG.FS_UPLOAD_START,
      transferId,
      dirPath: subDir,
      fileName: 'hello.txt',
      total: 18,
    });
    // The upload handshake must be acknowledged, otherwise the browser waits for
    // a reply that never comes and stalls five seconds before sending bytes.
    assert.equal(startAck.op, 'upload_ack');
    assert.equal(startAck.ok, true);
    assert.equal(startAck.offset, 0);
    const uploadDonePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Upload finish timeout')), 5000);
      const onMsg = (data, isBinary) => {
        if (isBinary) return;
        const parsed = JSON.parse(data.toString('utf8'));
        if (parsed.op === 'upload_done' && parsed.transferId === transferId) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(parsed);
        }
      };
      ws.on('message', onMsg);
    });
    ws.send(encodeBinaryEnvelope(FRAME_KIND.FILE_UP, { transferId, done: true }, Buffer.from('Hello RemoteDeck!\n')));
    const doneAck = await uploadDonePromise;
    assert.equal(doneAck.ok, true);

    const readRes = await rpc({ type: MSG.FS_READ_TEXT, path: path.join(subDir, 'hello.txt') });
    assert.equal(readRes.content, 'Hello RemoteDeck!\n');

    const dlPromise = new Promise((resolve, reject) => {
      const chunks = [];
      const timer = setTimeout(() => reject(new Error('Download timeout')), 5000);
      const onMsg = (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeBinaryEnvelope(data);
        if (env.kind === FRAME_KIND.FILE_DOWN && env.meta.transferId === 'dl-1') {
          chunks.push(Buffer.from(env.payload));
          if (env.meta.done) {
            clearTimeout(timer);
            ws.off('message', onMsg);
            resolve(Buffer.concat(chunks).toString('utf8'));
          }
        }
      };
      ws.on('message', onMsg);
    });
    ws.send(JSON.stringify({ type: MSG.FS_DOWNLOAD, path: path.join(subDir, 'hello.txt'), transferId: 'dl-1' }));
    assert.equal(await dlPromise, 'Hello RemoteDeck!\n');

    ws.close();
  } finally {
    await agent.stop();
    await new Promise((r) => setTimeout(r, 200));
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 150 });
  }
});

test('E2E WAN Relay + Signaling + WebRTC DataChannel P2P upgrade', async () => {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', webDistDir });
  const bound = await relay.start();
  const relayHttp = `http://127.0.0.1:${bound.port}`;
  const relayWs = `ws://127.0.0.1:${bound.port}/ws`;

  const agent = new HostAgent({
    lanPort: 0,
    lanHost: '127.0.0.1',
    discoveryPort: 0,
    relayUrl: relayWs,
    deviceId: 'RD-8002-0002',
    pin: 'WANPIN99',
    deviceName: 'WAN-Host',
  });

  try {
    await agent.start();

    // Wait for agent registration on relay
    let registered = false;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${relayHttp}/api/devices`);
      const body = await res.json();
      if (body.devices.some((d) => d.deviceId === 'RD-8002-0002')) {
        registered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(registered, true);

    // Static PWA serving check on relay
    const indexRes = await fetch(`${relayHttp}/`);
    assert.equal(indexRes.status, 200);
    assert.match(await indexRes.text(), /RemoteDeck/);
    const jsRes = await fetch(`${relayHttp}/app.js`);
    assert.equal(jsRes.status, 200);

    // Controller connects through Relay Tunnel AND negotiates WebRTC P2P DataChannel
    const ctrlWs = new WebSocket(relayWs);
    ctrlWs.binaryType = 'arraybuffer';

    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('remotedeck', { ordered: true });

    let relayAuthed = false;
    let relayFrameReceived = false;
    let rtcAuthed = false;
    let rtcFrameReceived = false;

    const donePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WAN test incomplete: relayAuthed=${relayAuthed}, relayFrame=${relayFrameReceived}, rtcAuthed=${rtcAuthed}, rtcFrame=${rtcFrameReceived}`));
      }, 15000);

      const maybeFinish = () => {
        if (relayAuthed && relayFrameReceived && rtcAuthed && rtcFrameReceived) {
          clearTimeout(timer);
          resolve();
        }
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate && ctrlWs.readyState === WebSocket.OPEN) {
          ctrlWs.send(JSON.stringify({ type: MSG.RTC_ICE, candidate: ev.candidate }));
        }
      };

      dc.onopen = () => {
        // Wait for auth_challenge on DataChannel
      };

      dc.onmessage = (ev) => {
        const raw = ev.data;
        if (typeof raw === 'string') {
          const msg = JSON.parse(raw);
          if (msg.type === MSG.AUTH_CHALLENGE) {
            const proof = computeChallengeProof('WANPIN99', msg.nonce, msg.deviceId);
            dc.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof }));
          } else if (msg.type === MSG.AUTH_OK) {
            rtcAuthed = true;
            dc.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 10, scale: 0.25, quality: 50 }));
          }
        } else {
          const env = decodeBinaryEnvelope(raw);
          if (env.kind === FRAME_KIND.SCREEN && env.payload[0] === 0xff) {
            rtcFrameReceived = true;
            dc.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
            maybeFinish();
          }
        }
      };

      ctrlWs.on('open', () => {
        ctrlWs.send(JSON.stringify({ type: MSG.CONTROLLER_CONNECT, deviceId: 'RD-8002-0002' }));
      });

      ctrlWs.on('message', async (data, isBinary) => {
        if (isBinary) {
          const env = decodeBinaryEnvelope(data);
          if (env.kind === FRAME_KIND.SCREEN && env.payload[0] === 0xff) {
            relayFrameReceived = true;
            ctrlWs.send(JSON.stringify({ type: MSG.SCREEN_STOP }));
            maybeFinish();
          }
          return;
        }
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === MSG.ROUTE_CANDIDATES) {
          assert.equal(msg.relayAvailable, true);
          assert.ok(Array.isArray(msg.lanEndpoints));
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ctrlWs.send(JSON.stringify({ type: MSG.RTC_OFFER, sdp: offer.sdp }));
        } else if (msg.type === MSG.RTC_ANSWER) {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        } else if (msg.type === MSG.RTC_ICE && msg.candidate) {
          await pc.addIceCandidate(msg.candidate);
        } else if (msg.type === MSG.AUTH_CHALLENGE) {
          const proof = computeChallengeProof('WANPIN99', msg.nonce, msg.deviceId);
          ctrlWs.send(JSON.stringify({ type: MSG.AUTH_RESPONSE, proof }));
        } else if (msg.type === MSG.AUTH_OK) {
          relayAuthed = true;
          assert.equal(msg.channel, 'relay');
          ctrlWs.send(JSON.stringify({ type: MSG.SCREEN_START, displayId: 0, fps: 10, scale: 0.25, quality: 50 }));
        }
      });
    });

    await donePromise;
    dc.close();
    pc.close();
    ctrlWs.close();
  } finally {
    await agent.stop();
    await relay.stop();
  }
});
