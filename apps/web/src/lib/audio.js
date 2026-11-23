const IMA_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

function decodeImaNibble(state, nibble) {
  const step = IMA_STEP_TABLE[state.index];
  let delta = step >> 3;
  if (nibble & 4) delta += step;
  if (nibble & 2) delta += step >> 1;
  if (nibble & 1) delta += step >> 2;
  state.pred += nibble & 8 ? -delta : delta;
  if (state.pred > 32767) state.pred = 32767;
  else if (state.pred < -32768) state.pred = -32768;
  state.index = Math.max(0, Math.min(88, state.index + IMA_INDEX_TABLE[nibble & 0x0f]));
  return state.pred;
}

export function decodeImaAdpcmToInt16(data, channels, frames) {
  const chCount = channels === 1 ? 1 : 2;
  const hdrBytes = chCount * 4;
  if (!data || frames <= 0 || data.byteLength < hdrBytes) return new Int16Array(0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Int16Array(frames * chCount);
  const st = [];
  for (let ch = 0; ch < chCount; ch += 1) {
    const off = ch * 4;
    const pred = view.getInt16(off, true);
    const idx = Math.max(0, Math.min(88, data[off + 2]));
    st.push({ pred, index: idx });
    out[ch] = pred;
  }
  if (chCount === 2) {
    for (let f = 1; f < frames && hdrBytes + f - 1 < data.byteLength; f += 1) {
      const b = data[hdrBytes + f - 1];
      out[f * 2] = decodeImaNibble(st[0], b & 0x0f);
      out[f * 2 + 1] = decodeImaNibble(st[1], (b >> 4) & 0x0f);
    }
  } else {
    let f = 1;
    for (let i = hdrBytes; i < data.byteLength && f < frames; i += 1) {
      const b = data[i];
      out[f++] = decodeImaNibble(st[0], b & 0x0f);
      if (f < frames) out[f++] = decodeImaNibble(st[0], (b >> 4) & 0x0f);
    }
  }
  return out;
}

function buildOpusHead(channels, origSampleRate = 48000) {
  const buf = new Uint8Array(19);
  const magic = 'OpusHead';
  for (let i = 0; i < 8; i++) buf[i] = magic.charCodeAt(i);
  buf[8] = 1; // version
  buf[9] = channels === 1 ? 1 : 2;
  const dv = new DataView(buf.buffer);
  dv.setUint16(10, 312, true); // standard pre-skip
  dv.setUint32(12, origSampleRate, true);
  dv.setUint16(16, 0, true);
  buf[18] = 0;
  return buf;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class RemoteAudioPlayer {
  constructor() {
    this.ctx = null;
    this.nextPlayAt = 0;
    this.enabled = false;
    this.opusDecoder = null;
    this.opusConfigKey = '';
    this.opusTimestamp = 0;
    this.opusHead = null;
  }

  static async supportedOpus() {
    if (typeof AudioDecoder === 'undefined') return false;
    try {
      const res = await AudioDecoder.isConfigSupported({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
      });
      return Boolean(res?.supported);
    } catch {
      return false;
    }
  }

  async start() {
    this.enabled = true;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
    this.nextPlayAt = this.ctx.currentTime + 0.04;
    return true;
  }

  #resetOpus() {
    if (this.opusDecoder) {
      try {
        this.opusDecoder.close();
      } catch {}
      this.opusDecoder = null;
    }
    this.opusConfigKey = '';
  }

  stop() {
    this.enabled = false;
    this.nextPlayAt = 0;
    this.#resetOpus();
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }

  destroy() {
    this.enabled = false;
    this.#resetOpus();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  #scheduleAudioBuffer(audioBuf) {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    if (this.nextPlayAt < now || this.nextPlayAt - now > 0.14) {
      this.nextPlayAt = now + 0.03;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(this.ctx.destination);
    src.start(this.nextPlayAt);
    this.nextPlayAt += audioBuf.duration;
  }

  #ensureOpusDecoder(sampleRate, channels, headBytes) {
    if (typeof AudioDecoder === 'undefined') return false;
    const key = `${sampleRate}:${channels}`;
    if (this.opusDecoder && this.opusConfigKey === key) return true;
    this.#resetOpus();
    try {
      const decoder = new AudioDecoder({
        output: (audioData) => {
          try {
            if (!this.enabled || !this.ctx) return;
            const chCount = Math.max(1, Math.min(2, audioData.numberOfChannels || channels));
            const frameCount = audioData.numberOfFrames;
            const sr = audioData.sampleRate || sampleRate;
            if (frameCount <= 0) return;
            const audioBuf = this.ctx.createBuffer(chCount, frameCount, sr);
            const fmt = String(audioData.format || '');
            if (fmt === 'f32-planar' || fmt === '') {
              for (let ch = 0; ch < chCount; ch++) {
                audioData.copyTo(audioBuf.getChannelData(ch), { planeIndex: ch, format: 'f32-planar' });
              }
            } else if (fmt === 'f32') {
              const inter = new Float32Array(frameCount * chCount);
              audioData.copyTo(inter, { planeIndex: 0 });
              for (let ch = 0; ch < chCount; ch++) {
                const dst = audioBuf.getChannelData(ch);
                for (let i = 0; i < frameCount; i++) dst[i] = inter[i * chCount + ch];
              }
            } else {
              for (let ch = 0; ch < chCount; ch++) {
                audioData.copyTo(audioBuf.getChannelData(ch), { planeIndex: ch, format: 'f32-planar' });
              }
            }
            this.#scheduleAudioBuffer(audioBuf);
          } catch {} finally {
            audioData.close();
          }
        },
        error: () => {
          this.#resetOpus();
        },
      });
      const cfg = {
        codec: 'opus',
        sampleRate,
        numberOfChannels: channels,
        description: headBytes || buildOpusHead(channels, sampleRate),
      };
      decoder.configure(cfg);
      this.opusDecoder = decoder;
      this.opusConfigKey = key;
      this.opusTimestamp = 0;
      return true;
    } catch {
      this.#resetOpus();
      return false;
    }
  }

  pushPcm16(meta, pcmBytes) {
    if (!this.enabled || !this.ctx || !pcmBytes || pcmBytes.byteLength < 2) return;
    const sampleRate = Number(meta?.sampleRate) || 48000;
    const channels = Math.max(1, Math.min(2, Number(meta?.channels) || 2));

    if (meta?.codec === 'opus') {
      if (meta.head && !this.opusHead) {
        try {
          this.opusHead = base64ToBytes(meta.head);
        } catch {}
      }
      if (this.#ensureOpusDecoder(sampleRate, channels, this.opusHead)) {
        try {
          this.opusDecoder.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: this.opusTimestamp,
              duration: 20000,
              data: pcmBytes,
            }),
          );
          this.opusTimestamp += 20000;
        } catch {
          this.#resetOpus();
        }
      }
      return;
    }

    if (pcmBytes.byteLength < 4) return;
    let aligned;
    if (meta?.codec === 'ima_adpcm') {
      const frames = Number(meta?.frames) || Math.max(0, pcmBytes.byteLength - channels * 4 + 1);
      aligned = decodeImaAdpcmToInt16(pcmBytes, channels, frames);
    } else {
      aligned = pcmBytes.byteOffset % 2 === 0
        ? new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, Math.floor(pcmBytes.byteLength / 2))
        : new Int16Array(pcmBytes.slice().buffer);
    }

    const frameCount = Math.floor(aligned.length / channels);
    if (frameCount <= 0) return;

    const audioBuf = this.ctx.createBuffer(channels, frameCount, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const chData = audioBuf.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        chData[i] = aligned[i * channels + ch] / 32768;
      }
    }

    this.#scheduleAudioBuffer(audioBuf);
  }
}
