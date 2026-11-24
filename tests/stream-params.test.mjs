import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveStreamParams } from '../packages/host-agent/src/agent.mjs';

const uhd = { fps: 24, scale: 1.0, quality: 92, maxWidth: 0, auto: false, codec: 'h264' };
const fluent = { fps: 24, scale: 0.5, quality: 62, maxWidth: 1280, auto: false, codec: 'h264' };

test('LAN keeps the preset the user picked', () => {
  const p = effectiveStreamParams(uhd, { abrLevel: 0, channel: 'lan' });
  assert.equal(p.fps, 24);
  assert.equal(p.quality, 92);
  assert.equal(p.maxWidth, 0);
});

test('relay/tunnel cap resolution, fps and bitrate-defining quality', () => {
  const relay = effectiveStreamParams(uhd, { abrLevel: 0, channel: 'relay' });
  assert.ok(relay.maxWidth > 0 && relay.maxWidth <= 1600, `relay width ${relay.maxWidth}`);
  assert.ok(relay.fps <= 24, `relay fps ${relay.fps}`);
  assert.ok(relay.quality < 92, `relay quality ${relay.quality}`);

  const tunnel = effectiveStreamParams(uhd, { abrLevel: 0, channel: 'tunnel' });
  assert.ok(tunnel.maxWidth <= 1440, `tunnel width ${tunnel.maxWidth}`);
  assert.ok(tunnel.quality < relay.quality, 'tunnel must be leaner than relay');
});

test('the worst channel wins when several clients watch', () => {
  const lan = effectiveStreamParams(uhd, { abrLevel: 0, channel: 'lan' });
  const mixed = effectiveStreamParams(uhd, { abrLevel: 0, channel: 'tunnel' });
  assert.ok(mixed.quality <= lan.quality);
});

test('congestion lowers the bitrate even for a pinned preset', () => {
  const clean = effectiveStreamParams(uhd, { abrLevel: 0, channel: 'lan' });
  const congested = effectiveStreamParams(uhd, { abrLevel: 2, channel: 'lan' });
  assert.equal(congested.fps, clean.fps, 'manual presets keep their frame rate');
  assert.ok(congested.quality < clean.quality, `expected lower quality, got ${congested.quality}`);
});

test('a user width cap is never exceeded, and small presets are not raised', () => {
  const p = effectiveStreamParams({ ...uhd, maxWidth: 1280 }, { abrLevel: 0, channel: 'relay' });
  assert.equal(p.maxWidth, 1280);
  const small = effectiveStreamParams(fluent, { abrLevel: 0, channel: 'tunnel' });
  assert.equal(small.maxWidth, 1280);
});

test('auto mode still uses the ABR tiers and stays WAN-capped', () => {
  const auto0 = effectiveStreamParams({ ...uhd, auto: true }, { abrLevel: 0, channel: 'lan' });
  const auto3 = effectiveStreamParams({ ...uhd, auto: true }, { abrLevel: 3, channel: 'lan' });
  assert.ok(auto3.quality < auto0.quality);
  assert.ok(auto3.maxWidth <= auto0.maxWidth);
  const autoRelay = effectiveStreamParams({ ...uhd, auto: true }, { abrLevel: 0, channel: 'relay' });
  assert.ok(autoRelay.maxWidth > 0 && autoRelay.maxWidth <= 1600);
});

test('zoom (hiRes) still prefers full resolution', () => {
  const p = effectiveStreamParams({ ...uhd, hiRes: true }, { abrLevel: 0, channel: 'relay' });
  assert.equal(p.scale, 1.0);
  assert.equal(p.maxWidth, 0);
});
