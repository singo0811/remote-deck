/**
 * Wire protocol constants and cross-runtime binary envelope codec.
 * Works identically in Node.js (Buffer/Uint8Array) and Browser (ArrayBuffer/Uint8Array).
 */

export const PROTOCOL_VERSION = 1;

export const FRAME_KIND = Object.freeze({
  SCREEN: 1,
  PTY_OUT: 2,
  FILE_DOWN: 3,
  FILE_UP: 4,
  AUDIO: 5,
  VIDEO: 6,
  PHONE_VIDEO: 7,
  PHONE_AUDIO: 8,
});

export const MSG = Object.freeze({
  // Auth
  AUTH_CHALLENGE: 'auth_challenge',
  AUTH_RESPONSE: 'auth_response',
  AUTH_PENDING: 'auth_pending',
  AUTH_OK: 'auth_ok',
  AUTH_ERROR: 'auth_error',

  // Relay & Signaling
  AGENT_REGISTER: 'agent_register',
  AGENT_REGISTERED: 'agent_registered',
  AGENT_HEARTBEAT: 'agent_heartbeat',
  CONTROLLER_CONNECT: 'controller_connect',
  ROUTE_CANDIDATES: 'route_candidates',
  RTC_OFFER: 'rtc_offer',
  RTC_ANSWER: 'rtc_answer',
  RTC_ICE: 'rtc_ice',
  RELAY_READY: 'relay_ready',
  PEER_LEFT: 'peer_left',
  DEVICE_LIST: 'device_list',
  ERROR: 'error',

  // Screen & Displays
  SCREEN_START: 'screen_start',
  SCREEN_STOP: 'screen_stop',
  SCREEN_CONFIG: 'screen_config',
  SCREEN_DISPLAYS: 'screen_displays',
  DISPLAYS_INFO: 'displays_info',

  // Audio & Privacy
  AUDIO_START: 'audio_start',
  AUDIO_STOP: 'audio_stop',
  PRIVACY_SET: 'privacy_set',

  // Input Injection
  INPUT_MOUSE: 'input_mouse',
  INPUT_KEY: 'input_key',
  INPUT_TEXT: 'input_text',
  INPUT_HOTKEY: 'input_hotkey',

  // Clipboard
  CLIPBOARD_GET: 'clipboard_get',
  CLIPBOARD_SET: 'clipboard_set',
  CLIPBOARD_DATA: 'clipboard_data',
  CLIPBOARD_WATCH: 'clipboard_watch',

  // Terminal (PTY)
  PTY_OPEN: 'pty_open',
  PTY_OPENED: 'pty_opened',
  PTY_INPUT: 'pty_input',
  PTY_RESIZE: 'pty_resize',
  PTY_CLOSE: 'pty_close',
  PTY_EXIT: 'pty_exit',

  // File Manager
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

  // Phone Mirroring (remote proxy)
  PHONE_LIST: 'phone_list',
  PHONE_CONNECT: 'phone_connect',
  PHONE_FRAME: 'phone_frame',
  PHONE_INPUT: 'phone_input',
  PHONE_RESULT: 'phone_result',
  PHONE_STREAM_START: 'phone_stream_start',
  PHONE_STREAM_STOP: 'phone_stream_stop',

  // Latency Probe
  PING: 'ping',
  PONG: 'pong',
});

export const PERMISSIONS = Object.freeze({
  VIEW: 'view',
  CONTROL: 'control',
  TERMINAL: 'terminal',
  FILES: 'files',
  AUDIO: 'audio',
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(0);
}

/**
 * Encode a binary message envelope:
 * [1B kind][1B flags][2B metaLen (BE)][meta JSON UTF-8][payload bytes]
 */
export function encodeBinaryEnvelope(kind, meta = {}, payload = new Uint8Array(0), flags = 0) {
  const metaBytes = textEncoder.encode(JSON.stringify(meta));
  if (metaBytes.byteLength > 65535) {
    throw new Error(`Binary envelope metadata too large: ${metaBytes.byteLength}`);
  }
  const body = toUint8Array(payload);
  const out = new Uint8Array(4 + metaBytes.byteLength + body.byteLength);
  const view = new DataView(out.buffer);
  out[0] = kind & 0xff;
  out[1] = flags & 0xff;
  view.setUint16(2, metaBytes.byteLength, false);
  out.set(metaBytes, 4);
  out.set(body, 4 + metaBytes.byteLength);
  return out;
}

/**
 * Decode a binary message envelope into { kind, flags, meta, payload }.
 */
export function decodeBinaryEnvelope(input) {
  const buf = toUint8Array(input);
  if (buf.byteLength < 4) {
    throw new Error(`Invalid binary envelope length: ${buf.byteLength}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = buf[0];
  const flags = buf[1];
  const metaLen = view.getUint16(2, false);
  if (4 + metaLen > buf.byteLength) {
    throw new Error(`Corrupt binary envelope: metaLen=${metaLen}, total=${buf.byteLength}`);
  }
  const metaJson = metaLen > 0 ? textDecoder.decode(buf.subarray(4, 4 + metaLen)) : '{}';
  const meta = JSON.parse(metaJson);
  const payload = buf.subarray(4 + metaLen);
  return { kind, flags, meta, payload };
}
