import { audio } from '@kit.AudioKit';

const IMA_INDEX_TABLE: number[] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP_TABLE: number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

interface ImaState {
  pred: number;
  index: number;
}

function decodeImaNibble(state: ImaState, nibble: number): number {
  const step = IMA_STEP_TABLE[state.index];
  let delta = step >> 3;
  if ((nibble & 4) !== 0) delta += step;
  if ((nibble & 2) !== 0) delta += step >> 1;
  if ((nibble & 1) !== 0) delta += step >> 2;
  state.pred += (nibble & 8) !== 0 ? -delta : delta;
  if (state.pred > 32767) state.pred = 32767;
  else if (state.pred < -32768) state.pred = -32768;
  const nextIdx = state.index + IMA_INDEX_TABLE[nibble & 0x0f];
  state.index = nextIdx < 0 ? 0 : (nextIdx > 88 ? 88 : nextIdx);
  return state.pred;
}

export function decodeImaAdpcmToPcmBytes(data: Uint8Array, channels: number, frames: number): Uint8Array {
  const chCount = channels === 1 ? 1 : 2;
  const hdrBytes = chCount * 4;
  if (frames <= 0 || data.byteLength < hdrBytes) {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(frames * chCount * 2);
  const view = new DataView(out.buffer);
  const inView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const st: ImaState[] = [];
  for (let ch = 0; ch < chCount; ch++) {
    const off = ch * 4;
    const pred = inView.getInt16(off, true);
    const rawIdx = data[off + 2];
    const idx = rawIdx < 0 ? 0 : (rawIdx > 88 ? 88 : rawIdx);
    st.push({ pred, index: idx });
    view.setInt16(ch * 2, pred, true);
  }
  if (chCount === 2) {
    for (let f = 1; f < frames && hdrBytes + f - 1 < data.byteLength; f++) {
      const b = data[hdrBytes + f - 1];
      const sL = decodeImaNibble(st[0], b & 0x0f);
      const sR = decodeImaNibble(st[1], (b >> 4) & 0x0f);
      const off = f * 4;
      view.setInt16(off, sL, true);
      view.setInt16(off + 2, sR, true);
    }
  } else {
    let f = 1;
    for (let i = hdrBytes; i < data.byteLength && f < frames; i++) {
      const b = data[i];
      view.setInt16(f * 2, decodeImaNibble(st[0], b & 0x0f), true);
      f++;
      if (f < frames) {
        view.setInt16(f * 2, decodeImaNibble(st[0], (b >> 4) & 0x0f), true);
        f++;
      }
    }
  }
  return out;
}

export class HarmonyAudioPlayer {
  private renderer: audio.AudioRenderer | null = null;
  private activeRate: number = 48000;
  private activeChannels: number = 2;
  private enabled: boolean = false;
  private creating: boolean = false;
  private queue: Uint8Array[] = [];
  private queuedBytes: number = 0;
  private readOffset: number = 0;

  async start(sampleRate: number = 48000, channels: number = 2): Promise<boolean> {
    this.enabled = true;
    const rate = sampleRate === 44100 ? 44100 : 48000;
    const ch = channels === 1 ? 1 : 2;
    if (this.renderer && this.activeRate === rate && this.activeChannels === ch) {
      try {
        await this.renderer.start();
        return true;
      } catch {
        // Recreate renderer below
      }
    }
    return await this.initRenderer(rate, ch);
  }

  private async initRenderer(rate: number, ch: number): Promise<boolean> {
    if (this.creating) return false;
    this.creating = true;
    try {
      await this.releaseRenderer();
      const streamInfo: audio.AudioStreamInfo = {
        samplingRate: rate === 44100
          ? audio.AudioSamplingRate.SAMPLE_RATE_44100
          : audio.AudioSamplingRate.SAMPLE_RATE_48000,
        channels: ch === 1 ? audio.AudioChannel.CHANNEL_1 : audio.AudioChannel.CHANNEL_2,
        sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
        encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW,
      };
      const rendererInfo: audio.AudioRendererInfo = {
        usage: audio.StreamUsage.STREAM_USAGE_MUSIC,
        rendererFlags: 0,
      };
      const opts: audio.AudioRendererOptions = {
        streamInfo,
        rendererInfo,
      };
      const r = await audio.createAudioRenderer(opts);
      this.activeRate = rate;
      this.activeChannels = ch;
      r.on('writeData', (buffer: ArrayBuffer): audio.AudioDataCallbackResult => {
        const dst = new Uint8Array(buffer);
        dst.fill(0);
        let written = 0;
        while (written < dst.byteLength && this.queue.length > 0) {
          const head = this.queue[0];
          const avail = head.byteLength - this.readOffset;
          const take = Math.min(dst.byteLength - written, avail);
          dst.set(head.subarray(this.readOffset, this.readOffset + take), written);
          written += take;
          this.readOffset += take;
          this.queuedBytes -= take;
          if (this.readOffset >= head.byteLength) {
            this.queue.shift();
            this.readOffset = 0;
          }
        }
        return audio.AudioDataCallbackResult.VALID;
      });
      this.renderer = r;
      if (this.enabled) {
        await r.start();
      }
      return true;
    } catch {
      return false;
    } finally {
      this.creating = false;
    }
  }

  pushPcm(sampleRate: number, channels: number, pcm: Uint8Array): void {
    if (!this.enabled || pcm.byteLength === 0) return;
    const normRate = sampleRate === 44100 ? 44100 : 48000;
    const normCh = channels === 1 ? 1 : 2;
    if (!this.renderer || this.activeRate !== normRate || this.activeChannels !== normCh) {
      if (!this.creating) {
        void this.initRenderer(normRate, normCh);
      }
      return;
    }
    const copy = pcm.slice();
    this.queue.push(copy);
    this.queuedBytes += copy.byteLength;
    // Cap jitter buffer to ~100ms to keep audio tight with 60fps H.264 video
    const maxBytes = normRate * normCh * 2 / 10;
    while (this.queuedBytes > maxBytes && this.queue.length > 1) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.queuedBytes -= (dropped.byteLength - this.readOffset);
      }
      this.readOffset = 0;
    }
  }

  async stop(): Promise<void> {
    this.enabled = false;
    this.queue = [];
    this.queuedBytes = 0;
    this.readOffset = 0;
    if (this.renderer) {
      try {
        await this.renderer.stop();
      } catch {
        // Ignore stop error
      }
    }
  }

  async releaseRenderer(): Promise<void> {
    this.queue = [];
    this.queuedBytes = 0;
    this.readOffset = 0;
    if (this.renderer) {
      const r = this.renderer;
      this.renderer = null;
      try {
        r.off('writeData');
      } catch {
        // Ignore
      }
      try {
        await r.release();
      } catch {
        // Ignore
      }
    }
  }
}
