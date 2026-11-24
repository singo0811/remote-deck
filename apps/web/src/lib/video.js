/**
 * WebCodecs H.264 player: decodes Annex-B access units produced by the host's
 * ffmpeg pipeline straight onto the remote canvas. Any failure falls back to the
 * JPEG stream (the caller switches codec back to 'jpeg').
 */
function avcCodecFromKeyframe(bytes) {
  for (let i = 0; i + 6 < bytes.length; i += 1) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 31) === 7) {
      const profile = bytes.subarray(i + 4, i + 7);
      return `avc1.${Array.from(profile, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return 'avc1.42E01E';
}

export class H264Player {
  constructor() {
    this.decoder = null;
    this.canvas = null;
    this.ctx = null;
    this.onError = null;
    this.decoded = 0;
    this.configKey = '';
    this.pendingMetas = [];
    this.waitingForKey = true;
  }

  static async supported() {
    if (typeof VideoDecoder === 'undefined') return false;
    try {
      const res = await VideoDecoder.isConfigSupported({
        codec: 'avc1.42E01E',
        avc: { format: 'annexb' },
      });
      return Boolean(res?.supported);
    } catch {
      return false;
    }
  }

  attach(canvas) {
    this.canvas = canvas || null;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
  }

  reset() {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {}
      this.decoder = null;
    }
    this.configKey = '';
    this.pendingMetas = [];
    this.waitingForKey = true;
  }

  configure(width, height, codec) {
    const key = `${width}x${height}:${codec}`;
    if (this.decoder && this.configKey === key) return true;
    this.reset();
    try {
      const decoder = new VideoDecoder({
        output: (frame) => this.#draw(frame),
        error: (err) => {
          this.reset();
          this.onError?.(err);
        },
      });
      decoder.configure({
        codec,
        avc: { format: 'annexb' },
        codedWidth: width,
        codedHeight: height,
        optimizeForLatency: true,
      });
      this.decoder = decoder;
      this.configKey = key;
      this.waitingForKey = true;
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  #draw(frame) {
    const meta = this.pendingMetas.shift();
    try {
      const canvas = this.canvas;
      const ctx = this.ctx || canvas?.getContext('2d');
      if (canvas && ctx) {
        if (meta?.roi && meta.fullWidth > 0 && meta.fullHeight > 0) {
          if (canvas.width !== meta.fullWidth) canvas.width = meta.fullWidth;
          if (canvas.height !== meta.fullHeight) canvas.height = meta.fullHeight;
          ctx.drawImage(
            frame,
            meta.roi.x * canvas.width,
            meta.roi.y * canvas.height,
            meta.roi.w * canvas.width,
            meta.roi.h * canvas.height,
          );
        } else {
          if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
          if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
          ctx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
        }
      }
      this.decoded += 1;
    } finally {
      frame.close();
    }
  }

  push(meta, bytes) {
    if (!bytes || bytes.byteLength === 0) return false;
    const width = Number(meta?.width) || 0;
    const height = Number(meta?.height) || 0;
    const isKey = Boolean(meta?.key);
    if (isKey && width > 0 && height > 0) {
      if (!this.configure(width, height, avcCodecFromKeyframe(bytes))) return false;
    }
    if (!this.decoder) return false;
    if (this.waitingForKey) {
      if (!isKey) return false;
      this.waitingForKey = false;
    }
    try {
      this.pendingMetas.push(meta || null);
      if (this.pendingMetas.length > 24) this.pendingMetas.shift();
      this.decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: Number(meta?.ts) || Math.round(performance.now() * 1000),
          data: bytes,
        }),
      );
      return true;
    } catch (err) {
      this.reset();
      this.onError?.(err);
      return false;
    }
  }
}
