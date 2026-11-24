export const RTC_VIDEO_CHANNEL = 'remotedeck-video-v1';
export const RTC_VIDEO_READY = 'rtc_video_ready';
export const RTC_VIDEO_MAX_FRAME = 2 * 1024 * 1024;
const HEADER_BYTES = 8;
const CHUNK_BYTES = 12 * 1024 - HEADER_BYTES;
const MAX_CHUNKS = Math.ceil(RTC_VIDEO_MAX_FRAME / CHUNK_BYTES);

export function* packetizeRtcVideo(seq, frame) {
  if (frame.byteLength === 0 || frame.byteLength > RTC_VIDEO_MAX_FRAME) return;
  const count = Math.ceil(frame.byteLength / CHUNK_BYTES);
  for (let index = 0; index < count; index += 1) {
    const chunk = frame.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    const packet = new Uint8Array(HEADER_BYTES + chunk.byteLength);
    const header = new DataView(packet.buffer);
    header.setUint32(0, seq);
    header.setUint16(4, index);
    header.setUint16(6, count);
    packet.set(chunk, HEADER_BYTES);
    yield packet;
  }
}

export class RtcVideoAssembler {
  constructor() {
    this.frames = new Map();
    this.lastDelivered = 0;
  }

  push(raw, now = performance.now()) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.byteLength <= HEADER_BYTES || bytes.byteLength > HEADER_BYTES + CHUNK_BYTES) return null;
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seq = header.getUint32(0);
    const index = header.getUint16(4);
    const count = header.getUint16(6);
    if (seq <= this.lastDelivered || count === 0 || count > MAX_CHUNKS || index >= count) return null;
    const payload = bytes.subarray(HEADER_BYTES);
    if (index + 1 < count && payload.byteLength !== CHUNK_BYTES) return null;
    if (index * CHUNK_BYTES + payload.byteLength > RTC_VIDEO_MAX_FRAME) return null;

    for (const [id, frame] of this.frames) {
      if (now - frame.started > 250) this.frames.delete(id);
    }
    let frame = this.frames.get(seq);
    if (!frame) {
      if (this.frames.size >= 4) this.frames.delete(this.frames.keys().next().value);
      frame = { started: now, parts: new Array(count), received: 0, length: 0 };
      this.frames.set(seq, frame);
    }
    if (frame.parts.length !== count || frame.parts[index]) return null;
    frame.parts[index] = payload;
    frame.received += 1;
    frame.length += payload.byteLength;
    if (frame.received !== count) return null;

    const data = new Uint8Array(frame.length);
    let offset = 0;
    for (const part of frame.parts) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    const gap = this.lastDelivered !== 0 && seq !== this.lastDelivered + 1;
    this.lastDelivered = seq;
    for (const id of this.frames.keys()) {
      if (id <= seq) this.frames.delete(id);
    }
    return { data, gap };
  }
}
