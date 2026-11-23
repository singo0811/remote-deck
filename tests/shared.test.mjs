import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  FRAME_KIND,
  classifyIp,
  collectLocalAddresses,
  computeChallengeProof,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  isVirtualEndpoint,
  signSessionToken,
  verifyChallengeProof,
  verifySessionToken,
} from '../packages/shared/src/index.mjs';
import {
  computeChallengeProof as browserChallengeProof,
  decodeBinaryEnvelope as browserDecode,
  encodeBinaryEnvelope as browserEncode,
  hmacSha256Hex as browserHmacHex,
} from '../apps/web/src/lib/protocol.js';

test('binary envelope encodes and decodes across shared and browser codecs', () => {
  const payload = Uint8Array.from([0xff, 0xd8, 0x01, 0x02, 0x03]);
  const meta = { displayId: 0, width: 1280, height: 720, label: '中文测试' };

  const encoded = encodeBinaryEnvelope(FRAME_KIND.SCREEN, meta, payload, 3);
  const decodedNode = decodeBinaryEnvelope(encoded);
  const decodedWeb = browserDecode(encoded.buffer);

  assert.equal(decodedNode.kind, FRAME_KIND.SCREEN);
  assert.equal(decodedNode.flags, 3);
  assert.deepEqual(decodedNode.meta, meta);
  assert.deepEqual(Array.from(decodedNode.payload), Array.from(payload));

  assert.equal(decodedWeb.kind, FRAME_KIND.SCREEN);
  assert.deepEqual(decodedWeb.meta, meta);
  assert.deepEqual(Array.from(decodedWeb.payload), Array.from(payload));

  const webEncoded = browserEncode(FRAME_KIND.PTY_OUT, { id: 't1' }, new Uint8Array([65, 66]));
  const back = decodeBinaryEnvelope(webEncoded);
  assert.equal(back.kind, FRAME_KIND.PTY_OUT);
  assert.equal(back.meta.id, 't1');
  assert.deepEqual(Array.from(back.payload), [65, 66]);
});

test('browser pure-JS HMAC-SHA256 matches Node crypto across edge cases', () => {
  const cases = [
    ['PIN12345', 'RD-1000-2000:abcdef'],
    ['', 'empty-key'],
    ['super-long-key-'.repeat(10), '中文消息🚀with-unicode-payload'],
  ];
  for (const [key, msg] of cases) {
    const expected = crypto.createHmac('sha256', key).update(msg).digest('hex');
    const actual = browserHmacHex(key, msg);
    assert.equal(actual, expected);
  }

  const proof = browserChallengeProof('ABCD2345', 'nonce-xyz', 'RD-1111-2222');
  assert.equal(proof, computeChallengeProof('ABCD2345', 'nonce-xyz', 'RD-1111-2222'));
  assert.equal(verifyChallengeProof('ABCD2345', 'nonce-xyz', 'RD-1111-2222', proof), true);
  assert.equal(verifyChallengeProof('WRONGPIN', 'nonce-xyz', 'RD-1111-2222', proof), false);
});

test('session token signing and expiration verification', async () => {
  const token = signSessionToken({ deviceId: 'RD-1', scope: 'all' }, 'signing-key', 5000);
  const verified = verifySessionToken(token, 'signing-key');
  assert.equal(verified.deviceId, 'RD-1');
  assert.equal(verifySessionToken(token, 'wrong-key'), null);

  const expired = signSessionToken({ deviceId: 'RD-1' }, 'signing-key', -10);
  assert.equal(verifySessionToken(expired, 'signing-key'), null);
});

test('IP classification prioritizes LAN and Tailscale accurately', () => {
  assert.equal(classifyIp('192.168.1.55'), 'lan');
  assert.equal(classifyIp('10.20.0.5'), 'lan');
  assert.equal(classifyIp('172.16.8.9'), 'lan');
  assert.equal(classifyIp('172.31.255.1'), 'lan');
  assert.equal(classifyIp('172.32.0.1'), 'public');
  assert.equal(classifyIp('100.64.12.88'), 'tailscale');
  assert.equal(classifyIp('100.127.255.254'), 'tailscale');
  assert.equal(classifyIp('127.0.0.1'), 'loopback');
  assert.equal(classifyIp('::1'), 'loopback');
  assert.equal(classifyIp('fe80::1ff:fe23:4567:890a'), 'link-local');
  assert.equal(classifyIp('fd7a:115c:a1e0::1'), 'tailscale');
  assert.equal(classifyIp('fc00::1'), 'lan');
  assert.equal(classifyIp('240e:390:1::1'), 'public');
  assert.equal(classifyIp('169.254.10.2'), 'link-local');
  assert.equal(classifyIp('8.8.8.8'), 'public');
});

test('virtual NIC detection deprioritizes Hyper-V and TUN adapters behind physical LAN', () => {
  assert.equal(isVirtualEndpoint('vEthernet (ci-internal)', '192.168.77.1'), true);
  assert.equal(isVirtualEndpoint('vEthernet (Default Switch)', '172.30.48.1'), true);
  assert.equal(isVirtualEndpoint('Meta', '198.18.0.1'), true);
  assert.equal(isVirtualEndpoint('以太网', '192.168.3.57'), false);
  assert.equal(isVirtualEndpoint('WLAN', '192.168.1.20'), false);

  const endpoints = collectLocalAddresses(9601);
  assert.ok(endpoints.length >= 1);
  const firstPhysicalIdx = endpoints.findIndex((e) => e.kind === 'lan' && !isVirtualEndpoint(e.iface, e.ip));
  const firstVirtualIdx = endpoints.findIndex((e) => e.kind === 'lan' && isVirtualEndpoint(e.iface, e.ip));
  if (firstPhysicalIdx !== -1 && firstVirtualIdx !== -1) {
    assert.ok(firstPhysicalIdx < firstVirtualIdx);
  }
});
