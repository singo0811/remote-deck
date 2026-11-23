export const FRAME_KIND = {
  SCREEN: 1,
  PTY_OUT: 2,
  FILE_DOWN: 3,
  FILE_UP: 4,
  AUDIO: 5,
  VIDEO: 6,
  PHONE_VIDEO: 7,
  PHONE_AUDIO: 8,
};

export const MSG = {
  AUTH_CHALLENGE: 'auth_challenge',
  AUTH_RESPONSE: 'auth_response',
  AUTH_PENDING: 'auth_pending',
  AUTH_OK: 'auth_ok',
  AUTH_ERROR: 'auth_error',

  CONTROLLER_CONNECT: 'controller_connect',
  ROUTE_CANDIDATES: 'route_candidates',
  RTC_OFFER: 'rtc_offer',
  RTC_ANSWER: 'rtc_answer',
  RTC_ICE: 'rtc_ice',
  RELAY_READY: 'relay_ready',
  PEER_LEFT: 'peer_left',
  ERROR: 'error',

  SCREEN_START: 'screen_start',
  SCREEN_STOP: 'screen_stop',
  SCREEN_CONFIG: 'screen_config',
  SCREEN_DISPLAYS: 'screen_displays',
  DISPLAYS_INFO: 'displays_info',

  AUDIO_START: 'audio_start',
  AUDIO_STOP: 'audio_stop',
  PRIVACY_SET: 'privacy_set',

  INPUT_MOUSE: 'input_mouse',
  INPUT_KEY: 'input_key',
  INPUT_TEXT: 'input_text',
  INPUT_HOTKEY: 'input_hotkey',

  CLIPBOARD_GET: 'clipboard_get',
  CLIPBOARD_SET: 'clipboard_set',
  CLIPBOARD_DATA: 'clipboard_data',
  CLIPBOARD_WATCH: 'clipboard_watch',

  PTY_OPEN: 'pty_open',
  PTY_OPENED: 'pty_opened',
  PTY_INPUT: 'pty_input',
  PTY_RESIZE: 'pty_resize',
  PTY_CLOSE: 'pty_close',
  PTY_EXIT: 'pty_exit',

  FS_ROOTS: 'fs_roots',
  FS_LIST: 'fs_list',
  FS_MKDIR: 'fs_mkdir',
  FS_RENAME: 'fs_rename',
  FS_DELETE: 'fs_delete',
  FS_READ_TEXT: 'fs_read_text',
  FS_WRITE_TEXT: 'fs_write_text',
  FS_DOWNLOAD: 'fs_download',
  FS_ZIP_DOWNLOAD: 'fs_zip_download',
  FS_UPLOAD_START: 'fs_upload_start',
  FS_UPLOAD_END: 'fs_upload_end',
  FS_RESULT: 'fs_result',
  FS_ERROR: 'fs_error',

  PHONE_LIST: 'phone_list',
  PHONE_CONNECT: 'phone_connect',
  PHONE_FRAME: 'phone_frame',
  PHONE_INPUT: 'phone_input',
  PHONE_RESULT: 'phone_result',
  PHONE_STREAM_START: 'phone_stream_start',
  PHONE_STREAM_STOP: 'phone_stream_stop',

  PING: 'ping',
  PONG: 'pong',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBinaryEnvelope(kind, meta = {}, payload = new Uint8Array(0), flags = 0) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(4 + metaBytes.byteLength + body.byteLength);
  const view = new DataView(out.buffer);
  out[0] = kind & 0xff;
  out[1] = flags & 0xff;
  view.setUint16(2, metaBytes.byteLength, false);
  out.set(metaBytes, 4);
  out.set(body, 4 + metaBytes.byteLength);
  return out;
}

export function decodeBinaryEnvelope(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = buf[0];
  const flags = buf[1];
  const metaLen = view.getUint16(2, false);
  const metaJson = metaLen > 0 ? decoder.decode(buf.subarray(4, 4 + metaLen)) : '{}';
  return {
    kind,
    flags,
    meta: JSON.parse(metaJson),
    payload: buf.subarray(4 + metaLen),
  };
}

// Pure-JS SHA-256 & HMAC-SHA256 so Challenge-Response works even on non-HTTPS LAN HTTP origins
// where window.crypto.subtle is unavailable in mobile browsers.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Bytes(dataBytes) {
  const bytes = dataBytes instanceof Uint8Array ? dataBytes : encoder.encode(String(dataBytes));
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 9 + 63) & ~63);
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padLen - 4, bitLen >>> 0, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(off + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false);
  return out;
}

export function hmacSha256Hex(keyStr, msgStr) {
  let keyBytes = encoder.encode(String(keyStr));
  if (keyBytes.length > 64) keyBytes = sha256Bytes(keyBytes);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  ipad.fill(0x36);
  opad.fill(0x5c);
  for (let i = 0; i < keyBytes.length; i++) {
    ipad[i] ^= keyBytes[i];
    opad[i] ^= keyBytes[i];
  }
  const msgBytes = encoder.encode(String(msgStr));
  const inner = new Uint8Array(64 + msgBytes.length);
  inner.set(ipad, 0);
  inner.set(msgBytes, 64);
  const innerHash = sha256Bytes(inner);

  const outer = new Uint8Array(64 + 32);
  outer.set(opad, 0);
  outer.set(innerHash, 64);
  const finalHash = sha256Bytes(outer);
  return Array.from(finalHash, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function computeChallengeProof(secret, nonce, deviceId) {
  return hmacSha256Hex(secret, `${deviceId}:${nonce}`);
}
