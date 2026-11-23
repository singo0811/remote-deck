import { connection, http, socket, webSocket } from '@kit.NetworkKit';
import { image } from '@kit.ImageKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  AuthOkInfo,
  DisplayInfo,
  FileItem,
  FileRoot,
  FrameKind,
  LanEndpoint,
  MsgType,
  OutMsgAuthResp,
  OutMsgClipboardWatch,
  OutMsgControllerConnect,
  OutMsgFsDownload,
  OutMsgFsRename,
  OutMsgFsReq,
  OutMsgFsWrite,
  OutMsgFsZip,
  OutMsgHiRes,
  OutMsgHotkey,
  OutMsgKey,
  OutMsgMouse,
  OutMsgPing,
  OutMsgPrivacy,
  OutMsgPtyClose,
  OutMsgPtyInput,
  OutMsgPtyOpen,
  OutMsgScreen,
  OutMsgSimple,
  OutMsgText,
  OutMsgWheel,
  PermissionsInfo,
  QUALITY_PRESETS,
  QualityPreset,
  RemoteDeviceInfo,
  TelemetryInfo,
  computeChallengeProof,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  jsonArr,
  jsonAsObject,
  jsonBool,
  jsonNum,
  jsonStr,
  parseJsonObject,
  toHttpBase,
  toWsUrl,
  utf8Decode,
  CursorShapeInfo,
  ScreenFrameMeta,
  VideoFrameMeta,
  OutMsgAllowDirty,
  OutMsgAudioStart,
  OutMsgCodec,
  OutMsgForceKey,
  OutMsgRoi,
  OutMsgRoiClear,
  base64ToBytes,
} from './Protocol';
import { TsnetClient } from './TsnetClient';
import { decodeImaAdpcmToPcmBytes } from './AudioPlayer';

export interface ClientCallbacks {
  onLog: (line: string) => void;
  onStatus: (status: string, detail: string) => void;
  onAuthenticated: (auth: AuthOkInfo) => void;
  onTelemetry: (stats: TelemetryInfo) => void;
  onScreenPixelMap: (
    pixelMap: image.PixelMap,
    cursorX: number,
    cursorY: number,
    aspect: number,
    meta: ScreenFrameMeta
  ) => void;
  onVideoModeChange?: (active: boolean, aspect: number) => void;
  onVideoGeometry?: (cursorX: number, cursorY: number, aspect: number) => void;
  onCursorShape?: (shape: CursorShapeInfo) => void;
  onAudioFrame: (sampleRate: number, channels: number, pcm: Uint8Array) => void;
  onPtyOpened: (id: string, mode: string) => void;
  onPtyOutput: (id: string, text: string) => void;
  onPtyExit: (id: string, code: number) => void;
  onClipboardData: (text: string, imageBase64: string, auto: boolean) => void;
  onFsRoots: (roots: FileRoot[]) => void;
  onFsList: (dirPath: string, parentPath: string, items: FileItem[]) => void;
  onFsReadText: (filePath: string, content: string, truncated: boolean) => void;
  onFsActionDone: (op: string, infoPath: string) => void;
  onFsDownloadReady: (fileName: string, bytes: Uint8Array) => void;
  onFsError: (errorMsg: string) => void;
}

interface DownloadBuffer {
  fileName: string;
  chunks: Uint8Array[];
  totalBytes: number;
}

interface PendingScreenFrame {
  jpegBuf: ArrayBuffer;
  cx: number;
  cy: number;
  aspect: number;
  meta: ScreenFrameMeta;
}

interface WsAuthResult {
  ws: webSocket.WebSocket;
  kind: string;
  info: AuthOkInfo;
}

interface LocalSubnetInfo {
  ip: string;
  prefix24: string;
  selfHost: number;
  broadcastIp: string;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function buildSubnetInfo(ip: string, prefixLen: number): LocalSubnetInfo | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const c = Number(parts[2]);
  const d = Number(parts[3]);
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
    return null;
  }
  const bits = prefixLen >= 8 && prefixLen <= 30 ? prefixLen : 24;
  const ipNum = (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  const mask = bits === 32 ? 0xFFFFFFFF : ((0xFFFFFFFF << (32 - bits)) >>> 0);
  const bcastNum = (ipNum | (~mask >>> 0)) >>> 0;
  const broadcastIp = `${(bcastNum >>> 24) & 255}.${(bcastNum >>> 16) & 255}.${(bcastNum >>> 8) & 255}.${bcastNum & 255}`;
  return {
    ip,
    prefix24: `${a}.${b}.${c}`,
    selfHost: d,
    broadcastIp,
  };
}

function parseDisplays(arr: Object[]): DisplayInfo[] {
  const out: DisplayInfo[] = [];
  for (let i = 0; i < arr.length; i++) {
    const d = jsonAsObject(arr[i]);
    if (!d) continue;
    out.push({
      id: jsonNum(d, 'id', i),
      name: jsonStr(d, 'name', `Display ${i + 1}`),
      left: jsonNum(d, 'left', 0),
      top: jsonNum(d, 'top', 0),
      width: jsonNum(d, 'width', 1280),
      height: jsonNum(d, 'height', 720),
      primary: jsonBool(d, 'primary', i === 0),
    });
  }
  return out;
}

function isVirtualEndpoint(iface: string, ip: string): boolean {
  const lower = iface.toLowerCase();
  if (
    lower.includes('vethernet') ||
    lower.includes('hyper-v') ||
    lower.includes('wsl') ||
    lower.includes('docker') ||
    lower.includes('vmware') ||
    lower.includes('vmnet') ||
    lower.includes('vbox') ||
    lower.includes('virtual') ||
    lower.includes('meta') ||
    lower.includes('clash') ||
    lower.includes('mihomo') ||
    lower.includes('utun') ||
    lower.includes('loopback') ||
    lower.startsWith('tun') ||
    lower.startsWith('tap') ||
    lower.startsWith('wg')
  ) {
    return true;
  }
  return ip.startsWith('198.18.') || ip.startsWith('198.19.');
}

function endpointScore(ep: LanEndpoint): number {
  const kindScore = ep.kind === 'lan' ? 0 : ep.kind === 'tailscale' ? 10 : 20;
  const virtScore = isVirtualEndpoint(ep.iface, ep.ip) ? 5 : 0;
  return kindScore + virtScore;
}

function parseLanEndpoints(arr: Object[]): LanEndpoint[] {
  const out: LanEndpoint[] = [];
  for (let i = 0; i < arr.length; i++) {
    const ep = jsonAsObject(arr[i]);
    if (!ep) continue;
    const wsUrl = jsonStr(ep, 'wsUrl');
    if (!wsUrl) continue;
    out.push({
      iface: jsonStr(ep, 'iface'),
      ip: jsonStr(ep, 'ip'),
      kind: jsonStr(ep, 'kind', 'lan'),
      wsUrl,
      httpUrl: jsonStr(ep, 'httpUrl'),
    });
  }
  out.sort((a, b) => endpointScore(a) - endpointScore(b));
  return out;
}

function parsePermissions(obj: Record<string, Object> | null): PermissionsInfo {
  return {
    view: jsonBool(obj, 'view', true),
    control: jsonBool(obj, 'control', true),
    terminal: jsonBool(obj, 'terminal', true),
    files: jsonBool(obj, 'files', true),
    audio: jsonBool(obj, 'audio', true),
  };
}

export class RemoteClient {
  private callbacks: ClientCallbacks;
  private activeWs: webSocket.WebSocket | null = null;
  private signalingWs: webSocket.WebSocket | null = null;
  private channelKind: string = '';
  private closed: boolean = false;
  private wasAuthenticated: boolean = false;
  private reconnectAttempt: number = 0;
  private reconnectTimer: number = -1;
  private lastMode: string = 'direct';
  private lastServerUrl: string = '';
  private lastDeviceId: string = '';
  private lastPin: string = '';
  private lastExtraEndpoints: LanEndpoint[] = [];
  private lastFallbackUrl: string = '';
  private pingTimer: number = -1;
  private statsTimer: number = -1;
  private lastPingSentMs: number = 0;
  private rttMs: number = 0;
  private bytesInWindow: number = 0;
  private framesInWindow: number = 0;
  private decodingFrame: boolean = false;
  private pendingFrames: PendingScreenFrame[] = [];
  private directFrameListener: ((pm: image.PixelMap, meta: ScreenFrameMeta) => void) | null = null;
  private videoFrameListener: ((data: ArrayBuffer, meta: VideoFrameMeta) => void) | null = null;
  private codecMode: string = 'h264';
  private videoModeActive: boolean = false;
  private hasEmittedFirstFrame: boolean = false;
  private lastEmittedAspect: number = 0;
  private lastCursorShapeId: number = -1;
  private lastCursorX: number = -1;
  private lastCursorY: number = -1;
  private pinnedPixelMap: image.PixelMap | null = null;

  setDirectFrameListener(listener: ((pm: image.PixelMap, meta: ScreenFrameMeta) => void) | null): void {
    this.directFrameListener = listener;
  }

  setVideoFrameListener(listener: ((data: ArrayBuffer, meta: VideoFrameMeta) => void) | null): void {
    this.videoFrameListener = listener;
  }

  setCodec(codec: string): void {
    const target = codec === 'jpeg' ? 'jpeg' : 'h264';
    if (target === 'jpeg') {
      this.codecMode = 'jpeg';
      if (this.videoModeActive) {
        this.videoModeActive = false;
        this.callbacks.onVideoModeChange?.(false, 0);
      }
    } else {
      this.codecMode = 'h264';
    }
    const msg: OutMsgCodec = { type: MsgType.SCREEN_CONFIG, codec: this.codecMode };
    this.sendJson(msg);
  }

  private presetMaxWidth(preset: QualityPreset): number {
    if (preset.key === 'eco') return 1280;
    if (preset.key === 'auto' || preset.key === 'balanced') return 1440;
    if (preset.key === 'hd') return 1600;
    return 0;
  }
  private lastResyncAt: number = 0;
  private currentPixelMap: image.PixelMap | null = null;
  private retiredPixelMap: image.PixelMap | null = null;
  private downloads: Map<string, DownloadBuffer> = new Map();

  constructor(callbacks: ClientCallbacks) {
    this.callbacks = callbacks;
  }

  private getLocalSubnets(): LocalSubnetInfo[] {
    const wifiOut: LocalSubnetInfo[] = [];
    const otherOut: LocalSubnetInfo[] = [];
    const seenIps: Set<string> = new Set();
    try {
      const nets = connection.getAllNetsSync();
      for (let i = 0; i < nets.length; i++) {
        try {
          const caps = connection.getNetCapabilitiesSync(nets[i]);
          const bearers = caps.bearerTypes || [];
          let isVpn = false;
          let isWifi = false;
          for (let b = 0; b < bearers.length; b++) {
            if (bearers[b] === connection.NetBearType.BEARER_VPN) {
              isVpn = true;
            } else if (bearers[b] === connection.NetBearType.BEARER_WIFI) {
              isWifi = true;
            }
          }
          if (isVpn) continue;

          const props = connection.getConnectionPropertiesSync(nets[i]);
          const addrs = props.linkAddresses;
          for (let j = 0; j < addrs.length; j++) {
            const addr = addrs[j].address?.address || '';
            if (!addr || !isPrivateIpv4(addr) || seenIps.has(addr)) continue;
            if (addr.startsWith('198.18.') || addr.startsWith('198.19.') || addr.startsWith('169.254.')) continue;
            seenIps.add(addr);
            const info = buildSubnetInfo(addr, addrs[j].prefixLength);
            if (info) {
              if (isWifi) {
                wifiOut.push(info);
              } else {
                otherOut.push(info);
              }
            }
          }
        } catch {
          // Ignore single net failure
        }
      }
    } catch {
      // Fallback to default net
      try {
        const net = connection.getDefaultNetSync();
        const props = connection.getConnectionPropertiesSync(net);
        const addrs = props.linkAddresses;
        for (let j = 0; j < addrs.length; j++) {
          const addr = addrs[j].address?.address || '';
          if (!addr || !isPrivateIpv4(addr) || seenIps.has(addr)) continue;
          if (addr.startsWith('198.18.') || addr.startsWith('198.19.') || addr.startsWith('169.254.')) continue;
          seenIps.add(addr);
          const info = buildSubnetInfo(addr, addrs[j].prefixLength);
          if (info) {
            otherOut.push(info);
          }
        }
      } catch {
        // Ignore network query error
      }
    }
    const merged: LocalSubnetInfo[] = [];
    for (let i = 0; i < wifiOut.length; i++) merged.push(wifiOut[i]);
    for (let i = 0; i < otherOut.length; i++) merged.push(otherOut[i]);
    return merged;
  }

  async probeHostInfo(serverUrl: string, timeoutMs: number = 1200): Promise<RemoteDeviceInfo | null> {
    const base = toHttpBase(serverUrl);
    if (!base) return null;
    const effectiveBase = TsnetClient.rewriteUrlThroughTunnel(base);
    const effectiveTimeout = effectiveBase !== base ? Math.max(timeoutMs, 4500) : timeoutMs;
    const req = http.createHttp();
    try {
      const resp = await req.request(`${effectiveBase}/api/info`, {
        method: http.RequestMethod.GET,
        connectTimeout: effectiveTimeout,
        readTimeout: effectiveTimeout,
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        return null;
      }
      const bodyStr = typeof resp.result === 'string' ? resp.result : '';
      const parsed = parseJsonObject(bodyStr);
      if (!parsed) return null;
      const deviceId = jsonStr(parsed, 'deviceId');
      if (!deviceId) return null;
      return {
        deviceId,
        deviceName: jsonStr(parsed, 'deviceName', deviceId),
        platform: jsonStr(parsed, 'platform', 'win32'),
        online: true,
        displays: parseDisplays(jsonArr(parsed, 'displays')),
        lanEndpoints: parseLanEndpoints(jsonArr(parsed, 'lanEndpoints')),
        tunnelUrl: jsonStr(parsed, 'tunnelUrl'),
      };
    } catch {
      return null;
    } finally {
      req.destroy();
    }
  }

  async discoverLanHosts(timeoutMs: number = 1400): Promise<RemoteDeviceInfo[]> {
    const found: RemoteDeviceInfo[] = [];
    const seenIds: Set<string> = new Set();
    const subnets = this.getLocalSubnets();

    const addDevice = (dev: RemoteDeviceInfo): void => {
      if (!dev.deviceId || seenIds.has(dev.deviceId)) return;
      seenIds.add(dev.deviceId);
      found.push(dev);
    };

    const udp = socket.constructUDPSocketInstance();
    try {
      await udp.bind({ address: '0.0.0.0', port: 0, family: 1 });
      await udp.setExtraOptions({ broadcast: true });
      udp.on('message', (msgInfo: socket.SocketMessageInfo) => {
        const text = utf8Decode(new Uint8Array(msgInfo.message));
        const obj = parseJsonObject(text);
        if (!obj) return;
        const deviceId = jsonStr(obj, 'deviceId');
        if (!deviceId) return;
        addDevice({
          deviceId,
          deviceName: jsonStr(obj, 'deviceName', deviceId),
          platform: jsonStr(obj, 'platform', 'win32'),
          online: true,
          displays: [],
          lanEndpoints: parseLanEndpoints(jsonArr(obj, 'lanEndpoints')),
          tunnelUrl: jsonStr(obj, 'tunnelUrl'),
        });
      });

      const sendDiscoveryBurst = async (): Promise<void> => {
        try {
          await udp.send({
            data: 'REMOTEDECK_DISCOVER',
            address: { address: '255.255.255.255', port: 9602, family: 1 },
          });
        } catch {
          // Ignore 255.255.255.255 error
        }
        for (let i = 0; i < subnets.length; i++) {
          const bcast = subnets[i].broadcastIp;
          if (!bcast || bcast === '255.255.255.255') continue;
          try {
            await udp.send({
              data: 'REMOTEDECK_DISCOVER',
              address: { address: bcast, port: 9602, family: 1 },
            });
          } catch {
            // Ignore directed broadcast error
          }
        }
      };

      await sendDiscoveryBurst();
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 250);
      });
      if (found.length === 0) {
        await sendDiscoveryBurst();
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), Math.max(400, Math.min(700, timeoutMs - 250)));
        });
      }
    } catch {
      // LAN broadcast may fail if Wi-Fi is off
    } finally {
      try {
        await udp.close();
      } catch {
        // Ignore close error
      }
    }

    // Fallback: if router/firewall drops UDP broadcast, probe local /24 HTTP :9601/api/info
    if (found.length === 0 && subnets.length > 0) {
      const maxSubnets = Math.min(subnets.length, 3);
      for (let s = 0; s < maxSubnets; s++) {
        const sub = subnets[s];
        const hosts: string[] = [];
        for (let h = 1; h <= 254; h++) {
          if (h === sub.selfHost) continue;
          hosts.push(`http://${sub.prefix24}.${h}:9601`);
        }
        const batchSize = 32;
        for (let offset = 0; offset < hosts.length; offset += batchSize) {
          const batch = hosts.slice(offset, offset + batchSize);
          const results = await Promise.all(batch.map((url) => this.probeHostInfo(url, 380)));
          for (let k = 0; k < results.length; k++) {
            const hit = results[k];
            if (hit) {
              addDevice(hit);
            }
          }
          if (found.length > 0) break;
        }
        if (found.length > 0) break;
      }
    }

    return found;
  }

  async discoverTsnetHosts(): Promise<RemoteDeviceInfo[]> {
    const st = TsnetClient.getStatus();
    if (!st.enabled || !st.tailscaleIp || st.peers.length === 0) {
      return [];
    }
    const candidates: string[] = [];
    for (let i = 0; i < st.peers.length; i++) {
      const p = st.peers[i];
      if (!p.ip || p.ip === st.tailscaleIp) continue;
      if (!p.online) continue;
      candidates.push(`http://${p.ip}:9601`);
    }
    if (candidates.length === 0) return [];
    const hits = await Promise.all(candidates.map((u) => this.probeHostInfo(u, 4500)));
    const found: RemoteDeviceInfo[] = [];
    for (let i = 0; i < hits.length; i++) {
      if (hits[i]) {
        found.push(hits[i] as RemoteDeviceInfo);
      }
    }
    return found;
  }

  async fetchDevices(serverUrl: string): Promise<RemoteDeviceInfo[]> {
    const base = toHttpBase(serverUrl);
    if (!base) return [];
    const effectiveBase = TsnetClient.rewriteUrlThroughTunnel(base);
    const effectiveTimeout = effectiveBase !== base ? 4500 : 2500;
    const req = http.createHttp();
    try {
      const resp = await req.request(`${effectiveBase}/api/devices`, {
        method: http.RequestMethod.GET,
        connectTimeout: effectiveTimeout,
        readTimeout: effectiveTimeout,
      });
      if (resp.responseCode >= 200 && resp.responseCode < 300) {
        const bodyStr = typeof resp.result === 'string' ? resp.result : '';
        const parsed = parseJsonObject(bodyStr);
        const rawDevices = jsonArr(parsed, 'devices');
        const out: RemoteDeviceInfo[] = [];
        for (let i = 0; i < rawDevices.length; i++) {
          const d = jsonAsObject(rawDevices[i]);
          if (!d) continue;
          const deviceId = jsonStr(d, 'deviceId');
          if (!deviceId) continue;
          out.push({
            deviceId,
            deviceName: jsonStr(d, 'deviceName', deviceId),
            platform: jsonStr(d, 'platform', 'win32'),
            online: jsonBool(d, 'online', true),
            displays: parseDisplays(jsonArr(d, 'displays')),
            lanEndpoints: parseLanEndpoints(jsonArr(d, 'lanEndpoints')),
            tunnelUrl: jsonStr(d, 'tunnelUrl'),
          });
        }
        if (out.length > 0) {
          return out;
        }
      }
    } catch {
      // Fallback to /api/info below
    } finally {
      req.destroy();
    }
    const single = await this.probeHostInfo(base, 2000);
    return single ? [single] : [];
  }

  private isAuthRejection(msg: string): boolean {
    return msg.includes('配对码') || msg.includes('PIN') || msg.includes('拒绝') || msg.includes('认证');
  }

  private async connectDirectWithFallback(
    wsUrl: string,
    pin: string,
    extraEndpoints: LanEndpoint[],
    fallbackUrl: string,
    isReconnect: boolean = false
  ): Promise<WsAuthResult> {
    const fallbackWs = fallbackUrl ? toWsUrl(fallbackUrl) : '';
    const candidates: LanEndpoint[] = [];
    const seenWs: Set<string> = new Set();
    for (let i = 0; i < extraEndpoints.length; i++) {
      const ep = extraEndpoints[i];
      if (!ep.wsUrl || seenWs.has(ep.wsUrl)) continue;
      seenWs.add(ep.wsUrl);
      candidates.push(ep);
    }
    if (wsUrl && !seenWs.has(wsUrl)) {
      const kind = wsUrl.startsWith('wss://') ? 'tunnel' : 'lan';
      candidates.unshift({
        iface: 'primary',
        ip: '',
        kind,
        wsUrl,
        httpUrl: toHttpBase(wsUrl),
      });
      seenWs.add(wsUrl);
    }

    const canFallback = fallbackWs.length > 0 && !seenWs.has(fallbackWs);
    const lanTimeout = canFallback ? 2600 : (wsUrl.startsWith('wss://') ? 12000 : 5500);

    if (candidates.length > 1) {
      if (!isReconnect) {
        this.callbacks.onStatus('connecting', '正在并发探测可达地址...');
      }
      const raceErrs: string[] = [];
      const winner = await this.raceLanCandidates(candidates, pin, lanTimeout, raceErrs);
      if (winner) {
        return winner;
      }
      const detail = raceErrs.length > 0 ? raceErrs[0] : `无法连接到 ${wsUrl}`;
      if (!canFallback || this.isAuthRejection(detail)) {
        throw new Error(detail);
      }
    } else if (candidates.length === 1) {
      const only = candidates[0];
      const kind = only.wsUrl.startsWith('wss://') ? 'tunnel' : (only.kind === 'tailscale' ? 'tailscale' : 'lan');
      const singleTimeout = only.wsUrl.startsWith('wss://') ? 12000 : lanTimeout;
      if (!isReconnect) {
        this.callbacks.onLog(`直连主机: ${only.wsUrl}`);
        this.callbacks.onStatus('connecting', kind === 'tunnel' ? '正在通过外网隧道连接...' : '正在建立直连通道并鉴权...');
      }
      try {
        return await this.openAndAuthWs(only.wsUrl, pin, kind, singleTimeout);
      } catch (err) {
        const msg = (err as Error)?.message || `无法连接到 ${only.wsUrl}`;
        if (!canFallback || this.isAuthRejection(msg)) {
          throw new Error(msg);
        }
      }
    }

    if (canFallback) {
      if (!isReconnect) {
        this.callbacks.onLog(`局域网直连未通，自动切换外网隧道: ${fallbackWs}`);
        this.callbacks.onStatus('connecting', '局域网不可达，正在切换外网隧道...');
      }
      return await this.openAndAuthWs(fallbackWs, pin, 'tunnel', 12000);
    }

    throw new Error(`无法连接到 ${wsUrl}`);
  }

  async connect(
    mode: string,
    serverUrl: string,
    deviceId: string,
    pin: string,
    extraEndpoints: LanEndpoint[] = [],
    fallbackUrl: string = ''
  ): Promise<void> {
    this.disconnect(false);
    this.closed = false;
    this.wasAuthenticated = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
    this.lastMode = mode;
    this.lastServerUrl = serverUrl;
    this.lastDeviceId = deviceId;
    this.lastPin = pin;
    this.lastExtraEndpoints = extraEndpoints;
    this.lastFallbackUrl = fallbackUrl;

    const wsUrl = toWsUrl(serverUrl);
    if (!wsUrl) {
      throw new Error('请输入有效的服务器或主机地址');
    }

    if (mode === 'direct') {
      const auth = await this.connectDirectWithFallback(wsUrl, pin, extraEndpoints, fallbackUrl, false);
      this.activateWs(auth.ws, auth.kind, auth.info);
      return;
    }

    this.callbacks.onLog(`连接中继/信令: ${wsUrl}`);
    this.callbacks.onStatus('connecting', '正在查找设备并探测最优链路...');
    await this.connectViaRelay(wsUrl, deviceId, pin);
  }

  private openAndAuthWs(
    wsUrl: string,
    pin: string,
    kind: string,
    timeoutMs: number
  ): Promise<WsAuthResult> {
    const connectWsUrl = TsnetClient.rewriteUrlThroughTunnel(wsUrl);
    const effectiveKind = connectWsUrl !== wsUrl ? 'tailscale' : kind;
    const effectiveTimeout = effectiveKind === 'tailscale' ? Math.max(timeoutMs, 10000) : timeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = webSocket.createWebSocket();
      let timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            // Ignore
          }
          reject(new Error(`连接超时 (${wsUrl})`));
        }
      }, effectiveTimeout);

      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            // Ignore
          }
          reject(err);
        }
      };

      ws.on('message', (_err: BusinessError, value: string | ArrayBuffer) => {
        if (settled || typeof value !== 'string') return;
        const msg = parseJsonObject(value);
        if (!msg) return;
        const msgType = jsonStr(msg, 'type');

        if (msgType === MsgType.AUTH_CHALLENGE) {
          const nonce = jsonStr(msg, 'nonce');
          const devId = jsonStr(msg, 'deviceId');
          const proof = computeChallengeProof(pin, nonce, devId);
          const resp: OutMsgAuthResp = { type: MsgType.AUTH_RESPONSE, proof };
          ws.send(JSON.stringify(resp));
          return;
        }

        if (msgType === MsgType.AUTH_PENDING) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              try {
                ws.close();
              } catch {
                // Ignore
              }
              reject(new Error('等待被控端确认超时'));
            }
          }, 28000);
          this.callbacks.onStatus('connecting', jsonStr(msg, 'message', '等待被控端确认允许连接...'));
          return;
        }

        if (msgType === MsgType.AUTH_OK) {
          settled = true;
          clearTimeout(timer);
          const info: AuthOkInfo = {
            deviceId: jsonStr(msg, 'deviceId'),
            deviceName: jsonStr(msg, 'deviceName'),
            platform: jsonStr(msg, 'platform', 'win32'),
            channel: effectiveKind,
            displays: parseDisplays(jsonArr(msg, 'displays')),
            permissions: parsePermissions(jsonAsObject(msg['permissions'])),
            lanEndpoints: parseLanEndpoints(jsonArr(msg, 'lanEndpoints')),
            tunnelUrl: jsonStr(msg, 'tunnelUrl'),
          };
          const authRes: WsAuthResult = { ws, kind: effectiveKind, info };
          resolve(authRes);
          return;
        }

        if (msgType === MsgType.AUTH_ERROR) {
          fail(new Error(jsonStr(msg, 'error', '配对码认证失败')));
        }
      });

      ws.on('error', (err: BusinessError) => {
        fail(new Error(err?.message || `无法连接到 ${wsUrl}`));
      });

      ws.on('close', () => {
        fail(new Error(`连接已关闭 (${wsUrl})`));
      });

      ws.connect(connectWsUrl, (err: BusinessError, ok: boolean) => {
        if (err || !ok) {
          fail(new Error(err?.message || `WebSocket 握手失败 (${wsUrl})`));
        }
      });
    });
  }

  private async raceLanCandidates(
    candidates: LanEndpoint[],
    pin: string,
    timeoutMs: number = 1300,
    outErrors?: string[]
  ): Promise<WsAuthResult | null> {
    if (candidates.length === 0) return null;
    const ips = candidates.map((c) => c.ip || c.wsUrl).join(', ');
    this.callbacks.onLog(`探测内网直连候选 (${ips})...`);

    return new Promise((resolve) => {
      let remaining = candidates.length;
      let won = false;
      let authErrMsg = '';
      let lastErrMsg = '';

      for (let i = 0; i < candidates.length; i++) {
        const ep = candidates[i];
        const kind = ep.kind === 'tailscale' ? 'tailscale' : 'lan';
        const epTimeout = kind === 'tailscale' ? Math.max(timeoutMs, 9000) : timeoutMs;
        this.openAndAuthWs(ep.wsUrl, pin, kind, epTimeout)
          .then((res) => {
            if (!won) {
              won = true;
              resolve(res);
            } else {
              try {
                res.ws.close();
              } catch {
                // Close slower candidate
              }
            }
          })
          .catch((err: Error) => {
            const msg = err?.message || `无法连接到 ${ep.wsUrl}`;
            if (msg.includes('配对码') || msg.includes('PIN') || msg.includes('认证')) {
              authErrMsg = msg;
            } else {
              lastErrMsg = msg;
            }
            remaining -= 1;
            if (!won && remaining <= 0) {
              if (outErrors) {
                if (authErrMsg) {
                  outErrors.push(authErrMsg);
                } else if (lastErrMsg) {
                  outErrors.push(lastErrMsg);
                }
              }
              resolve(null);
            }
          });
      }
    });
  }

  private connectViaRelay(relayWsUrl: string, deviceId: string, pin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let relayAuthStarted = false;
      const ws = webSocket.createWebSocket();
      this.signalingWs = ws;

      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      ws.on('open', () => {
        const msg: OutMsgControllerConnect = {
          type: MsgType.CONTROLLER_CONNECT,
          deviceId,
        };
        ws.send(JSON.stringify(msg));
      });

      ws.on('error', (err: BusinessError) => {
        fail(new Error(err?.message || `无法连接中继服务器 ${relayWsUrl}`));
      });

      ws.on('close', () => {
        if (!settled) {
          fail(new Error('中继连接已关闭'));
        }
        if (this.activeWs === ws && !this.closed) {
          this.handleUnexpectedDrop('连接已断开');
        }
      });

      ws.on('message', (_err: BusinessError, value: string | ArrayBuffer) => {
        if (typeof value !== 'string') {
          if (this.activeWs === ws) {
            this.handleBinary(value);
          }
          return;
        }
        const msg = parseJsonObject(value);
        if (!msg) return;
        const msgType = jsonStr(msg, 'type');

        if (msgType === MsgType.ERROR) {
          fail(new Error(jsonStr(msg, 'error', '设备连接失败')));
          return;
        }

        if (msgType === MsgType.ROUTE_CANDIDATES) {
          const endpoints = parseLanEndpoints(jsonArr(msg, 'lanEndpoints'));
          this.callbacks.onLog(`收到路由候选: LAN=${endpoints.length}`);
          if (endpoints.length > 0) {
            this.raceLanCandidates(endpoints, pin).then((winner) => {
              if (winner && !this.activeWs && !this.closed) {
                this.callbacks.onLog(`内网直连成功 (${winner.kind})`);
                this.activateWs(winner.ws, winner.kind, winner.info);
                try {
                  ws.close();
                } catch {
                  // Close relay signaling socket after LAN win
                }
                this.signalingWs = null;
                settled = true;
                resolve();
              }
            });
          }
          return;
        }

        if (msgType === MsgType.RELAY_READY) {
          this.callbacks.onLog('中继隧道就绪，正在鉴权...');
          return;
        }

        if (msgType === MsgType.AUTH_CHALLENGE && !relayAuthStarted) {
          relayAuthStarted = true;
          const nonce = jsonStr(msg, 'nonce');
          const devId = jsonStr(msg, 'deviceId');
          const proof = computeChallengeProof(pin, nonce, devId);
          const resp: OutMsgAuthResp = { type: MsgType.AUTH_RESPONSE, proof };
          ws.send(JSON.stringify(resp));
          return;
        }

        if (msgType === MsgType.AUTH_PENDING && !this.activeWs) {
          this.callbacks.onStatus('connecting', jsonStr(msg, 'message', '等待被控端确认允许连接...'));
          return;
        }

        if (msgType === MsgType.AUTH_OK && !this.activeWs) {
          const info: AuthOkInfo = {
            deviceId: jsonStr(msg, 'deviceId'),
            deviceName: jsonStr(msg, 'deviceName'),
            platform: jsonStr(msg, 'platform', 'win32'),
            channel: 'relay',
            displays: parseDisplays(jsonArr(msg, 'displays')),
            permissions: parsePermissions(jsonAsObject(msg['permissions'])),
            lanEndpoints: parseLanEndpoints(jsonArr(msg, 'lanEndpoints')),
            tunnelUrl: jsonStr(msg, 'tunnelUrl'),
          };
          this.activateWs(ws, 'relay', info);
          settled = true;
          resolve();
          return;
        }

        if (msgType === MsgType.AUTH_ERROR && !this.activeWs) {
          fail(new Error(jsonStr(msg, 'error', '配对码错误')));
          try {
            ws.close();
          } catch {
            // Ignore
          }
          return;
        }

        if (this.activeWs === ws) {
          this.handleControlMessage(msg);
        }
      });

      ws.connect(relayWsUrl, (err: BusinessError, ok: boolean) => {
        if (err || !ok) {
          fail(new Error(err?.message || `无法连接中继 ${relayWsUrl}`));
        }
      });
    });
  }

  private activateWs(ws: webSocket.WebSocket, kind: string, info: AuthOkInfo): void {
    this.activeWs = ws;
    this.channelKind = kind;
    this.wasAuthenticated = true;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }

    ws.on('message', (_err: BusinessError, value: string | ArrayBuffer) => {
      if (this.activeWs !== ws) return;
      if (typeof value === 'string') {
        const msg = parseJsonObject(value);
        if (msg) {
          this.handleControlMessage(msg);
        }
      } else {
        this.handleBinary(value);
      }
    });

    ws.on('close', () => {
      if (this.activeWs === ws && !this.closed) {
        this.handleUnexpectedDrop('连接已断开');
      }
    });

    ws.on('error', () => {
      if (this.activeWs === ws && !this.closed) {
        this.handleUnexpectedDrop('连接异常中断');
      }
    });

    this.startTelemetry();
    this.callbacks.onAuthenticated(info);
    this.callbacks.onStatus('connected', kind);
  }

  private handleUnexpectedDrop(reason: string): void {
    if (this.closed || !this.wasAuthenticated || !this.lastServerUrl) {
      this.callbacks.onStatus('disconnected', reason);
      return;
    }
    this.disconnect(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.lastServerUrl) return;
    if (this.reconnectAttempt >= 5) {
      this.wasAuthenticated = false;
      this.callbacks.onStatus('disconnected', '多次重连失败，请重新连接');
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(8000, 1200 * this.reconnectAttempt);
    this.callbacks.onStatus('reconnecting', `连接波动，正在自动重连 (${this.reconnectAttempt}/5)...`);
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      if (this.closed) return;
      void this.tryReconnectOnce();
    }, delay);
  }

  private async tryReconnectOnce(): Promise<void> {
    if (this.closed) return;
    try {
      const wsUrl = toWsUrl(this.lastServerUrl);
      if (this.lastMode === 'direct') {
        const auth = await this.connectDirectWithFallback(
          wsUrl,
          this.lastPin,
          this.lastExtraEndpoints,
          this.lastFallbackUrl,
          true
        );
        this.activateWs(auth.ws, auth.kind, auth.info);
      } else {
        await this.connectViaRelay(wsUrl, this.lastDeviceId, this.lastPin);
      }
    } catch {
      if (!this.closed) {
        this.scheduleReconnect();
      }
    }
  }

  private startTelemetry(): void {
    this.stopTelemetry();
    this.sendPing();
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, 2000);

    this.statsTimer = setInterval(() => {
      this.callbacks.onTelemetry({
        rttMs: this.rttMs,
        fps: this.framesInWindow,
        kbps: Math.round((this.bytesInWindow * 8) / 1000),
        channel: this.channelKind,
      });
      this.bytesInWindow = 0;
      this.framesInWindow = 0;
    }, 1000);
  }

  private stopTelemetry(): void {
    if (this.pingTimer >= 0) {
      clearInterval(this.pingTimer);
      this.pingTimer = -1;
    }
    if (this.statsTimer >= 0) {
      clearInterval(this.statsTimer);
      this.statsTimer = -1;
    }
  }

  private sendPing(): void {
    const now = Date.now();
    this.lastPingSentMs = now;
    const msg: OutMsgPing = {
      type: MsgType.PING,
      ts: now,
      rttMs: this.rttMs > 0 ? this.rttMs : undefined,
    };
    this.sendJson(msg);
  }

  sendJson(payload: Object): boolean {
    if (!this.activeWs) return false;
    try {
      this.activeWs.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(kind: number, meta: Object, payload: Uint8Array): boolean {
    if (!this.activeWs) return false;
    try {
      const buf = encodeBinaryEnvelope(kind, JSON.stringify(meta), payload);
      this.activeWs.send(buf);
      return true;
    } catch {
      return false;
    }
  }

  startScreen(displayId: number, preset: QualityPreset): void {
    this.hasEmittedFirstFrame = false;
    this.lastEmittedAspect = 0;
    this.lastCursorShapeId = -1;
    this.lastCursorX = -1;
    this.lastCursorY = -1;
    this.videoModeActive = false;
    this.codecMode = 'h264';
    const msg: OutMsgScreen = {
      type: MsgType.SCREEN_START,
      displayId,
      fps: preset.fps,
      scale: preset.scale,
      quality: preset.quality,
      auto: preset.key === 'auto',
      allowDirty: true,
      maxWidth: this.presetMaxWidth(preset),
      singleFrame: true,
      separateCursor: true,
      codec: this.codecMode,
    };
    this.sendJson(msg);
  }

  configScreen(displayId: number, preset: QualityPreset): void {
    const msg: OutMsgScreen = {
      type: MsgType.SCREEN_CONFIG,
      displayId,
      fps: preset.fps,
      scale: preset.scale,
      quality: preset.quality,
      auto: preset.key === 'auto',
      allowDirty: true,
      maxWidth: this.presetMaxWidth(preset),
      singleFrame: true,
      separateCursor: true,
      codec: this.codecMode,
    };
    this.sendJson(msg);
  }

  private opusHeadAb: ArrayBuffer | undefined = undefined;

  startAudio(): void {
    const opusOk = TsnetClient.opusInit(48000, 2);
    const msg: OutMsgAudioStart = {
      type: MsgType.AUDIO_START,
      codec: opusOk ? 'opus' : 'ima_adpcm',
    };
    this.sendJson(msg);
  }

  stopAudio(): void {
    TsnetClient.opusDestroy();
    this.opusHeadAb = undefined;
    const msg: OutMsgSimple = { type: MsgType.AUDIO_STOP };
    this.sendJson(msg);
  }

  setPrivacy(enabled: boolean): void {
    const msg: OutMsgPrivacy = { type: MsgType.PRIVACY_SET, enabled };
    this.sendJson(msg);
  }

  sendKey(action: string, vk: number): void {
    const msg: OutMsgKey = { type: MsgType.INPUT_KEY, action, vk };
    this.sendJson(msg);
  }

  sendMouse(action: string, x: number, y: number, button: string = 'left', delta: number = 0): void {
    const msg: OutMsgMouse = {
      type: MsgType.INPUT_MOUSE,
      action,
      x,
      y,
      button,
      delta,
    };
    this.sendJson(msg);
  }

  sendMouseWheel(delta: number): void {
    const msg: OutMsgWheel = {
      type: MsgType.INPUT_MOUSE,
      action: 'wheel',
      delta,
    };
    this.sendJson(msg);
  }

  sendHotkey(vk: number, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean): void {
    const msg: OutMsgHotkey = {
      type: MsgType.INPUT_HOTKEY,
      vk,
      ctrl,
      alt,
      shift,
      meta,
    };
    this.sendJson(msg);
  }

  sendText(text: string): void {
    if (!text) return;
    const msg: OutMsgText = {
      type: MsgType.INPUT_TEXT,
      text,
    };
    this.sendJson(msg);
  }

  openPty(id: string, shell: string, cols: number, rows: number): void {
    const msg: OutMsgPtyOpen = {
      type: MsgType.PTY_OPEN,
      id,
      shell,
      cols,
      rows,
    };
    this.sendJson(msg);
  }

  sendPtyInput(id: string, data: string): void {
    const msg: OutMsgPtyInput = {
      type: MsgType.PTY_INPUT,
      id,
      data,
    };
    this.sendJson(msg);
  }

  closePty(id: string): void {
    const msg: OutMsgPtyClose = {
      type: MsgType.PTY_CLOSE,
      id,
    };
    this.sendJson(msg);
  }

  requestFsRoots(): void {
    const msg: OutMsgFsReq = { type: MsgType.FS_ROOTS, reqId: `r-${Date.now()}` };
    this.sendJson(msg);
  }

  requestFsList(dirPath: string): void {
    const msg: OutMsgFsReq = { type: MsgType.FS_LIST, reqId: `l-${Date.now()}`, path: dirPath };
    this.sendJson(msg);
  }

  requestFsMkdir(dirPath: string): void {
    const msg: OutMsgFsReq = { type: MsgType.FS_MKDIR, reqId: `m-${Date.now()}`, path: dirPath };
    this.sendJson(msg);
  }

  requestFsRename(oldPath: string, newPath: string): void {
    const msg: OutMsgFsRename = { type: MsgType.FS_RENAME, reqId: `rn-${Date.now()}`, oldPath, newPath };
    this.sendJson(msg);
  }

  requestFsDelete(targetPath: string): void {
    const msg: OutMsgFsReq = { type: MsgType.FS_DELETE, reqId: `del-${Date.now()}`, path: targetPath };
    this.sendJson(msg);
  }

  requestFsReadText(filePath: string): void {
    const msg: OutMsgFsReq = { type: MsgType.FS_READ_TEXT, reqId: `rd-${Date.now()}`, path: filePath };
    this.sendJson(msg);
  }

  requestFsWriteText(filePath: string, content: string): void {
    const msg: OutMsgFsWrite = { type: MsgType.FS_WRITE_TEXT, reqId: `wr-${Date.now()}`, path: filePath, content };
    this.sendJson(msg);
  }

  requestFsDownload(filePath: string): void {
    const msg: OutMsgFsDownload = {
      type: MsgType.FS_DOWNLOAD,
      reqId: `dl-${Date.now()}`,
      transferId: `dl-${Date.now()}`,
      path: filePath,
    };
    this.sendJson(msg);
  }

  requestFsZipDownload(paths: string[]): void {
    const msg: OutMsgFsZip = {
      type: MsgType.FS_ZIP_DOWNLOAD,
      reqId: `zip-${Date.now()}`,
      transferId: `zip-${Date.now()}`,
      paths: paths,
    };
    this.sendJson(msg);
  }

  /** Ask the host for a fresh full frame (used when the canvas lost its baseline). */
  refreshFullFrame(): void {
    const off: OutMsgAllowDirty = { type: MsgType.SCREEN_CONFIG, allowDirty: false };
    this.sendJson(off);
    setTimeout(() => {
      const on: OutMsgAllowDirty = { type: MsgType.SCREEN_CONFIG, allowDirty: true };
      this.sendJson(on);
    }, 150);
  }

  requestKeyFrame(): void {
    if (this.codecMode === 'h264') {
      const msg: OutMsgForceKey = { type: MsgType.SCREEN_CONFIG, forceKey: true };
      this.sendJson(msg);
    } else {
      this.refreshFullFrame();
    }
  }

  setRoi(x: number, y: number, w: number, h: number): void {
    const msg: OutMsgRoi = {
      type: MsgType.SCREEN_CONFIG,
      roi: { x: x, y: y, w: w, h: h },
    };
    this.sendJson(msg);
  }

  clearRoi(): void {
    const msg: OutMsgRoiClear = { type: MsgType.SCREEN_CONFIG, roi: null };
    this.sendJson(msg);
  }

  setHiRes(enabled: boolean): void {
    const msg: OutMsgHiRes = {
      type: MsgType.SCREEN_CONFIG,
      hiRes: enabled,
    };
    this.sendJson(msg);
  }

  setClipboardWatch(enabled: boolean): void {
    const msg: OutMsgClipboardWatch = {
      type: MsgType.CLIPBOARD_WATCH,
      enabled: enabled,
    };
    this.sendJson(msg);
  }

  requestClipboard(): void {
    const msg: OutMsgSimple = { type: MsgType.CLIPBOARD_GET };
    this.sendJson(msg);
  }

  private handleControlMessage(msg: Record<string, Object>): void {
    const t = jsonStr(msg, 'type');
    if (t === MsgType.PONG) {
      const ts = jsonNum(msg, 'ts', 0);
      if (ts > 0) {
        this.rttMs = Math.max(1, Date.now() - ts);
      } else if (this.lastPingSentMs > 0) {
        this.rttMs = Math.max(1, Date.now() - this.lastPingSentMs);
      }
      return;
    }

    if (t === MsgType.SCREEN_CONFIG) {
      const codec = jsonStr(msg, 'codec');
      if (codec === 'jpeg') {
        this.codecMode = 'jpeg';
        if (this.videoModeActive) {
          this.videoModeActive = false;
          this.callbacks.onVideoModeChange?.(false, 0);
        }
      } else if (codec === 'h264') {
        this.codecMode = 'h264';
      }
      return;
    }

    if (t === MsgType.CLIPBOARD_DATA) {
      if (jsonBool(msg, 'watch', false)) {
        return; // ack of the watch toggle
      }
      this.callbacks.onClipboardData(
        jsonStr(msg, 'text'),
        jsonStr(msg, 'imageBase64'),
        jsonBool(msg, 'auto', false)
      );
      return;
    }

    if (t === MsgType.PTY_OPENED) {
      this.callbacks.onPtyOpened(jsonStr(msg, 'id'), jsonStr(msg, 'mode', 'pty'));
      return;
    }

    if (t === MsgType.PTY_EXIT) {
      this.callbacks.onPtyExit(jsonStr(msg, 'id'), jsonNum(msg, 'code', 0));
      return;
    }

    if (t === MsgType.FS_ERROR) {
      this.callbacks.onFsError(jsonStr(msg, 'error', '文件操作失败'));
      return;
    }

    if (t === MsgType.FS_RESULT) {
      const op = jsonStr(msg, 'op');
      if (op === 'roots') {
        const rawRoots = jsonArr(msg, 'roots');
        const roots: FileRoot[] = [];
        for (let i = 0; i < rawRoots.length; i++) {
          const r = jsonAsObject(rawRoots[i]);
          if (!r) continue;
          roots.push({ name: jsonStr(r, 'name'), path: jsonStr(r, 'path') });
        }
        this.callbacks.onFsRoots(roots);
      } else if (op === 'list') {
        const rawItems = jsonArr(msg, 'items');
        const items: FileItem[] = [];
        for (let i = 0; i < rawItems.length; i++) {
          const it = jsonAsObject(rawItems[i]);
          if (!it) continue;
          items.push({
            name: jsonStr(it, 'name'),
            path: jsonStr(it, 'path'),
            isDir: jsonBool(it, 'isDir', false),
            size: jsonNum(it, 'size', 0),
            mtimeMs: jsonNum(it, 'mtimeMs', 0),
          });
        }
        this.callbacks.onFsList(jsonStr(msg, 'path'), jsonStr(msg, 'parent'), items);
      } else if (op === 'read_text') {
        this.callbacks.onFsReadText(
          jsonStr(msg, 'path'),
          jsonStr(msg, 'content'),
          jsonBool(msg, 'truncated', false)
        );
      } else {
        this.callbacks.onFsActionDone(op, jsonStr(msg, 'path'));
      }
    }
  }

  private handleBinary(raw: ArrayBuffer): void {
    this.bytesInWindow += raw.byteLength;
    const env = decodeBinaryEnvelope(raw);
    if (!env) return;

    if (env.kind === FrameKind.SCREEN) {
      this.framesInWindow += 1;
      const cx = jsonNum(env.meta, 'cursorX', 0.5);
      const cy = jsonNum(env.meta, 'cursorY', 0.5);
      const fw = jsonNum(env.meta, 'width', 0);
      const fh = jsonNum(env.meta, 'height', 0);
      const aspect = fw > 0 && fh > 0 ? fw / fh : 16 / 9;
      const shapeRaw = jsonAsObject(env.meta['cursorShape']);
      if (shapeRaw !== null) {
        const sid = jsonNum(shapeRaw, 'id', 0);
        const png = jsonStr(shapeRaw, 'png', '');
        if (png.length > 0 && sid !== this.lastCursorShapeId) {
          this.lastCursorShapeId = sid;
          const shape: CursorShapeInfo = {
            id: sid,
            w: jsonNum(shapeRaw, 'w', 32),
            h: jsonNum(shapeRaw, 'h', 32),
            hx: jsonNum(shapeRaw, 'hx', 0),
            hy: jsonNum(shapeRaw, 'hy', 0),
            png,
          };
          this.callbacks.onCursorShape?.(shape);
        }
      }
      if (jsonBool(env.meta, 'video', false) || env.payload.byteLength === 0) {
        const aspectChanged = fw > 0 && fh > 0 && Math.abs(aspect - this.lastEmittedAspect) > 0.005;
        const cursorMoved = Math.abs(cx - this.lastCursorX) > 0.0005 || Math.abs(cy - this.lastCursorY) > 0.0005;
        if (aspectChanged || cursorMoved) {
          if (aspectChanged) {
            this.lastEmittedAspect = aspect;
          }
          this.lastCursorX = cx;
          this.lastCursorY = cy;
          this.callbacks.onVideoGeometry?.(cx, cy, aspect);
        }
        return;
      }
      this.lastCursorX = cx;
      this.lastCursorY = cy;
      let dirtyX = 0;
      let dirtyY = 0;
      let dirtyW = 0;
      let dirtyH = 0;
      const dirtyRaw = env.meta['dirty'];
      if (dirtyRaw !== undefined && dirtyRaw !== null) {
        const dm = dirtyRaw as Record<string, number>;
        dirtyX = Number(dm['x']) || 0;
        dirtyY = Number(dm['y']) || 0;
        dirtyW = Number(dm['w']) || 0;
        dirtyH = Number(dm['h']) || 0;
      }
      let echoX = -1;
      let echoY = -1;
      const echoRaw = env.meta['echo'];
      if (echoRaw !== undefined && echoRaw !== null) {
        const em = echoRaw as Record<string, number>;
        echoX = Number(em['x']);
        echoY = Number(em['y']);
      }
      const frameMeta: ScreenFrameMeta = {
        width: fw,
        height: fh,
        dirtyX: dirtyX,
        dirtyY: dirtyY,
        dirtyW: dirtyW,
        dirtyH: dirtyH,
        hasDirty: dirtyW > 0 && dirtyH > 0,
        echoX: echoX,
        echoY: echoY,
      };
      const copy = new Uint8Array(env.payload);
      const jpegBuf: ArrayBuffer = copy.buffer as ArrayBuffer;
      this.queueDecodeFrame(jpegBuf, cx, cy, aspect, frameMeta);
      return;
    }

    if (env.kind === FrameKind.VIDEO) {
      this.framesInWindow += 1;
      const vw = jsonNum(env.meta, 'width', 0);
      const vh = jsonNum(env.meta, 'height', 0);
      const vKey = jsonBool(env.meta, 'key', false);
      const vTs = jsonNum(env.meta, 'ts', 0);
      const aspect = vw > 0 && vh > 0 ? vw / vh : 16 / 9;
      if (!this.videoModeActive || (vw > 0 && vh > 0 && Math.abs(aspect - this.lastEmittedAspect) > 0.005)) {
        this.videoModeActive = true;
        this.lastEmittedAspect = aspect;
        this.callbacks.onVideoModeChange?.(true, aspect);
      }
      if (env.payload.byteLength > 0 && this.videoFrameListener) {
        const copy = new Uint8Array(env.payload);
        const ab: ArrayBuffer = copy.buffer as ArrayBuffer;
        let rx = 0;
        let ry = 0;
        let rw = 0;
        let rh = 0;
        const roiRaw = env.meta['roi'];
        if (roiRaw !== undefined && roiRaw !== null) {
          const rm = roiRaw as Record<string, number>;
          rx = Number(rm['x']) || 0;
          ry = Number(rm['y']) || 0;
          rw = Number(rm['w']) || 0;
          rh = Number(rm['h']) || 0;
        }
        const vMeta: VideoFrameMeta = {
          width: vw,
          height: vh,
          key: vKey,
          ts: vTs,
          roiX: rx,
          roiY: ry,
          roiW: rw,
          roiH: rh,
        };
        this.videoFrameListener(ab, vMeta);
      }
      return;
    }

    if (env.kind === FrameKind.AUDIO) {
      const sr = jsonNum(env.meta, 'sampleRate', 48000);
      const ch = jsonNum(env.meta, 'channels', 2);
      const codec = jsonStr(env.meta, 'codec', 'pcm16');
      let pcm = env.payload;
      if (codec === 'opus') {
        const headStr = jsonStr(env.meta, 'head', '');
        if (headStr.length > 0 && !this.opusHeadAb) {
          const headBytes = base64ToBytes(headStr);
          if (headBytes.byteLength >= 19) {
            const hab = new ArrayBuffer(headBytes.byteLength);
            new Uint8Array(hab).set(headBytes);
            this.opusHeadAb = hab;
          }
        }
        const pktAb = new ArrayBuffer(env.payload.byteLength);
        new Uint8Array(pktAb).set(env.payload);
        pcm = TsnetClient.opusDecode(pktAb, sr, ch, this.opusHeadAb);
      } else if (codec === 'ima_adpcm') {
        const frames = jsonNum(env.meta, 'frames', Math.max(0, env.payload.byteLength - ch * 4 + 1));
        pcm = decodeImaAdpcmToPcmBytes(env.payload, ch, frames);
      }
      if (pcm.byteLength > 0) {
        this.callbacks.onAudioFrame(sr, ch, pcm);
      }
      return;
    }

    if (env.kind === FrameKind.PTY_OUT) {
      const id = jsonStr(env.meta, 'id');
      const text = utf8Decode(env.payload, true);
      this.callbacks.onPtyOutput(id, text);
      return;
    }

    if (env.kind === FrameKind.FILE_DOWN) {
      const transferId = jsonStr(env.meta, 'transferId');
      const fileName = jsonStr(env.meta, 'fileName', 'download.bin');
      const done = jsonBool(env.meta, 'done', false);
      let rec = this.downloads.get(transferId);
      if (!rec) {
        rec = { fileName, chunks: [], totalBytes: 0 };
        this.downloads.set(transferId, rec);
      }
      if (env.payload.byteLength > 0) {
        const copy = env.payload.slice();
        rec.chunks.push(copy);
        rec.totalBytes += copy.byteLength;
      }
      if (done) {
        this.downloads.delete(transferId);
        const merged = new Uint8Array(rec.totalBytes);
        let offset = 0;
        for (let i = 0; i < rec.chunks.length; i++) {
          merged.set(rec.chunks[i], offset);
          offset += rec.chunks[i].byteLength;
        }
        this.callbacks.onFsDownloadReady(rec.fileName, merged);
      }
    }
  }

  private queueDecodeFrame(jpegBuf: ArrayBuffer, cx: number, cy: number, aspect: number, meta: ScreenFrameMeta): void {
    const item: PendingScreenFrame = { jpegBuf, cx, cy, aspect, meta };
    if (!meta.hasDirty) {
      // A full frame supersedes any older queued full/dirty frames.
      this.pendingFrames = [item];
    } else if (this.pendingFrames.length >= 24) {
      // Decoder fell behind a dirty-rect burst: drop backlog and request a clean full frame.
      this.pendingFrames = [];
      const now = Date.now();
      if (now - this.lastResyncAt > 1800) {
        this.lastResyncAt = now;
        this.refreshFullFrame();
      }
    } else {
      this.pendingFrames.push(item);
    }
    if (!this.decodingFrame) {
      void this.flushFrameQueue();
    }
  }

  private async flushFrameQueue(): Promise<void> {
    this.decodingFrame = true;
    try {
      while (this.pendingFrames.length > 0 && !this.closed) {
        const next = this.pendingFrames.shift();
        if (!next) continue;

        try {
          const src = image.createImageSource(next.jpegBuf);
          const pm = await src.createPixelMap();
          await src.release();
          if (this.closed) {
            await pm.release();
            break;
          }
          const needLayoutUpdate =
            !this.hasEmittedFirstFrame ||
            this.directFrameListener === null ||
            (next.aspect > 0 && Math.abs(next.aspect - this.lastEmittedAspect) > 0.005) ||
            next.meta.echoX >= 0;

          if (needLayoutUpdate) {
            const oldPinned = this.pinnedPixelMap;
            this.pinnedPixelMap = pm;
            this.hasEmittedFirstFrame = true;
            if (next.aspect > 0) {
              this.lastEmittedAspect = next.aspect;
            }
            this.callbacks.onScreenPixelMap(pm, next.cx, next.cy, next.aspect, next.meta);
            if (oldPinned) {
              await oldPinned.release();
            }
          } else {
            const toRelease = this.retiredPixelMap;
            this.retiredPixelMap = this.currentPixelMap;
            this.currentPixelMap = pm;
            if (this.directFrameListener) {
              this.directFrameListener(pm, next.meta);
            }
            if (toRelease) {
              await toRelease.release();
            }
          }
        } catch {
          // Drop malformed JPEG frame
        }
      }
    } finally {
      this.decodingFrame = false;
    }
  }

  disconnect(userInitiated: boolean = true): void {
    if (userInitiated) {
      this.closed = true;
      this.wasAuthenticated = false;
      if (this.reconnectTimer >= 0) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = -1;
      }
    }
    this.stopTelemetry();
    if (this.activeWs) {
      try {
        this.activeWs.close();
      } catch {
        // Ignore
      }
      this.activeWs = null;
    }
    if (this.signalingWs) {
      try {
        this.signalingWs.close();
      } catch {
        // Ignore
      }
      this.signalingWs = null;
    }
    this.pendingFrames = [];
    this.hasEmittedFirstFrame = false;
    this.videoModeActive = false;
    this.lastEmittedAspect = 0;
    this.lastCursorShapeId = -1;
    this.lastCursorX = -1;
    this.lastCursorY = -1;
    if (this.pinnedPixelMap) {
      this.pinnedPixelMap.release().catch(() => {});
      this.pinnedPixelMap = null;
    }
    if (this.currentPixelMap) {
      this.currentPixelMap.release().catch(() => {});
      this.currentPixelMap = null;
    }
    if (this.retiredPixelMap) {
      this.retiredPixelMap.release().catch(() => {});
      this.retiredPixelMap = null;
    }
    this.downloads.clear();
    if (userInitiated) {
      this.callbacks.onStatus('idle', '');
    }
  }
}

export function getPresetByKey(key: string): QualityPreset {
  for (let i = 0; i < QUALITY_PRESETS.length; i++) {
    if (QUALITY_PRESETS[i].key === key) {
      return QUALITY_PRESETS[i];
    }
  }
  return QUALITY_PRESETS[1];
}
