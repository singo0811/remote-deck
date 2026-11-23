import { util } from '@kit.ArkTS';

export class FrameKind {
  static readonly SCREEN: number = 1;
  static readonly PTY_OUT: number = 2;
  static readonly FILE_DOWN: number = 3;
  static readonly FILE_UP: number = 4;
  static readonly AUDIO: number = 5;
  static readonly VIDEO: number = 6;
}

export class MsgType {
  static readonly AUTH_CHALLENGE: string = 'auth_challenge';
  static readonly AUTH_RESPONSE: string = 'auth_response';
  static readonly AUTH_PENDING: string = 'auth_pending';
  static readonly AUTH_OK: string = 'auth_ok';
  static readonly AUTH_ERROR: string = 'auth_error';

  static readonly CONTROLLER_CONNECT: string = 'controller_connect';
  static readonly ROUTE_CANDIDATES: string = 'route_candidates';
  static readonly RELAY_READY: string = 'relay_ready';
  static readonly PEER_LEFT: string = 'peer_left';
  static readonly ERROR: string = 'error';

  static readonly SCREEN_START: string = 'screen_start';
  static readonly SCREEN_STOP: string = 'screen_stop';
  static readonly SCREEN_CONFIG: string = 'screen_config';
  static readonly DISPLAYS_INFO: string = 'displays_info';

  static readonly AUDIO_START: string = 'audio_start';
  static readonly AUDIO_STOP: string = 'audio_stop';
  static readonly PRIVACY_SET: string = 'privacy_set';

  static readonly INPUT_MOUSE: string = 'input_mouse';
  static readonly INPUT_KEY: string = 'input_key';
  static readonly INPUT_TEXT: string = 'input_text';
  static readonly INPUT_HOTKEY: string = 'input_hotkey';

  static readonly CLIPBOARD_GET: string = 'clipboard_get';
  static readonly CLIPBOARD_SET: string = 'clipboard_set';
  static readonly CLIPBOARD_DATA: string = 'clipboard_data';
  static readonly CLIPBOARD_WATCH: string = 'clipboard_watch';

  static readonly PTY_OPEN: string = 'pty_open';
  static readonly PTY_OPENED: string = 'pty_opened';
  static readonly PTY_INPUT: string = 'pty_input';
  static readonly PTY_RESIZE: string = 'pty_resize';
  static readonly PTY_CLOSE: string = 'pty_close';
  static readonly PTY_EXIT: string = 'pty_exit';

  static readonly FS_ROOTS: string = 'fs_roots';
  static readonly FS_LIST: string = 'fs_list';
  static readonly FS_MKDIR: string = 'fs_mkdir';
  static readonly FS_RENAME: string = 'fs_rename';
  static readonly FS_DELETE: string = 'fs_delete';
  static readonly FS_READ_TEXT: string = 'fs_read_text';
  static readonly FS_WRITE_TEXT: string = 'fs_write_text';
  static readonly FS_DOWNLOAD: string = 'fs_download';
  static readonly FS_ZIP_DOWNLOAD: string = 'fs_zip_download';
  static readonly FS_UPLOAD_START: string = 'fs_upload_start';
  static readonly FS_UPLOAD_END: string = 'fs_upload_end';
  static readonly FS_RESULT: string = 'fs_result';
  static readonly FS_ERROR: string = 'fs_error';

  static readonly PING: string = 'ping';
  static readonly PONG: string = 'pong';
}

export interface DisplayInfo {
  id: number;
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface PermissionsInfo {
  view: boolean;
  control: boolean;
  terminal: boolean;
  files: boolean;
  audio?: boolean;
}

export interface LanEndpoint {
  iface: string;
  ip: string;
  kind: string;
  wsUrl: string;
  httpUrl: string;
}

export interface RemoteDeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  online: boolean;
  displays: DisplayInfo[];
  lanEndpoints: LanEndpoint[];
  tunnelUrl: string;
}

export interface AuthOkInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  channel: string;
  displays: DisplayInfo[];
  permissions: PermissionsInfo;
  lanEndpoints?: LanEndpoint[];
  tunnelUrl?: string;
}

export interface TelemetryInfo {
  rttMs: number;
  fps: number;
  kbps: number;
  channel: string;
}

export interface FileRoot {
  name: string;
  path: string;
}

export interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface DecodedEnvelope {
  kind: number;
  flags: number;
  meta: Record<string, Object>;
  payload: Uint8Array;
}

export interface QualityPreset {
  key: string;
  label: string;
  fps: number;
  scale: number;
  quality: number;
}

export interface QuickHotkey {
  id: string;
  label: string;
  vk: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ParsedConnectUrl {
  mode: string;
  serverUrl: string;
  deviceId: string;
  pin: string;
}

export interface RecentDeviceItem {
  mode: string;
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  pin?: string;
  tunnelUrl?: string;
  lanEndpoints?: LanEndpoint[];
  updatedAt: number;
}

export interface OutMsgFsZip {
  type: string;
  reqId: string;
  transferId: string;
  paths: string[];
}

export interface RoiRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutMsgRoi {
  type: string;
  roi: RoiRect;
}

export interface OutMsgRoiClear {
  type: string;
  roi: null;
}

export interface OutMsgAllowDirty {
  type: string;
  allowDirty: boolean;
}

export interface ScreenFrameMeta {
  echoX: number;
  echoY: number;
  width: number;
  height: number;
  dirtyX: number;
  dirtyY: number;
  dirtyW: number;
  dirtyH: number;
  hasDirty: boolean;
}

export interface CursorShapeInfo {
  id: number;
  w: number;
  h: number;
  hx: number;
  hy: number;
  png: string;
}

export interface PhoneShareStatus {
  running: boolean;
  capturing: boolean;
  state: string;
  port: number;
  width: number;
  height: number;
  fps: number;
  clients: number;
  frames: number;
  bytesSent: number;
  lastError: string;
}

export function emptyPhoneShareStatus(): PhoneShareStatus {
  return {
    running: false,
    capturing: false,
    state: 'idle',
    port: 9603,
    width: 0,
    height: 0,
    fps: 30,
    clients: 0,
    frames: 0,
    bytesSent: 0,
    lastError: '',
  };
}

export function parsePhoneShareStatus(raw: string): PhoneShareStatus {
  const obj = parseJsonObject(raw);
  if (!obj) return emptyPhoneShareStatus();
  return {
    running: jsonBool(obj, 'running', false),
    capturing: jsonBool(obj, 'capturing', false),
    state: jsonStr(obj, 'state', 'idle'),
    port: jsonNum(obj, 'port', 9603),
    width: jsonNum(obj, 'width', 0),
    height: jsonNum(obj, 'height', 0),
    fps: jsonNum(obj, 'fps', 30),
    clients: jsonNum(obj, 'clients', 0),
    frames: jsonNum(obj, 'frames', 0),
    bytesSent: jsonNum(obj, 'bytesSent', 0),
    lastError: jsonStr(obj, 'lastError', ''),
  };
}

export interface VideoFrameMeta {
  width: number;
  height: number;
  key: boolean;
  ts: number;
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
}

export interface OutMsgForceKey {
  type: string;
  forceKey: boolean;
}

export interface OutMsgCodec {
  type: string;
  codec: string;
}

export interface OutMsgHiRes {
  type: string;
  hiRes: boolean;
}

export interface OutMsgClipboardWatch {
  type: string;
  enabled: boolean;
}

export interface OutMsgAuthResp {
  type: string;
  proof: string;
}

export interface OutMsgControllerConnect {
  type: string;
  deviceId: string;
}

export interface OutMsgPing {
  type: string;
  ts: number;
  rttMs?: number;
}

export interface OutMsgScreen {
  type: string;
  displayId: number;
  fps: number;
  scale: number;
  quality: number;
  auto?: boolean;
  allowDirty?: boolean;
  maxWidth?: number;
  singleFrame?: boolean;
  separateCursor?: boolean;
  codec?: string;
}

export interface OutMsgPrivacy {
  type: string;
  enabled: boolean;
}

export interface OutMsgMouse {
  type: string;
  action: string;
  x: number;
  y: number;
  button: string;
  delta: number;
}

export interface OutMsgWheel {
  type: string;
  action: string;
  delta: number;
}

export interface OutMsgHotkey {
  type: string;
  vk: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface OutMsgKey {
  type: string;
  action: string;
  vk: number;
}

export interface OutMsgText {
  type: string;
  text: string;
}

export interface OutMsgPtyOpen {
  type: string;
  id: string;
  shell: string;
  cols: number;
  rows: number;
}

export interface OutMsgPtyInput {
  type: string;
  id: string;
  data: string;
}

export interface OutMsgPtyClose {
  type: string;
  id: string;
}

export interface OutMsgFsReq {
  type: string;
  reqId: string;
  path?: string;
}

export interface OutMsgFsRename {
  type: string;
  reqId: string;
  oldPath: string;
  newPath: string;
}

export interface OutMsgFsWrite {
  type: string;
  reqId: string;
  path: string;
  content: string;
}

export interface OutMsgFsDownload {
  type: string;
  reqId: string;
  transferId: string;
  path: string;
}

export interface OutMsgFsUploadStart {
  type: string;
  reqId: string;
  transferId: string;
  dirPath: string;
  fileName: string;
  total: number;
}

export interface OutMsgFsUploadEnd {
  type: string;
  reqId: string;
  transferId: string;
}

export interface OutMetaFileUp {
  transferId: string;
  done: boolean;
}

export interface OutMsgClipboardSet {
  type: string;
  text: string;
}

export interface OutMsgSimple {
  type: string;
}

export interface OutMsgAudioStart {
  type: string;
  codec?: string;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  try {
    const helper = new util.Base64Helper();
    return helper.decodeSync(b64);
  } catch {
    return new Uint8Array(0);
  }
}

export const QUALITY_PRESETS: QualityPreset[] = [
  { key: 'auto', label: '智能', fps: 30, scale: 0.72, quality: 74 },
  { key: 'eco', label: '流畅', fps: 24, scale: 0.5, quality: 62 },
  { key: 'balanced', label: '均衡', fps: 28, scale: 0.72, quality: 76 },
  { key: 'hd', label: '高清', fps: 30, scale: 0.88, quality: 84 },
  { key: 'uhd', label: '超清', fps: 24, scale: 1.0, quality: 92 },
];

export const QUICK_HOTKEYS: QuickHotkey[] = [
  { id: 'esc', label: 'Esc', vk: 0x1b, ctrl: false, alt: false, shift: false, meta: false },
  { id: 'tab', label: 'Tab', vk: 0x09, ctrl: false, alt: false, shift: false, meta: false },
  { id: 'enter', label: 'Enter', vk: 0x0d, ctrl: false, alt: false, shift: false, meta: false },
  { id: 'backspace', label: '退格', vk: 0x08, ctrl: false, alt: false, shift: false, meta: false },
  { id: 'copy', label: 'Ctrl+C', vk: 67, ctrl: true, alt: false, shift: false, meta: false },
  { id: 'paste', label: 'Ctrl+V', vk: 86, ctrl: true, alt: false, shift: false, meta: false },
  { id: 'undo', label: 'Ctrl+Z', vk: 90, ctrl: true, alt: false, shift: false, meta: false },
  { id: 'selectall', label: 'Ctrl+A', vk: 65, ctrl: true, alt: false, shift: false, meta: false },
  { id: 'alttab', label: 'Alt+Tab', vk: 0x09, ctrl: false, alt: true, shift: false, meta: false },
  { id: 'win', label: 'Win', vk: 0x5b, ctrl: false, alt: false, shift: false, meta: false },
  { id: 'desktop', label: 'Win+D', vk: 68, ctrl: false, alt: false, shift: false, meta: true },
  { id: 'taskmgr', label: '任务管理', vk: 0x1b, ctrl: true, alt: false, shift: true, meta: false },
];

const textEncoder = util.TextEncoder.create('utf-8');
const textDecoder = util.TextDecoder.create('utf-8');

export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encodeInto(text);
}

export function utf8Decode(bytes: Uint8Array, stream: boolean = false): string {
  return textDecoder.decodeToString(bytes, { stream });
}

export function jsonAsObject(raw: Object | undefined | null): Record<string, Object> | null {
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    return raw as Record<string, Object>;
  }
  return null;
}

export function parseJsonObject(text: string): Record<string, Object> | null {
  try {
    const parsed: Object = JSON.parse(text) as Object;
    return jsonAsObject(parsed);
  } catch {
    return null;
  }
}

export function jsonStr(obj: Record<string, Object> | null, key: string, fallback: string = ''): string {
  if (!obj) return fallback;
  const v: Object | undefined = obj[key];
  return typeof v === 'string' ? v : fallback;
}

export function jsonNum(obj: Record<string, Object> | null, key: string, fallback: number = 0): number {
  if (!obj) return fallback;
  const v: Object | undefined = obj[key];
  return typeof v === 'number' ? v : fallback;
}

export function jsonBool(obj: Record<string, Object> | null, key: string, fallback: boolean = false): boolean {
  if (!obj) return fallback;
  const v: Object | undefined = obj[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function jsonArr(obj: Record<string, Object> | null, key: string): Object[] {
  if (!obj) return [];
  const v: Object | undefined = obj[key];
  return Array.isArray(v) ? (v as Object[]) : [];
}

export function encodeBinaryEnvelope(kind: number, metaJson: string, payload: Uint8Array, flags: number = 0): ArrayBuffer {
  const metaBytes: Uint8Array = utf8Encode(metaJson);
  const out = new Uint8Array(4 + metaBytes.byteLength + payload.byteLength);
  const view = new DataView(out.buffer);
  out[0] = kind & 0xff;
  out[1] = flags & 0xff;
  view.setUint16(2, metaBytes.byteLength, false);
  out.set(metaBytes, 4);
  out.set(payload, 4 + metaBytes.byteLength);
  return out.buffer;
}

export function decodeBinaryEnvelope(input: ArrayBuffer): DecodedEnvelope | null {
  if (input.byteLength < 4) return null;
  const buf = new Uint8Array(input);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = buf[0];
  const flags = buf[1];
  const metaLen = view.getUint16(2, false);
  if (4 + metaLen > buf.byteLength) return null;
  const metaSlice = buf.subarray(4, 4 + metaLen);
  const metaStr = metaLen > 0 ? utf8Decode(metaSlice) : '{}';
  const metaObj = parseJsonObject(metaStr);
  if (!metaObj) return null;
  const payload = buf.subarray(4 + metaLen);
  return {
    kind,
    flags,
    meta: metaObj,
    payload,
  };
}

const SHA_K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
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

    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
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
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, H[i], false);
  }
  return out;
}

export function hmacSha256Hex(keyStr: string, msgStr: string): string {
  let keyBytes: Uint8Array = utf8Encode(keyStr);
  if (keyBytes.length > 64) {
    keyBytes = sha256Bytes(keyBytes);
  }
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  ipad.fill(0x36);
  opad.fill(0x5c);
  for (let i = 0; i < keyBytes.length; i++) {
    ipad[i] ^= keyBytes[i];
    opad[i] ^= keyBytes[i];
  }
  const msgBytes: Uint8Array = utf8Encode(msgStr);
  const inner = new Uint8Array(64 + msgBytes.length);
  inner.set(ipad, 0);
  inner.set(msgBytes, 64);
  const innerHash = sha256Bytes(inner);

  const outer = new Uint8Array(64 + 32);
  outer.set(opad, 0);
  outer.set(innerHash, 64);
  const finalHash = sha256Bytes(outer);
  let hex = '';
  for (let i = 0; i < finalHash.length; i++) {
    const part = finalHash[i].toString(16);
    hex += part.length === 1 ? `0${part}` : part;
  }
  return hex;
}

export function computeChallengeProof(secret: string, nonce: string, deviceId: string): string {
  return hmacSha256Hex(secret, `${deviceId}:${nonce}`);
}

export function toWsUrl(inputUrl: string): string {
  let raw = inputUrl.trim();
  if (!raw) return '';
  while (raw.endsWith('/')) {
    raw = raw.slice(0, raw.length - 1);
  }
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
    return raw.endsWith('/ws') ? raw : `${raw}/ws`;
  }
  let base = raw;
  if (base.startsWith('https://')) {
    base = `wss://${base.slice(8)}`;
  } else if (base.startsWith('http://')) {
    base = `ws://${base.slice(7)}`;
  } else {
    base = `ws://${base}`;
  }
  const qIdx = base.indexOf('?');
  if (qIdx >= 0) {
    base = base.slice(0, qIdx);
  }
  const slashIdx = base.indexOf('/', 6);
  if (slashIdx >= 0) {
    base = base.slice(0, slashIdx);
  }
  return `${base}/ws`;
}

export function toHttpBase(inputUrl: string): string {
  let raw = inputUrl.trim();
  if (!raw) return '';
  if (raw.startsWith('wss://')) {
    raw = `https://${raw.slice(6)}`;
  } else if (raw.startsWith('ws://')) {
    raw = `http://${raw.slice(5)}`;
  } else if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = `http://${raw}`;
  }
  const qIdx = raw.indexOf('?');
  if (qIdx >= 0) {
    raw = raw.slice(0, qIdx);
  }
  if (raw.endsWith('/ws')) {
    raw = raw.slice(0, raw.length - 3);
  }
  while (raw.endsWith('/')) {
    raw = raw.slice(0, raw.length - 1);
  }
  return raw;
}

export function parseConnectUrl(rawInput: string): ParsedConnectUrl | null {
  const raw = rawInput.trim();
  if (!raw) return null;
  const qIdx = raw.indexOf('?');
  const basePart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const queryPart = qIdx >= 0 ? raw.slice(qIdx + 1) : '';
  let mode = '';
  let id = '';
  let pin = '';
  if (queryPart.length > 0) {
    const pairs = queryPart.split('&');
    for (let i = 0; i < pairs.length; i++) {
      const eq = pairs[i].indexOf('=');
      if (eq < 0) continue;
      const k = pairs[i].slice(0, eq);
      const v = decodeURIComponent(pairs[i].slice(eq + 1));
      if (k === 'mode') mode = v;
      if (k === 'id') id = v;
      if (k === 'pin') pin = v;
    }
  }
  const httpBase = toHttpBase(basePart);
  if (!httpBase) return null;
  const resolvedMode = mode === 'direct' ? 'direct' : mode === 'relay' ? 'relay' : (id.length > 0 ? 'relay' : 'direct');
  return {
    mode: resolvedMode,
    serverUrl: httpBase,
    deviceId: id.toUpperCase(),
    pin: pin.toUpperCase(),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return idx === 0 ? `${val} B` : `${val.toFixed(1)} ${units[idx]}`;
}
