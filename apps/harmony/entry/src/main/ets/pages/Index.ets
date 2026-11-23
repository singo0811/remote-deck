import tsnetBridge from 'libremotedeck_ts.so';
import { display } from '@kit.ArkUI';
import { common, wantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { picker, fileIo } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  AuthOkInfo,
  DisplayInfo,
  FileItem,
  FileRoot,
  LanEndpoint,
  MsgType,
  OutMsgClipboardSet,
  OutMsgSimple,
  QUALITY_PRESETS,
  QualityPreset,
  RecentDeviceItem,
  RemoteDeviceInfo,
  TelemetryInfo,
  parseConnectUrl,
  toHttpBase,
  toWsUrl,
} from '../protocol/Protocol';
import { RemoteClient, getPresetByKey } from '../protocol/RemoteClient';
import { TsnetClient, TsnetStatus, emptyTsnetStatus } from '../protocol/TsnetClient';
import { CursorShapeInfo, PhoneShareStatus, ScreenFrameMeta, emptyPhoneShareStatus, parsePhoneShareStatus } from '../protocol/Protocol';
import { HarmonyAudioPlayer } from '../protocol/AudioPlayer';
import { RecentStore } from '../storage/RecentStore';
import { WindowController } from '../entryability/EntryAbility';
import { ConnectPane } from '../components/ConnectPane';
import { ScreenPane } from '../components/ScreenPane';
import { TerminalPane, stripAnsiChunk } from '../components/TerminalPane';
import { FilePane } from '../components/FilePane';

@Entry
@Component
struct Index {
  @StorageLink('pendingDeepLinkMode') pendingMode: string = '';
  @StorageLink('pendingDeepLinkServer') pendingServer: string = '';
  @StorageLink('pendingDeepLinkDeviceId') pendingDeviceId: string = '';
  @StorageLink('pendingDeepLinkPin') pendingPin: string = '';

  @State layoutOverride: string = 'auto'; // 'auto' | 'phone' | 'tablet' | 'desktop'
  @State detectedTier: string = 'phone';
  @State isLandscape: boolean = false;
  @State orientationMode: string = 'auto'; // 'auto' | 'landscape' | 'portrait'
  @State hudCollapsed: boolean = false;
  @State connState: string = 'idle'; // 'idle' | 'connecting' | 'connected'
  @State activeTab: string = 'screen'; // 'screen' | 'terminal' | 'files' | 'split'

  @State mode: string = 'relay';
  @State serverUrl: string = '';
  @State deviceId: string = '';
  @State pin: string = '';

  @State errorMsg: string = '';
  @State logs: string[] = [];
  @State toast: string = '';
  @State scanningLan: boolean = false;
  @State onlineDevices: RemoteDeviceInfo[] = [];
  @State recentDevices: RecentDeviceItem[] = [];

  @State sessionInfo: AuthOkInfo | null = null;
  @State displays: DisplayInfo[] = [];
  @State activeDisplayId: number = 0;
  @State qualityKey: string = 'auto';
  @State audioEnabled: boolean = false;
  @State clipSync: boolean = false;
  @State privacyEnabled: boolean = false;
  @State reconnectBanner: string = '';
  @State telemetry: TelemetryInfo = { rttMs: 0, fps: 0, kbps: 0, channel: '' };
  @State tsnetStatus: TsnetStatus = emptyTsnetStatus();
  @State phoneShareStatus: PhoneShareStatus = emptyPhoneShareStatus();
  private tsnetPollTimer: number = -1;
  private sharePollTimer: number = -1;
  private tsnetWasRunning: boolean = false;
  private lastTsnetLogSummary: string = '';

  @State pixelMap: image.PixelMap | null = null;
  @State videoActive: boolean = false;
  @StorageProp('appForegroundTick') @Watch('onAppForeground') appForegroundTick: number = 0;

  private onAppForeground(): void {
    if (this.connState === 'connected' && this.client) {
      tsnetBridge.videoReset();
      this.client.requestKeyFrame();
    }
    if (this.phoneShareStatus.running) {
      tsnetBridge.shareKeyFrame();
      this.refreshPhoneShareStatus();
    }
  }

  @State frameMeta: ScreenFrameMeta | null = null;
  @State frameAspect: number = 16 / 9;
  @State cursorX: number = 0.5;
  @State cursorY: number = 0.5;
  @State cursorShape: CursorShapeInfo | null = null;

  @State termId: string = `term-${Date.now()}`;
  @State termStatus: string = 'closed';
  @State termOutput: string = '';
  private ptyInitialized: boolean = false;

  @State fsRoots: FileRoot[] = [];
  @State fsCurrentPath: string = '';
  @State fsParentPath: string = '';
  @State fsItems: FileItem[] = [];
  @State fsLoading: boolean = false;
  @State fsEditingPath: string = '';
  @State fsEditingContent: string = '';
  @State fsEditingTruncated: boolean = false;
  private fsInitialized: boolean = false;

  private client: RemoteClient | null = null;
  private audioPlayer: HarmonyAudioPlayer = new HarmonyAudioPlayer();
  private hiResActive: boolean = false;
  private toastTimer: number = -1;

  private handleZoomLevel(z: number): void {
    const want = z > 2.5;
    if (want === this.hiResActive) return;
    this.hiResActive = want;
    this.client?.setHiRes(want);
  }

  private effectiveTier(): string {
    if (this.layoutOverride !== 'auto') {
      return this.layoutOverride;
    }
    return this.detectedTier;
  }

  private showToast(msg: string): void {
    this.toast = msg;
    if (this.toastTimer >= 0) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.toast = '';
    }, 2600);
  }

  private appendLog(line: string): void {
    const next = [...this.logs, line];
    if (next.length > 16) {
      this.logs = next.slice(next.length - 16);
    } else {
      this.logs = next;
    }
  }

  aboutToAppear(): void {
    void this.loadInitialState();
    this.ensureClient();
  }

  aboutToDisappear(): void {
    this.stopTsnetPolling();
    this.stopSharePolling();
    tsnetBridge.shareStop();
    void this.stopShareBackgroundTask();
    this.client?.disconnect(true);
    TsnetClient.closeAllTunnels();
    void this.audioPlayer.releaseRenderer();
  }

  private stopSharePolling(): void {
    if (this.sharePollTimer >= 0) {
      clearInterval(this.sharePollTimer);
      this.sharePollTimer = -1;
    }
  }

  private shareBgTaskActive: boolean = false;
  private shareDisplayWatching: boolean = false;
  private shareTargetW: number = 0;
  private shareTargetH: number = 0;

  private computeShareTargetSize(): number[] {
    let w = 720;
    let h = 1156;
    try {
      const disp = display.getDefaultDisplaySync();
      if (disp.width > 0 && disp.height > 0) {
        const maxShort = 864;
        const shortSide = Math.min(disp.width, disp.height);
        if (shortSide <= maxShort) {
          w = disp.width & ~1;
          h = disp.height & ~1;
        } else {
          const scale = maxShort / shortSide;
          w = Math.round(disp.width * scale) & ~1;
          h = Math.round(disp.height * scale) & ~1;
        }
      }
    } catch {
      // Fallback to 720x1156
    }
    return [w, h];
  }

  private onDisplayChange = (): void => {
    if (!this.phoneShareStatus.running) return;
    const sz = this.computeShareTargetSize();
    if (sz[0] !== this.shareTargetW || sz[1] !== this.shareTargetH) {
      this.shareTargetW = sz[0];
      this.shareTargetH = sz[1];
      tsnetBridge.shareResize(sz[0], sz[1]);
    }
  };

  private startShareDisplayWatch(): void {
    if (this.shareDisplayWatching) return;
    try {
      display.on('change', this.onDisplayChange);
      this.shareDisplayWatching = true;
    } catch {
      // Ignore
    }
  }

  private stopShareDisplayWatch(): void {
    if (!this.shareDisplayWatching) return;
    this.shareDisplayWatching = false;
    try {
      display.off('change', this.onDisplayChange);
    } catch {
      // Ignore
    }
  }

  private async startShareBackgroundTask(): Promise<void> {
    if (this.shareBgTaskActive) return;
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const wantInfo: wantAgent.WantAgentInfo = {
        wants: [{ bundleName: ctx.abilityInfo.bundleName, abilityName: ctx.abilityInfo.name }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
      };
      const agent = await wantAgent.getWantAgent(wantInfo);
      await backgroundTaskManager.startBackgroundRunning(
        ctx,
        backgroundTaskManager.BackgroundMode.DATA_TRANSFER,
        agent
      );
      this.shareBgTaskActive = true;
    } catch {
      // Ignore if continuous task is unavailable
    }
  }

  private async stopShareBackgroundTask(): Promise<void> {
    if (!this.shareBgTaskActive) return;
    this.shareBgTaskActive = false;
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      await backgroundTaskManager.stopBackgroundRunning(ctx);
    } catch {
      // Ignore
    }
  }

  private refreshPhoneShareStatus(): void {
    const st = parsePhoneShareStatus(tsnetBridge.shareStatus());
    this.phoneShareStatus = st;
    if (!st.running && st.state !== 'starting') {
      this.stopSharePolling();
      this.stopShareDisplayWatch();
      void this.stopShareBackgroundTask();
    }
  }

  private handleTogglePhoneShare(enabled: boolean): void {
    if (!enabled) {
      tsnetBridge.shareStop();
      this.stopSharePolling();
      this.stopShareDisplayWatch();
      void this.stopShareBackgroundTask();
      this.refreshPhoneShareStatus();
      this.showToast('已停止手机 H.264 投屏共享');
      return;
    }
    const sz = this.computeShareTargetSize();
    const w = sz[0];
    const h = sz[1];
    this.shareTargetW = w;
    this.shareTargetH = h;
    const ok = tsnetBridge.shareStart(9603, w, h, 60);
    this.refreshPhoneShareStatus();
    if (!ok) {
      this.showToast(this.phoneShareStatus.lastError || '启动手机屏幕共享失败');
      return;
    }
    this.stopSharePolling();
    this.startShareDisplayWatch();
    void this.startShareBackgroundTask();
    this.sharePollTimer = setInterval(() => {
      this.refreshPhoneShareStatus();
    }, 1000);
    this.showToast('请在系统弹窗中允许屏幕共享，PC 端即可 60fps 观看');
  }

  private getTsnetStateDir(): string {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    return `${ctx.filesDir}/tsnet`;
  }

  private recordTsnetStartError(errText: string): void {
    hilog.error(0x0000, 'RemoteDeckTs', '%{public}s', errText);
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const dir = `${ctx.filesDir}/tsnet`;
      try {
        fileIo.mkdirSync(dir);
      } catch {
        // Ignore if exists
      }
      const f = fileIo.openSync(`${dir}/last-start-error.txt`, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, `${new Date().toISOString()} ${errText}\n`);
      fileIo.closeSync(f);
    } catch {
      // Ignore diagnostic write error
    }
  }

  private startTsnetPolling(): void {
    this.stopTsnetPolling();
    this.refreshTsnetStatus();
    this.tsnetPollTimer = setInterval(() => {
      this.refreshTsnetStatus();
    }, 2500);
  }

  private stopTsnetPolling(): void {
    if (this.tsnetPollTimer >= 0) {
      clearInterval(this.tsnetPollTimer);
      this.tsnetPollTimer = -1;
    }
  }

  private refreshTsnetStatus(): void {
    const st = TsnetClient.getStatus();
    if (st.state !== this.tsnetStatus.state || st.authUrl !== this.tsnetStatus.authUrl || st.lastError !== this.tsnetStatus.lastError) {
      console.info(`[RemoteDeck-Tsnet] state=${st.state} ip=${st.tailscaleIp} auth=${st.authUrl ? 'yes' : 'no'} err=${st.lastError}`);
    }
    if (st.logs && st.logs.length > 0) {
      const summary = st.logs.slice(-5).join(' | ');
      if (summary !== this.lastTsnetLogSummary) {
        this.lastTsnetLogSummary = summary;
        console.info(`[RemoteDeck-Tsnet-Go] ${summary}`);
      }
    }
    this.tsnetStatus = st;
    const nowRunning = st.enabled && st.tailscaleIp.length > 0;
    if (nowRunning && !this.tsnetWasRunning) {
      this.tsnetWasRunning = true;
      void this.scanLan();
    } else if (!nowRunning) {
      this.tsnetWasRunning = false;
    }
    if (!st.enabled) {
      this.stopTsnetPolling();
    }
  }

  private async handleToggleTsnet(enabled: boolean, authKey: string = ''): Promise<void> {
    const store = RecentStore.getInstance();
    await store.saveTsnetEnabled(enabled);
    if (authKey.trim().length > 0) {
      await store.saveTsnetAuthKey(authKey.trim());
    }
    if (enabled) {
      const effectiveKey = authKey.trim() || await store.loadTsnetAuthKey();
      const ok = TsnetClient.start(this.getTsnetStateDir(), 'remotedeck-phone', effectiveKey);
      if (!ok) {
        const errText = TsnetClient.lastStartError || '内嵌组网启动失败';
        this.recordTsnetStartError(errText);
        this.tsnetStatus = {
          enabled: false,
          state: 'Error',
          tailscaleIp: '',
          hostname: '',
          authUrl: '',
          lastError: errText,
          peers: [],
        };
        this.showToast(`内嵌组网启动失败: ${errText}`);
        return;
      }
      this.startTsnetPolling();
      this.showToast('正在初始化 P2P 组网...');
    } else {
      TsnetClient.stop();
      this.stopTsnetPolling();
      this.tsnetWasRunning = false;
      this.tsnetStatus = emptyTsnetStatus();
      this.showToast('已关闭内嵌 P2P 组网');
    }
  }

  private async handleLogoutTsnet(): Promise<void> {
    const store = RecentStore.getInstance();
    await store.saveTsnetEnabled(false);
    await store.saveTsnetAuthKey('');
    TsnetClient.logout();
    this.stopTsnetPolling();
    this.tsnetWasRunning = false;
    this.tsnetStatus = emptyTsnetStatus();
    this.showToast('已退出当前 Tailscale 组网账号');
  }

  private async loadInitialState(): Promise<void> {
    const store = RecentStore.getInstance();
    this.recentDevices = await store.loadRecent();
    const lastServer = await store.loadLastServer();
    const lastMode = await store.loadLastMode();
    if (lastServer && !this.serverUrl) {
      this.serverUrl = lastServer;
    }
    if (lastMode) {
      this.mode = lastMode;
    }
    const tsEnabled = await store.loadTsnetEnabled();
    if (tsEnabled) {
      const tsKey = await store.loadTsnetAuthKey();
      if (TsnetClient.start(this.getTsnetStateDir(), 'remotedeck-phone', tsKey)) {
        this.startTsnetPolling();
      } else {
        const errText = TsnetClient.lastStartError || '内嵌组网启动失败';
        this.recordTsnetStartError(errText);
        this.tsnetStatus = {
          enabled: false,
          state: 'Error',
          tailscaleIp: '',
          hostname: '',
          authUrl: '',
          lastError: errText,
          peers: [],
        };
      }
    }
    this.applyPendingDeepLink();
    void this.scanLan();
  }

  private applyPendingDeepLink(): void {
    if (this.pendingServer.length > 0) {
      this.mode = this.pendingMode || 'direct';
      this.serverUrl = this.pendingServer;
      if (this.pendingDeviceId.length > 0) {
        this.deviceId = this.pendingDeviceId;
      }
      const deepPin = this.pendingPin;
      if (deepPin.length > 0) {
        this.pin = deepPin;
      }
      this.pendingMode = '';
      this.pendingServer = '';
      this.pendingDeviceId = '';
      this.pendingPin = '';
      if (deepPin.length > 0) {
        void this.handleConnect();
      }
    }
  }

  private ensureClient(): RemoteClient {
    if (this.client) return this.client;
    const c = new RemoteClient({
      onLog: (line: string) => {
        this.appendLog(line);
      },
      onStatus: (status: string, detail: string) => {
        if (status === 'reconnecting') {
          this.reconnectBanner = detail || '连接波动，正在自动重连...';
        } else if (status === 'connected') {
          this.reconnectBanner = '';
        } else if (status === 'disconnected') {
          this.reconnectBanner = '';
          this.connState = 'idle';
          this.errorMsg = detail || '连接已断开';
          this.pixelMap = null;
          this.videoActive = false;
          this.frameMeta = null;
          this.cursorShape = null;
          this.audioEnabled = false;
          this.privacyEnabled = false;
          void this.audioPlayer.stop();
          this.hudCollapsed = false;
          this.orientationMode = 'auto';
          WindowController.setOrientationMode('auto');
        }
      },
      onAuthenticated: (auth: AuthOkInfo) => {
        const wasConnected = this.connState === 'connected';
        this.reconnectBanner = '';
        this.connState = 'connected';
        this.sessionInfo = auth;
        this.displays = auth.displays;
        if (!wasConnected || !auth.displays.some((d) => d.id === this.activeDisplayId)) {
          this.activeDisplayId = auth.displays.length > 0 ? auth.displays[0].id : 0;
        }
        if (auth.displays.length > 0 && auth.displays[0].width > 0 && auth.displays[0].height > 0) {
          this.frameAspect = auth.displays[0].width / auth.displays[0].height;
        }
        this.errorMsg = '';
        if (!wasConnected) {
          this.ptyInitialized = false;
          this.fsInitialized = false;
          this.termOutput = '';
          this.fsEditingPath = '';
          this.hudCollapsed = false;

          if (this.effectiveTier() === 'phone' && auth.permissions.view) {
            this.orientationMode = 'landscape';
            WindowController.setOrientationMode('landscape');
          }
        }

        const preset = getPresetByKey(this.qualityKey);
        if (auth.permissions.view) {
          this.client?.startScreen(this.activeDisplayId, preset);
        }
        if (this.audioEnabled && auth.permissions.audio !== false) {
          this.client?.startAudio();
        }
        if (this.clipSync && auth.permissions.control !== false) {
          this.client?.setClipboardWatch(true);
        }
      },
      onTelemetry: (stats: TelemetryInfo) => {
        this.telemetry = stats;
      },
      onScreenPixelMap: (
        pm: image.PixelMap,
        cx: number,
        cy: number,
        aspect: number,
        meta: ScreenFrameMeta
      ) => {
        this.frameMeta = meta;
        this.pixelMap = pm;
        this.cursorX = cx;
        this.cursorY = cy;
        if (aspect > 0) {
          this.frameAspect = aspect;
        }
      },
      onVideoModeChange: (active: boolean, aspect: number) => {
        this.videoActive = active;
        if (aspect > 0) {
          this.frameAspect = aspect;
        }
      },
      onVideoGeometry: (cx: number, cy: number, aspect: number) => {
        this.cursorX = cx;
        this.cursorY = cy;
        if (aspect > 0) {
          this.frameAspect = aspect;
        }
      },
      onCursorShape: (shape: CursorShapeInfo) => {
        this.cursorShape = shape;
      },
      onAudioFrame: (sampleRate: number, channels: number, pcm: Uint8Array) => {
        this.audioPlayer.pushPcm(sampleRate, channels, pcm);
      },
      onPtyOpened: (_id: string, mode: string) => {
        this.termStatus = `running (${mode})`;
      },
      onPtyOutput: (_id: string, text: string) => {
        this.termOutput = stripAnsiChunk(this.termOutput, text);
      },
      onPtyExit: (_id: string, code: number) => {
        this.termStatus = `exited (${code})`;
      },
      onClipboardData: (text: string, imageBase64: string, auto: boolean) => {
        if (!text && !imageBase64) {
          if (!auto) this.showToast('远端剪贴板为空');
          return;
        }
        try {
          const pb = pasteboard.getSystemPasteboard();
          if (imageBase64.length > 0) {
            this.showToast(auto ? '远端复制了一张图片' : '远端剪贴板是一张图片');
            return;
          }
          const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
          pb.setData(data).then(() => {
            if (!auto) this.showToast('已同步远端剪贴板到本机');
          }).catch(() => {
            if (!auto) this.showToast('写入本机剪贴板失败');
          });
        } catch {
          if (!auto) this.showToast('读取系统剪贴板失败');
        }
      },
      onFsRoots: (roots: FileRoot[]) => {
        this.fsRoots = roots;
        if (roots.length > 0 && !this.fsCurrentPath) {
          this.fsLoading = true;
          this.client?.requestFsList(roots[0].path);
        }
      },
      onFsList: (dirPath: string, parentPath: string, items: FileItem[]) => {
        this.fsLoading = false;
        this.fsCurrentPath = dirPath;
        this.fsParentPath = parentPath;
        this.fsItems = items;
      },
      onFsReadText: (filePath: string, content: string, truncated: boolean) => {
        this.fsEditingPath = filePath;
        this.fsEditingContent = content;
        this.fsEditingTruncated = truncated;
      },
      onFsActionDone: (op: string, infoPath: string) => {
        if (op === 'write_text') {
          this.showToast('文件已保存');
          this.fsEditingPath = '';
        } else if (op === 'upload_done') {
          this.showToast(`上传完成: ${infoPath}`);
        }
        if (this.fsCurrentPath) {
          this.client?.requestFsList(this.fsCurrentPath);
        }
      },
      onFsDownloadReady: (fileName: string, bytes: Uint8Array) => {
        void this.saveDownloadedFile(fileName, bytes);
      },
      onFsError: (errMsg: string) => {
        this.fsLoading = false;
        this.showToast(`文件操作失败: ${errMsg}`);
      },
    });
    this.client = c;
    return c;
  }

  private async saveDownloadedFile(fileName: string, bytes: Uint8Array): Promise<void> {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const docPicker = new picker.DocumentViewPicker(ctx);
      const uris = await docPicker.save({ newFileNames: [fileName] });
      if (!uris || uris.length === 0) {
        this.showToast('已取消保存');
        return;
      }
      const f = fileIo.openSync(uris[0], fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, bytes.buffer);
      fileIo.closeSync(f);
      this.showToast(`已保存 ${fileName}`);
    } catch {
      this.showToast(`保存 ${fileName} 失败`);
    }
  }

  private mergeDeviceRecord(map: Map<string, RemoteDeviceInfo>, dev: RemoteDeviceInfo): void {
    if (!dev.deviceId) return;
    const prev = map.get(dev.deviceId);
    if (!prev) {
      map.set(dev.deviceId, dev);
      return;
    }
    const mergedEndpoints = dev.lanEndpoints.length >= prev.lanEndpoints.length ? dev.lanEndpoints : prev.lanEndpoints;
    map.set(dev.deviceId, {
      deviceId: dev.deviceId,
      deviceName: dev.deviceName || prev.deviceName,
      platform: dev.platform || prev.platform,
      online: dev.online || prev.online,
      displays: dev.displays.length > 0 ? dev.displays : prev.displays,
      lanEndpoints: mergedEndpoints,
      tunnelUrl: dev.tunnelUrl || prev.tunnelUrl,
    });
  }

  private async scanLan(): Promise<void> {
    this.scanningLan = true;
    try {
      const c = this.ensureClient();
      const urlsToProbe: string[] = [];
      const seenUrls: Set<string> = new Set();
      const addProbeUrl = (raw: string): void => {
        const u = raw.trim();
        if (u.length > 0 && !seenUrls.has(u)) {
          seenUrls.add(u);
          urlsToProbe.push(u);
        }
      };
      addProbeUrl(this.serverUrl);
      for (let i = 0; i < this.recentDevices.length; i++) {
        const rec = this.recentDevices[i];
        addProbeUrl(rec.serverUrl);
        if (rec.tunnelUrl) {
          addProbeUrl(rec.tunnelUrl);
        }
        if (rec.lanEndpoints) {
          for (let j = 0; j < rec.lanEndpoints.length; j++) {
            addProbeUrl(rec.lanEndpoints[j].httpUrl || rec.lanEndpoints[j].wsUrl);
          }
        }
      }

      const lanTask = c.discoverLanHosts(1200);
      const tsTask = c.discoverTsnetHosts();
      const httpTasks = urlsToProbe.map((u) => c.fetchDevices(u));
      const lanFound = await lanTask;
      const tsFound = await tsTask;
      const httpResults = await Promise.all(httpTasks);

      const mergedMap: Map<string, RemoteDeviceInfo> = new Map();
      const lanIds: Set<string> = new Set();
      for (let i = 0; i < lanFound.length; i++) {
        lanIds.add(lanFound[i].deviceId);
        this.mergeDeviceRecord(mergedMap, lanFound[i]);
      }
      for (let i = 0; i < tsFound.length; i++) {
        const dev = tsFound[i];
        if (!lanIds.has(dev.deviceId)) {
          // Keep Tailscale endpoints (and don't promote unreachable LAN IPs when outside LAN)
          const tsOnlyEps = dev.lanEndpoints.filter((ep) => ep.kind === 'tailscale');
          this.mergeDeviceRecord(mergedMap, {
            deviceId: dev.deviceId,
            deviceName: dev.deviceName,
            platform: dev.platform,
            online: dev.online,
            displays: dev.displays,
            lanEndpoints: tsOnlyEps,
            tunnelUrl: dev.tunnelUrl,
          });
        } else {
          this.mergeDeviceRecord(mergedMap, dev);
        }
      }
      for (let i = 0; i < httpResults.length; i++) {
        const arr = httpResults[i];
        const probeUrl = urlsToProbe[i];
        const isWanProbe = probeUrl.startsWith('https://') || probeUrl.startsWith('wss://');
        for (let j = 0; j < arr.length; j++) {
          if (arr[j].online) {
            const dev = arr[j];
            if (isWanProbe && !lanIds.has(dev.deviceId)) {
              // Discovered via WAN tunnel while LAN scan found nothing: keep tunnelUrl
              // primary and don't present unreachable private LAN IPs as active LAN hits.
              this.mergeDeviceRecord(mergedMap, {
                deviceId: dev.deviceId,
                deviceName: dev.deviceName,
                platform: dev.platform,
                online: dev.online,
                displays: dev.displays,
                lanEndpoints: [],
                tunnelUrl: dev.tunnelUrl || toHttpBase(probeUrl),
              });
            } else {
              this.mergeDeviceRecord(mergedMap, dev);
            }
          }
        }
      }

      const nextList: RemoteDeviceInfo[] = [];
      mergedMap.forEach((v) => nextList.push(v));
      this.onlineDevices = nextList;

      if (lanFound.length > 0 && !this.serverUrl.trim() && lanFound[0].lanEndpoints.length > 0) {
        this.mode = 'direct';
        this.serverUrl = lanFound[0].lanEndpoints[0].httpUrl || lanFound[0].lanEndpoints[0].wsUrl;
        this.deviceId = lanFound[0].deviceId;
      } else if (nextList.length > 0 && !this.serverUrl.trim() && nextList[0].tunnelUrl) {
        this.mode = 'direct';
        this.serverUrl = nextList[0].tunnelUrl;
        this.deviceId = nextList[0].deviceId;
      }
    } finally {
      this.scanningLan = false;
    }
  }

  private async refreshRelayDevices(): Promise<void> {
    if (!this.serverUrl.trim()) {
      this.showToast('请先填写中继服务器或主机地址');
      return;
    }
    const list = await this.ensureClient().fetchDevices(this.serverUrl);
    this.onlineDevices = list;
    if (list.length === 1 && !this.deviceId.trim()) {
      this.deviceId = list[0].deviceId;
    }
  }

  private looksLikeAddress(input: string): boolean {
    const s = input.trim().toLowerCase();
    if (!s) return false;
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ws://') || s.startsWith('wss://')) {
      return true;
    }
    if (s.includes('.') || s.includes(':')) {
      return true;
    }
    return false;
  }

  private async handleConnect(): Promise<void> {
    const rawId = this.deviceId.trim();
    let effPin = this.pin.trim();
    let effMode = this.mode;
    let effServer = this.serverUrl.trim();
    let effDeviceId = rawId;
    let extraEndpoints: LanEndpoint[] = [];
    let fallbackTunnelUrl: string = '';

    if (this.looksLikeAddress(rawId)) {
      const parsed = parseConnectUrl(rawId);
      if (parsed) {
        effMode = parsed.mode;
        effServer = parsed.serverUrl;
        effDeviceId = parsed.deviceId;
        if (!effPin && parsed.pin) {
          effPin = parsed.pin;
          this.pin = effPin;
        }
      } else {
        effMode = 'direct';
        effServer = rawId;
        effDeviceId = '';
      }
    }

    if (!effPin) {
      this.errorMsg = '请输入访问配对码 (PIN)';
      return;
    }

    if (!this.looksLikeAddress(rawId) && effDeviceId.length > 0) {
      // Match against discovered online devices first (LAN or Tunnel)
      for (let i = 0; i < this.onlineDevices.length; i++) {
        const dev = this.onlineDevices[i];
        if (dev.deviceId === effDeviceId) {
          if (dev.tunnelUrl && dev.tunnelUrl.length > 0) {
            fallbackTunnelUrl = dev.tunnelUrl;
          }
          if (dev.lanEndpoints.length > 0) {
            effMode = 'direct';
            effServer = dev.lanEndpoints[0].httpUrl || dev.lanEndpoints[0].wsUrl;
            extraEndpoints = dev.lanEndpoints;
          } else if (dev.tunnelUrl && dev.tunnelUrl.length > 0) {
            effMode = 'direct';
            effServer = dev.tunnelUrl;
          }
          break;
        }
      }
      // If still no server/endpoint, try matching recent devices or quick LAN scan
      if (extraEndpoints.length === 0 && !fallbackTunnelUrl) {
        const found = await this.ensureClient().discoverLanHosts(900);
        for (let i = 0; i < found.length; i++) {
          if (found[i].deviceId === effDeviceId) {
            if (found[i].tunnelUrl && found[i].tunnelUrl.length > 0) {
              fallbackTunnelUrl = found[i].tunnelUrl;
            }
            if (found[i].lanEndpoints.length > 0) {
              effMode = 'direct';
              effServer = found[i].lanEndpoints[0].httpUrl || found[i].lanEndpoints[0].wsUrl;
              extraEndpoints = found[i].lanEndpoints;
              break;
            }
          }
        }
      }
      for (let i = 0; i < this.recentDevices.length; i++) {
        const r = this.recentDevices[i];
        if (r.deviceId === effDeviceId) {
          if (!fallbackTunnelUrl && r.tunnelUrl && r.tunnelUrl.trim().length > 0) {
            fallbackTunnelUrl = r.tunnelUrl.trim();
          }
          if (extraEndpoints.length === 0 && r.lanEndpoints && r.lanEndpoints.length > 0) {
            extraEndpoints = r.lanEndpoints;
          }
          if (!effServer && r.serverUrl.trim().length > 0) {
            effMode = r.mode || 'direct';
            effServer = r.serverUrl.trim();
          }
          break;
        }
      }
      if (!effServer && fallbackTunnelUrl.length > 0) {
        effMode = 'direct';
        effServer = fallbackTunnelUrl;
      }
    }

    if (!effServer) {
      this.errorMsg = '未发现该设备：若已离开电脑所在 Wi-Fi，请用「扫一扫直连」扫描电脑上的外网二维码，或填入外网/中继地址';
      return;
    }
    if (effMode === 'relay' && !effDeviceId) {
      this.errorMsg = '请输入远程设备 ID';
      return;
    }

    this.connState = 'connecting';
    this.errorMsg = '';
    this.logs = [];
    this.qualityKey = 'auto';

    try {
      const c = this.ensureClient();
      const targetWs = toWsUrl(effServer);
      if (extraEndpoints.length === 0) {
        for (let i = 0; i < this.onlineDevices.length; i++) {
          const dev = this.onlineDevices[i];
          const matchId = effDeviceId.length > 0 && dev.deviceId === effDeviceId;
          const matchUrl = dev.lanEndpoints.some((ep) => ep.wsUrl === targetWs);
          if (matchId || matchUrl) {
            extraEndpoints = dev.lanEndpoints;
            if (!fallbackTunnelUrl && dev.tunnelUrl) {
              fallbackTunnelUrl = dev.tunnelUrl;
            }
            break;
          }
        }
      }
      await c.connect(effMode, effServer, effDeviceId, effPin, extraEndpoints, fallbackTunnelUrl);
      const finalLanEps = (this.sessionInfo?.lanEndpoints && this.sessionInfo.lanEndpoints.length > 0)
        ? this.sessionInfo.lanEndpoints
        : extraEndpoints;
      const finalTunnelUrl = this.sessionInfo?.tunnelUrl
        || fallbackTunnelUrl
        || (effServer.startsWith('https://') || effServer.startsWith('wss://') ? toHttpBase(effServer) : '');
      const primaryLanUrl = finalLanEps.length > 0
        ? (finalLanEps[0].httpUrl || finalLanEps[0].wsUrl)
        : '';
      const savedServerUrl = effMode === 'relay'
        ? effServer
        : (primaryLanUrl || effServer);
      this.recentDevices = await RecentStore.getInstance().saveRecent({
        mode: effMode,
        serverUrl: savedServerUrl,
        deviceId: this.sessionInfo?.deviceId || effDeviceId || 'DIRECT',
        deviceName: this.sessionInfo?.deviceName || effDeviceId || effServer,
        pin: effPin,
        tunnelUrl: finalTunnelUrl,
        lanEndpoints: finalLanEps,
        updatedAt: Date.now(),
      });
    } catch (err) {
      const e = err as Error;
      this.connState = 'idle';
      this.errorMsg = e?.message || '连接失败';
    }
  }

  private handleDisconnect(): void {
    this.pixelMap = null;
    this.videoActive = false;
    this.frameMeta = null;
    this.reconnectBanner = '';
    this.audioEnabled = false;
    this.privacyEnabled = false;
    void this.audioPlayer.stop();
    this.connState = 'idle';
    this.sessionInfo = null;
    this.activeTab = 'screen';
    this.hudCollapsed = false;
    this.orientationMode = 'auto';
    WindowController.setOrientationMode('auto');
    this.client?.disconnect(true);
  }

  private async toggleAudio(): Promise<void> {
    if (!this.audioEnabled) {
      const ok = await this.audioPlayer.start(48000, 2);
      if (!ok) {
        this.showToast('当前设备音频初始化失败');
        return;
      }
      this.audioEnabled = true;
      this.client?.startAudio();
      this.showToast('已开启远端系统声音');
    } else {
      this.audioEnabled = false;
      this.client?.stopAudio();
      await this.audioPlayer.stop();
      this.showToast('已静音远端声音');
    }
  }

  private toggleClipSync(): void {
    const next = !this.clipSync;
    this.clipSync = next;
    this.client?.setClipboardWatch(next);
    this.showToast(next ? '已开启剪贴板自动同步' : '已关闭剪贴板自动同步');
  }

  private togglePrivacy(): void {    const next = !this.privacyEnabled;
    this.privacyEnabled = next;
    this.client?.setPrivacy(next);
    this.showToast(next ? '已开启被控端防窥黑屏' : '已关闭被控端防窥黑屏');
  }

  private toggleOrientation(): void {
    const next = this.isLandscape ? 'portrait' : 'landscape';
    this.orientationMode = next;
    WindowController.setOrientationMode(next);
    this.showToast(next === 'landscape' ? '已切换横屏沉浸模式' : '已切换竖屏模式');
  }

  private openTab(tab: string): void {
    this.activeTab = tab;
    if ((tab === 'terminal' || tab === 'split') && !this.ptyInitialized) {
      this.ptyInitialized = true;
      this.termStatus = 'opening';
      this.client?.openPty(this.termId, 'powershell', this.effectiveTier() === 'phone' ? 56 : 110, 26);
    }
    if (tab === 'files' && !this.fsInitialized) {
      this.fsInitialized = true;
      this.fsLoading = true;
      this.fsCurrentPath = '';
      this.client?.requestFsRoots();
    }
  }

  private restartShell(shell: string): void {
    this.termOutput = '';
    this.termStatus = 'opening';
    this.client?.closePty(this.termId);
    this.termId = `term-${Date.now()}`;
    this.client?.openPty(this.termId, shell, this.effectiveTier() === 'phone' ? 56 : 110, 26);
  }

  private async syncClipboard(): Promise<void> {
    try {
      const pb = pasteboard.getSystemPasteboard();
      const data = await pb.getData();
      const txt = data?.getPrimaryText() || '';
      if (txt.length > 0) {
        const msg: OutMsgClipboardSet = { type: MsgType.CLIPBOARD_SET, text: txt };
        this.client?.sendJson(msg);
        this.showToast('已推送本机剪贴板到远端');
        return;
      }
    } catch {
      // Fall back to pulling remote clipboard
    }
    const getMsg: OutMsgSimple = { type: MsgType.CLIPBOARD_GET };
    this.client?.sendJson(getMsg);
  }

  private cycleQuality(): void {
    let idx = 0;
    for (let i = 0; i < QUALITY_PRESETS.length; i++) {
      if (QUALITY_PRESETS[i].key === this.qualityKey) {
        idx = i;
        break;
      }
    }
    const next: QualityPreset = QUALITY_PRESETS[(idx + 1) % QUALITY_PRESETS.length];
    this.qualityKey = next.key;
    this.client?.configScreen(this.activeDisplayId, next);
    this.showToast(`画质已切换: ${next.label}`);
  }

  private cycleDisplay(): void {
    if (this.displays.length <= 1) return;
    let idx = 0;
    for (let i = 0; i < this.displays.length; i++) {
      if (this.displays[i].id === this.activeDisplayId) {
        idx = i;
        break;
      }
    }
    const next = this.displays[(idx + 1) % this.displays.length];
    this.activeDisplayId = next.id;
    this.client?.configScreen(next.id, getPresetByKey(this.qualityKey));
    this.showToast(`已切换屏幕 ${idx + 1}`);
  }

  private cycleLayoutOverride(): void {
    const order = ['auto', 'phone', 'tablet', 'desktop'];
    const idx = order.indexOf(this.layoutOverride);
    this.layoutOverride = order[(idx + 1) % order.length];
    this.showToast(`视图模式: ${this.layoutOverride.toUpperCase()}`);
  }

  @Builder
  private buildConnectHeader() {
    Row({ space: 10 }) {
      Column({ space: 2 }) {
        Row({ space: 8 }) {
          Text('RemoteDeck')
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor('#EEF2F9')
          if (this.tsnetStatus.tailscaleIp.length > 0) {
            Text('P2P已组网')
              .fontSize(10)
              .fontColor('#10B981')
              .backgroundColor('#0E2A24')
              .padding({ left: 7, right: 7, top: 2, bottom: 2 })
              .borderRadius(8)
          }
        }
        Text('跨平台 P2P 组网 · 内外网自适应远控')
          .fontSize(11)
          .fontColor('#8A9BB8')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Button(`${this.effectiveTier().toUpperCase()} (${this.layoutOverride === 'auto' ? '自动' : '手动'})`)
        .height(30)
        .fontSize(11)
        .backgroundColor('#162032')
        .fontColor('#38BDF8')
        .borderRadius(15)
        .border({ width: 1, color: '#22314C' })
        .onClick(() => {
          this.cycleLayoutOverride();
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 14, bottom: 10 })
    .backgroundColor('#080C14')
  }

  @Builder
  private buildHudActionButtons(compact: boolean) {
    Button('桌面')
      .height(compact ? 26 : 30)
      .fontSize(compact ? 11 : 12)
      .backgroundColor(this.activeTab === 'screen' ? '#1E3A5F' : '#1A2232')
      .fontColor(this.activeTab === 'screen' ? '#38BDF8' : '#E2E8F0')
      .borderRadius(6)
      .onClick(() => { this.openTab('screen'); })

    if (this.sessionInfo?.permissions.terminal !== false) {
      Button('终端')
        .height(compact ? 26 : 30)
        .fontSize(compact ? 11 : 12)
        .backgroundColor(this.activeTab === 'terminal' ? '#1E3A5F' : '#1A2232')
        .fontColor(this.activeTab === 'terminal' ? '#38BDF8' : '#E2E8F0')
        .borderRadius(6)
        .onClick(() => { this.openTab('terminal'); })
    }

    if (this.sessionInfo?.permissions.files !== false) {
      Button('文件')
        .height(compact ? 26 : 30)
        .fontSize(compact ? 11 : 12)
        .backgroundColor(this.activeTab === 'files' ? '#1E3A5F' : '#1A2232')
        .fontColor(this.activeTab === 'files' ? '#38BDF8' : '#E2E8F0')
        .borderRadius(6)
        .onClick(() => { this.openTab('files'); })
    }

    if (this.effectiveTier() === 'desktop' && this.sessionInfo?.permissions.terminal !== false) {
      Button('分屏')
        .height(compact ? 26 : 30)
        .fontSize(compact ? 11 : 12)
        .backgroundColor(this.activeTab === 'split' ? '#1E3A5F' : '#1A2232')
        .fontColor(this.activeTab === 'split' ? '#38BDF8' : '#E2E8F0')
        .borderRadius(6)
        .onClick(() => { this.openTab('split'); })
    }

    Button(`画质:${getPresetByKey(this.qualityKey).label}`)
      .height(compact ? 26 : 30)
      .fontSize(compact ? 11 : 12)
      .backgroundColor('#1A2232')
      .fontColor('#E2E8F0')
      .borderRadius(6)
      .onClick(() => { this.cycleQuality(); })

    if (this.displays.length > 1) {
      Button(`屏幕${this.activeDisplayId + 1}`)
        .height(compact ? 26 : 30)
        .fontSize(compact ? 11 : 12)
        .backgroundColor('#1A2232')
        .fontColor('#E2E8F0')
        .borderRadius(6)
        .onClick(() => { this.cycleDisplay(); })
    }

    Button('剪贴板')
      .height(compact ? 26 : 30)
      .fontSize(compact ? 11 : 12)
      .backgroundColor('#1A2232')
      .fontColor('#E2E8F0')
      .borderRadius(6)
      .onClick(() => { void this.syncClipboard(); })

    if (this.sessionInfo?.permissions.control !== false) {
      Button(this.clipSync ? '剪贴同步中' : '剪贴同步')
        .height(compact ? 26 : 30)
        .fontSize(compact ? 11 : 12)
        .backgroundColor(this.clipSync ? '#1E3A5F' : '#1A2232')
        .fontColor(this.clipSync ? '#38BDF8' : '#E2E8F0')
        .borderRadius(6)
        .onClick(() => { this.toggleClipSync(); })
    }

    if (this.sessionInfo?.permissions.audio !== false) {
      Button(this.audioEnabled ? '声音开' : '声音')
        .height(compact ? 26 : 30)
        .fontSize(compact ? 11 : 12)
        .backgroundColor(this.audioEnabled ? '#1E3A5F' : '#1A2232')
        .fontColor(this.audioEnabled ? '#38BDF8' : '#E2E8F0')
        .borderRadius(6)
        .onClick(() => { void this.toggleAudio(); })
    }

    if (this.sessionInfo?.permissions.control !== false) {
      Button(this.privacyEnabled ? '防窥中' : '防窥')
        .height(compact ? 26 : 30)
        .fontSize(compact ? 11 : 12)
        .backgroundColor(this.privacyEnabled ? '#1E3A5F' : '#1A2232')
        .fontColor(this.privacyEnabled ? '#38BDF8' : '#E2E8F0')
        .borderRadius(6)
        .onClick(() => { this.togglePrivacy(); })
    }

    Button(this.isLandscape ? '竖屏' : '横屏')
      .height(compact ? 26 : 30)
      .fontSize(compact ? 11 : 12)
      .backgroundColor('#1E3A5F')
      .fontColor('#38BDF8')
      .borderRadius(6)
      .onClick(() => { this.toggleOrientation(); })

    if (this.activeTab === 'screen') {
      Button('沉浸')
        .height(compact ? 26 : 30)
        .fontSize(compact ? 11 : 12)
        .backgroundColor('#1A2232')
        .fontColor('#34D399')
        .borderRadius(6)
        .onClick(() => { this.hudCollapsed = true; })
    }
  }

  private formatChannelLabel(ch: string): string {
    if (ch === 'tailscale') return 'P2P组网';
    if (ch === 'tunnel') return '外网隧道';
    if (ch === 'relay') return '中继';
    return '局域网';
  }

  @Builder
  private buildWorkspaceHud() {
    if (this.effectiveTier() === 'phone' && this.isLandscape) {
      Row({ space: 6 }) {
        Circle({ width: 7, height: 7 })
          .fill('#34D399')
        Text(`${this.telemetry.rttMs > 0 ? `${this.telemetry.rttMs}ms` : '--'}·${this.telemetry.fps}fps`)
          .fontSize(10)
          .fontColor('#34D399')
          .backgroundColor('#112D28')
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .borderRadius(8)

        Scroll() {
          Row({ space: 5 }) {
            this.buildHudActionButtons(true)
          }
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .layoutWeight(1)

        Button('断开')
          .height(26)
          .fontSize(11)
          .backgroundColor('#451A22')
          .fontColor('#FCA5A5')
          .borderRadius(6)
          .onClick(() => {
            this.handleDisconnect();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 4, bottom: 4 })
      .backgroundColor('#121824')
      .border({ width: { bottom: 1 }, color: '#253147' })
    } else {
      Column({ space: 6 }) {
        Row({ space: 8 }) {
          Circle({ width: 8, height: 8 })
            .fill('#34D399')
          Text(this.sessionInfo?.deviceName || this.sessionInfo?.deviceId || '已连接')
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .fontColor('#E2E8F0')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)

          Text(
            `${this.formatChannelLabel(this.telemetry.channel || 'lan')} · ${this.telemetry.rttMs > 0 ? `${this.telemetry.rttMs}ms` : '--'} · ${this.telemetry.fps}fps`
          )
            .fontSize(11)
            .fontColor('#34D399')
            .backgroundColor('#112D28')
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .borderRadius(10)

          Button('断开')
            .height(28)
            .fontSize(11)
            .backgroundColor('#451A22')
            .fontColor('#FCA5A5')
            .borderRadius(6)
            .onClick(() => {
              this.handleDisconnect();
            })
        }
        .width('100%')

        Scroll() {
          Row({ space: 6 }) {
            this.buildHudActionButtons(false)
          }
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .width('100%')
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .backgroundColor('#121824')
      .border({ width: { bottom: 1 }, color: '#253147' })
    }
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Column() {
        if (this.connState !== 'connected') {
          this.buildConnectHeader()
          Column() {
            ConnectPane({
              tier: this.effectiveTier(),
              connecting: this.connState === 'connecting',
              errorMsg: this.errorMsg,
              logs: this.logs,
              onlineDevices: this.onlineDevices,
              recentDevices: this.recentDevices,
              scanningLan: this.scanningLan,
              tsnetStatus: this.tsnetStatus,
              phoneShareStatus: this.phoneShareStatus,
              mode: $mode,
              serverUrl: $serverUrl,
              deviceId: $deviceId,
              pin: $pin,
              onSubmitConnect: () => { void this.handleConnect(); },
              onRefreshRelay: () => { void this.refreshRelayDevices(); },
              onScanLan: () => { void this.scanLan(); },
              onToggleTsnet: (enabled: boolean, authKey: string) => { void this.handleToggleTsnet(enabled, authKey); },
              onLogoutTsnet: () => { void this.handleLogoutTsnet(); },
              onTogglePhoneShare: (enabled: boolean) => { this.handleTogglePhoneShare(enabled); },
              onToast: (msg: string) => { this.showToast(msg); },
            })
          }
          .layoutWeight(1)
          .width('100%')
        } else {
          if (!this.hudCollapsed || this.activeTab !== 'screen') {
            this.buildWorkspaceHud()
          }
          Column() {
            if (this.activeTab === 'split' && this.effectiveTier() === 'desktop') {
              Row() {
                Column() {
                  ScreenPane({
                    tier: this.effectiveTier(),
                    isLandscape: this.isLandscape,
                    compactChrome: false,
                    frameAspect: this.frameAspect,
                    videoActive: this.videoActive,
                    pixelMap: $pixelMap,
                    frameMeta: $frameMeta,
                    cursorX: this.cursorX,
                    cursorY: this.cursorY,
                    cursorShape: this.cursorShape,
                    canControl: this.sessionInfo?.permissions.control !== false,
                    audioEnabled: this.audioEnabled,
                    client: this.client,
                    onExitImmersive: () => { this.hudCollapsed = false; },
                    onToggleAudio: () => { void this.toggleAudio(); },
                    onDisconnect: () => { this.handleDisconnect(); },
                    onZoomLevel: (z: number) => { this.handleZoomLevel(z); },
                  })
                }
                .layoutWeight(3)
                .height('100%')

                Column() {
                  TerminalPane({
                    tier: this.effectiveTier(),
                    termId: this.termId,
                    termStatus: this.termStatus,
                    output: this.termOutput,
                    client: this.client,
                    onRestartShell: (sh: string) => { this.restartShell(sh); },
                    onClearOutput: () => { this.termOutput = ''; },
                  })
                }
                .layoutWeight(2)
                .height('100%')
                .border({ width: { left: 1 }, color: '#253147' })
              }
              .width('100%')
              .height('100%')
            } else if (this.activeTab === 'terminal') {
              TerminalPane({
                tier: this.effectiveTier(),
                termId: this.termId,
                termStatus: this.termStatus,
                output: this.termOutput,
                client: this.client,
                onRestartShell: (sh: string) => { this.restartShell(sh); },
                onClearOutput: () => { this.termOutput = ''; },
              })
            } else if (this.activeTab === 'files') {
              FilePane({
                roots: this.fsRoots,
                currentPath: this.fsCurrentPath,
                parentPath: this.fsParentPath,
                items: this.fsItems,
                loading: this.fsLoading,
                editingPath: this.fsEditingPath,
                editingContent: this.fsEditingContent,
                editingTruncated: this.fsEditingTruncated,
                client: this.client,
                onCloseEditor: () => { this.fsEditingPath = ''; },
                onToast: (msg: string) => { this.showToast(msg); },
              })
            } else {
              ScreenPane({
                tier: this.effectiveTier(),
                isLandscape: this.isLandscape,
                compactChrome: this.hudCollapsed,
                frameAspect: this.frameAspect,
                videoActive: this.videoActive,
                pixelMap: $pixelMap,
                frameMeta: $frameMeta,
                cursorX: this.cursorX,
                cursorY: this.cursorY,
                cursorShape: this.cursorShape,
                canControl: this.sessionInfo?.permissions.control !== false,
                audioEnabled: this.audioEnabled,
                client: this.client,
                onExitImmersive: () => { this.hudCollapsed = false; },
                onToggleAudio: () => { void this.toggleAudio(); },
                onDisconnect: () => { this.handleDisconnect(); },
                    onZoomLevel: (z: number) => { this.handleZoomLevel(z); },
              })
            }
          }
          .width('100%')
          .layoutWeight(1)
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#080C14')

      if (this.reconnectBanner.length > 0) {
        Text(this.reconnectBanner)
          .fontSize(12)
          .fontColor('#FDE68A')
          .backgroundColor('#78350F')
          .padding({ left: 14, right: 14, top: 8, bottom: 8 })
          .borderRadius(20)
          .border({ width: 1, color: '#F59E0B' })
          .margin({ top: 14 })
      } else if (this.toast.length > 0) {
        Text(this.toast)
          .fontSize(12)
          .fontColor('#E2E8F0')
          .backgroundColor('#1E293B')
          .padding({ left: 14, right: 14, top: 8, bottom: 8 })
          .borderRadius(20)
          .border({ width: 1, color: '#38BDF8' })
          .margin({ top: 14 })
      }
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      const w = Number(newArea.width);
      const h = Number(newArea.height);
      this.isLandscape = w > h;
      const minDim = Math.min(w, h);
      if (minDim < 520) {
        this.detectedTier = 'phone';
      } else if (w >= 900) {
        this.detectedTier = 'desktop';
      } else {
        this.detectedTier = 'tablet';
      }
    })
  }
}
