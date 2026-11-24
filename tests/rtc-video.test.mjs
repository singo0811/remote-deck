import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RTCPeerConnection } from 'werift';
import { WebSocket } from 'ws';
import { RemoteTransport } from '../apps/web/src/lib/transport.js';
import { HostAgent } from '../packages/host-agent/src/agent.mjs';
import { createRelayServer } from '../packages/relay-server/src/server.mjs';
import { MSG, RTC_VIDEO_CHANNEL, RtcVideoAssembler, packetizeRtcVideo } from '../packages/shared/src/index.mjs';

test('video reassembly discards incomplete and stale access units and reports gaps', () => {
  const assembler = new RtcVideoAssembler();
  const accessUnit = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
  const packets = Array.from(packetizeRtcVideo(1, accessUnit)).reverse();
  assert.ok(packets.every((packet) => packet.byteLength <= 12 * 1024));
  assert.equal(assembler.push(packets[0], 10), null);
  assert.equal(assembler.push(packets[0], 11), null);
  for (const packet of packets.slice(1, -1)) assert.equal(assembler.push(packet, 12), null);
  assert.deepEqual(assembler.push(packets.at(-1), 13), { data: accessUnit, gap: false });

  const missing = Array.from(packetizeRtcVideo(2, accessUnit));
  assert.equal(assembler.push(missing[0], 30), null);
  const [next] = packetizeRtcVideo(3, Uint8Array.of(42));
  assert.deepEqual(assembler.push(next, 60), { data: Uint8Array.of(42), gap: true });
  for (const packet of missing.slice(1)) assert.equal(assembler.push(packet, 61), null);
});

test('Web upgrades from relay to WebRTC and receives H.264 on the unreliable channel', { timeout: 20_000 }, async (t) => {
  let videoChannel;
  class BrowserPeer extends RTCPeerConnection {
    constructor() {
      super({ iceServers: [] });
      this.onDataChannel.subscribe((channel) => {
        if (channel.label === RTC_VIDEO_CHANNEL) videoChannel = channel;
      });
    }
  }
  const prevRtc = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = BrowserPeer;
  t.after(() => { globalThis.RTCPeerConnection = prevRtc; });

  const relay = createRelayServer({ port: 0, host: '127.0.0.1', iceServers: [] });
  const { port } = await relay.start();
  const serverUrl = `ws://127.0.0.1:${port}/ws`;
  const pin = 'RTCTEST9';
  const deviceId = 'RD-8080-8080';
  const agent = new HostAgent({ lanPort: 0, lanHost: '127.0.0.1', discoveryPort: 0, relayUrl: serverUrl, deviceId, pin });
  agent.getLanEndpoints = () => [];
  const connections = [];
  const frames = [];
  let resets = 0;
  const transport = new RemoteTransport({
    onAuthenticated: (_auth, channel) => {
      connections.push(channel);
      transport.sendJson({ type: MSG.SCREEN_START, codec: 'h264' });
    },
    onVideoDiscontinuity: () => { resets += 1; },
    onVideoFrame: (meta, bytes) => frames.push({ meta, bytes: Uint8Array.from(bytes) }),
  });

  async function waitFor(condition, message) {
    const deadline = Date.now() + 8_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, message);
      await delay(20);
    }
  }

  try {
    await agent.start();
    agent.videoEncoderAvailable = true;
    agent.captureBridge = {
      captureFrame: async () => {
        await delay(25);
        return { meta: { video: true, unchanged: true } };
      },
    };
    await waitFor(() => agent.relayConnected, 'host did not register');
    await transport.connect({ mode: 'relay', serverUrl, deviceId, pin });
    await waitFor(() => agent.videoOwner?.videoTransport?.isOpen(), 'unreliable video channel did not activate');
    assert.deepEqual(connections, ['relay', 'webrtc']);
    assert.equal(videoChannel.ordered, false);
    assert.equal(videoChannel.maxPacketLifeTime, 150);
    assert.equal(transport.signalingWs.readyState, WebSocket.OPEN);

    const key = new Uint8Array(75_000).fill(42);
    for (let attempt = 0; attempt < 5 && frames.length === 0; attempt += 1) {
      // Like the real encoder, offer a fresh IDR after a previous one expired.
      agent.native.emit('video_packet', { meta: { key: true, seq: 1 }, data: key });
      await delay(400);
    }
    assert.ok(frames.length > 0, 'fragmented video keyframe did not arrive');
    assert.deepEqual(frames[0], { meta: { key: true, seq: 1 }, bytes: key });
    assert.ok(resets >= 2);
    await waitFor(() => transport.rttMs !== null, 'reliable control ping did not receive a response');

    agent.videoOwner.videoTransport.close();
    await waitFor(() => videoChannel.readyState === 'closed', 'video channel did not close');
    const frameCount = frames.length;
    const smallKey = Uint8Array.of(1, 2, 3);
    agent.native.emit('video_packet', { meta: { key: true, seq: 2 }, data: smallKey });
    await waitFor(() => frames.length > frameCount, 'reliable video fallback did not deliver');
    assert.deepEqual(frames.at(-1), { meta: { key: true, seq: 2 }, bytes: smallKey });
  } finally {
    transport.disconnect();
    await agent.stop();
    await relay.stop();
  }
});
