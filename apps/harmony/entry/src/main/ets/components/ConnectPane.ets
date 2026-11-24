import { Want, common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { preferences } from '@kit.ArkData';
import { scanBarcode } from '@kit.ScanKit';
import {
  PhoneShareStatus,
  RecentDeviceItem,
  RemoteDeviceInfo,
  emptyPhoneShareStatus,
  parseConnectUrl,
} from '../protocol/Protocol';
import { TsnetPeer, TsnetStatus, emptyTsnetStatus } from '../protocol/TsnetClient';
import { AccountPane } from './AccountPane';
import { http } from '@kit.NetworkKit';

interface AcctDevice {
  deviceId?: string;
  name?: string;
  online?: boolean;
}

interface AcctListResult {
  ok?: boolean;
  devices?: AcctDevice[];
}

@Component
export struct ConnectPane {
  @Prop tier: string = 'phone';
  @Prop connecting: boolean = false;
  @Prop errorMsg: string = '';
  @Prop logs: string[] = [];
  @Prop onlineDevices: RemoteDeviceInfo[] = [];
  @Prop recentDevices: RecentDeviceItem[] = [];
  @Prop scanningLan: boolean = false;
  @State myCode: string = '';
  @State myPin: string = '';
  @State pinDraft: string = '';
  @State editingPin: boolean = false;
  @State acctDevices: AcctDevice[] = [];
  @Prop tsnetStatus: TsnetStatus = emptyTsnetStatus();
  @Prop phoneShareStatus: PhoneShareStatus = emptyPhoneShareStatus();

  @Link mode: string;
  @Link serverUrl: string;
  @Link deviceId: string;
  @Link pin: string;

  onSubmitConnect: () => void = () => {};
  onRefreshRelay: () => void = () => {};
  onScanLan: () => void = () => {};
  onToggleTsnet: (enabled: boolean, authKey: string) => void = () => {};
  onLogoutTsnet: () => void = () => {};
  onTogglePhoneShare: (enabled: boolean) => void = () => {};
  onToast: (msg: string) => void = () => {};

  @State promptDevice: RemoteDeviceInfo | null = null;
  @State promptPin: string = '';
  @State showAdvancedServer: boolean = false;
  @State tsnetAuthKeyInput: string = '';
  @State showTsnetCard: boolean = false;
  @State phoneSubTab: string = 'connect'; // 'connect' | 'devices' | 'mesh'

  private formatDeviceChannelHints(dev: RemoteDeviceInfo): string {
    const tags: string[] = [];
    const hasLan = dev.lanEndpoints.some((ep) => ep.kind === 'lan');
    const hasMesh = dev.lanEndpoints.some((ep) => ep.kind === 'tailscale');
    if (hasLan) tags.push('局域网');
    if (hasMesh) tags.push('组网');
    if (dev.tunnelUrl && dev.tunnelUrl.length > 0) tags.push('外网可用');
    return tags.length > 0 ? tags.join(' · ') : '在线';
  }

  private async loadIdentity(): Promise<void> {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const store = await preferences.getPreferences(ctx, 'remotedeck_account');
      const code = (await store.get('phone_device_id', '')) as string;
      let pin = (await store.get('phone_pin', '')) as string;
      if (pin.length === 0) {
        pin = '';
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        for (let i = 0; i < 8; i++) pin += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        await store.put('phone_pin', pin);
        await store.flush();
      }
      this.myCode = code.length > 0 ? code : '未登录';
      this.myPin = pin;
      this.pinDraft = pin;
    } catch {
      this.myCode = this.myCode.length > 0 ? this.myCode : '未登录';
    }
  }

  private async savePin(): Promise<void> {
    const next = this.pinDraft.trim().toUpperCase();
    if (next.length < 6) {
      this.onToast('验证码至少 6 位');
      return;
    }
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const store = await preferences.getPreferences(ctx, 'remotedeck_account');
      await store.put('phone_pin', next);
      await store.flush();
      this.myPin = next;
      this.editingPin = false;
      this.onToast('验证码已更新');
    } catch {
      this.onToast('保存失败');
    }
  }

  aboutToAppear(): void {
    void this.loadIdentity();
    void this.loadAccountDevices();
  }

  private async loadAccountDevices(): Promise<void> {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const store = await preferences.getPreferences(ctx, 'remotedeck_account');
      const token = (await store.get('token', '')) as string;
      if (token.length === 0) {
        this.acctDevices = [];
        return;
      }
      const req = http.createHttp();
      try {
        const res = await req.request('https://miaosizhineng.online/api/auth/devices', {
          method: http.RequestMethod.GET,
          header: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          connectTimeout: 10000,
          readTimeout: 10000,
        });
        const text = typeof res.result === 'string' ? res.result : '';
        const parsed = JSON.parse(text) as AcctListResult;
        if (parsed.ok === true) this.acctDevices = parsed.devices ?? [];
      } finally {
        req.destroy();
      }
    } catch {
      // Keep whatever list we had.
    }
  }

  @Builder
  private buildSelfCard() {
    Column({ space: 14 }) {
      Row({ space: 8 }) {
        Text('本机')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor('#EEF2F9')
          .fontFamily('HarmonyOS Sans')
          .layoutWeight(1)
        Text('复制代码')
          .fontSize(12)
          .fontColor('#38BDF8')
          .onClick(() => {
            const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.myCode);
            pasteboard.getSystemPasteboard().setData(data).then(() => this.onToast('已复制'));
          })
      }
      .width('100%')

      Column({ space: 6 }) {
        Text('设备代码')
          .fontSize(12)
          .fontColor('#8A9BB8')
        Text(this.myCode)
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor('#EEF2F9')
          .fontFamily('HarmonyOS Sans')
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')

      Column({ space: 6 }) {
        Row({ space: 6 }) {
          Text('验证码')
            .fontSize(12)
            .fontColor('#8A9BB8')
            .layoutWeight(1)
          if (!this.editingPin) {
            Text('自定义')
              .fontSize(12)
              .fontColor('#38BDF8')
              .onClick(() => {
                this.pinDraft = this.myPin;
                this.editingPin = true;
              })
          }
        }
        .width('100%')

        if (this.editingPin) {
          Row({ space: 8 }) {
            TextInput({ text: this.pinDraft, placeholder: '6-12 位' })
              .height(42)
              .layoutWeight(1)
              .fontSize(16)
              .fontColor('#EEF2F9')
              .placeholderColor('#566B88')
              .backgroundColor('#080C14')
              .borderRadius(10)
              .border({ width: 1, color: '#22314C' })
              .padding({ left: 14, right: 14 })
              .onChange((v: string) => { this.pinDraft = v.toUpperCase(); })
            Button('保存')
              .height(42)
              .width(72)
              .fontSize(13)
              .fontColor('#FFFFFF')
              .backgroundColor('#2563EB')
              .borderRadius(10)
              .onClick(() => { void this.savePin(); })
          }
          .width('100%')
        } else {
          Text(this.myPin)
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
            .fontColor('#EEF2F9')
            .fontFamily('HarmonyOS Sans')
        }
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
    }
    .width('100%')
    .padding(18)
    .backgroundColor('#0F1623')
    .borderRadius(16)
    .border({ width: 1, color: '#22314C' })
    .alignItems(HorizontalAlign.Start)
  }


  private openExternalUrl(url: string): void {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const want: Want = {
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: url,
      };
      ctx.startAbility(want).catch(() => {
        this.onToast('无法拉起系统浏览器，请点击复制链接后在浏览器打开');
      });
    } catch {
      this.onToast('无法拉起系统浏览器，请点击复制链接');
    }
  }

  private copyUrlToClipboard(url: string, label: string): void {
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, url);
      pasteboard.getSystemPasteboard().setData(data).then(() => {
        this.onToast(`已复制${label}`);
      }).catch(() => {
        this.onToast('复制失败');
      });
    } catch {
      this.onToast('复制失败');
    }
  }

  private findSavedPin(targetDeviceId: string): string {
    if (this.deviceId.trim() === targetDeviceId && this.pin.trim().length > 0) {
      return this.pin.trim();
    }
    for (let i = 0; i < this.recentDevices.length; i++) {
      const r = this.recentDevices[i];
      if (r.deviceId === targetDeviceId && r.pin && r.pin.length > 0) {
        return r.pin;
      }
    }
    return '';
  }

  private isDeviceOnline(targetDeviceId: string): boolean {
    for (let i = 0; i < this.onlineDevices.length; i++) {
      if (this.onlineDevices[i].deviceId === targetDeviceId && this.onlineDevices[i].online) {
        return true;
      }
    }
    return false;
  }

  private connectAccountDevice(id: string): void {
    const match = this.onlineDevices.find((d) => d.deviceId === id);
    if (match) {
      this.quickRemoteDevice(match);
      return;
    }
    this.deviceId = id;
    this.promptDevice = {
      deviceId: id,
      deviceName: id,
      platform: '',
      online: true,
      displays: [],
      lanEndpoints: [],
      tunnelUrl: '',
    };
    this.promptPin = this.findSavedPin(id);
  }

  private quickRemoteDevice(dev: RemoteDeviceInfo): void {
    this.deviceId = dev.deviceId;
    if (dev.lanEndpoints.length > 0) {
      this.mode = 'direct';
      this.serverUrl = dev.lanEndpoints[0].httpUrl || dev.lanEndpoints[0].wsUrl;
    } else if (dev.tunnelUrl && dev.tunnelUrl.length > 0) {
      this.mode = 'direct';
      this.serverUrl = dev.tunnelUrl;
    }
    const savedPin = this.findSavedPin(dev.deviceId);
    if (savedPin.length > 0) {
      this.pin = savedPin;
      this.onToast(`正在连接 ${dev.deviceName || dev.deviceId}...`);
      this.onSubmitConnect();
      return;
    }
    this.promptDevice = dev;
    this.promptPin = this.pin;
  }

  private quickRemoteRecent(item: RecentDeviceItem): void {
    this.mode = item.mode;
    this.serverUrl = item.serverUrl || item.tunnelUrl || '';
    this.deviceId = item.deviceId;
    for (let i = 0; i < this.onlineDevices.length; i++) {
      const d = this.onlineDevices[i];
      if (d.deviceId === item.deviceId) {
        if (d.lanEndpoints.length > 0) {
          this.mode = 'direct';
          this.serverUrl = d.lanEndpoints[0].httpUrl || d.lanEndpoints[0].wsUrl;
        } else if (d.tunnelUrl && d.tunnelUrl.length > 0) {
          this.mode = 'direct';
          this.serverUrl = d.tunnelUrl;
        }
        break;
      }
    }
    if (item.pin && item.pin.length > 0) {
      this.pin = item.pin;
      this.onToast(`正在连接 ${item.deviceName || item.deviceId}...`);
      this.onSubmitConnect();
      return;
    }
    this.promptDevice = {
      deviceId: item.deviceId,
      deviceName: item.deviceName || item.deviceId,
      platform: 'win32',
      online: this.isDeviceOnline(item.deviceId),
      displays: [],
      lanEndpoints: item.lanEndpoints || [],
      tunnelUrl: item.tunnelUrl || '',
    };
    this.promptPin = this.pin;
  }

  private async handleScanQr(): Promise<void> {
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const result = await scanBarcode.startScanForResult(ctx);
      const raw = result?.originalValue || '';
      if (!raw) return;
      const parsed = parseConnectUrl(raw);
      if (!parsed) {
        this.onToast('未能识别该二维码中的连接地址');
        return;
      }
      this.mode = parsed.mode;
      this.serverUrl = parsed.serverUrl;
      if (parsed.deviceId) {
        this.deviceId = parsed.deviceId;
      }
      if (parsed.pin) {
        this.pin = parsed.pin;
        this.onToast('已识别二维码，正在自动连接...');
        this.onSubmitConnect();
        return;
      }
      this.onToast('已识别设备，请输入密码');
    } catch {
      this.onToast('已取消扫码或当前设备不支持相机扫码');
    }
  }

  @Builder
  private buildTsnetCard() {
    Column({ space: 12 }) {
      Row({ space: 10 }) {
        Column({ space: 3 }) {
          Row({ space: 6 }) {
            Circle({ width: 8, height: 8 })
              .fill(
                this.tsnetStatus.tailscaleIp.length > 0
                  ? '#10B981'
                  : this.tsnetStatus.enabled
                    ? '#F59E0B'
                    : '#64748B'
              )
            Text('组网')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor('#EEF2F9')
          }
          Text(
            this.tsnetStatus.tailscaleIp.length > 0
              ? `已组网 · 在线节点 ${this.tsnetStatus.peers.filter((p) => p.online).length}`
              : this.tsnetStatus.authUrl.length > 0
                ? '等待在浏览器登录授权同账号'
                : this.tsnetStatus.enabled
                  ? `状态: ${this.tsnetStatus.state || '启动中...'}`
                  : '无需额外软件'
          )
            .fontSize(12)
            .fontColor('#8A9BB8')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Button(this.tsnetStatus.enabled ? '关闭' : '开启组网')
          .height(34)
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .backgroundColor(this.tsnetStatus.enabled ? '#451A22' : '#2563EB')
          .fontColor(this.tsnetStatus.enabled ? '#FCA5A5' : '#FFFFFF')
          .borderRadius(9)
          .onClick(() => {
            this.showTsnetCard = true;
            this.onToggleTsnet(!this.tsnetStatus.enabled, this.tsnetAuthKeyInput);
          })
      }
      .width('100%')

      if (this.tsnetStatus.enabled || this.showTsnetCard) {
        if (this.tsnetStatus.lastError.length > 0) {
          Text(this.tsnetStatus.lastError)
            .width('100%')
            .fontSize(11)
            .fontColor('#FCA5A5')
            .backgroundColor('#3A1620')
            .borderRadius(8)
            .border({ width: 1, color: '#6B2436' })
            .padding(10)
        }

        if (this.tsnetStatus.authUrl.length > 0) {
          Column({ space: 8 }) {
            Text('请用浏览器打开下方链接，登录与电脑端相同的 Tailscale 账号完成一次绑定：')
              .fontSize(12)
              .fontColor('#CBD5E1')
              .width('100%')
            Row({ space: 8 }) {
              Button('打开授权登录')
                .layoutWeight(1)
                .height(36)
                .fontSize(12)
                .fontWeight(FontWeight.Bold)
                .backgroundColor('#2563EB')
                .fontColor('#FFFFFF')
                .borderRadius(9)
                .onClick(() => {
                  this.openExternalUrl(this.tsnetStatus.authUrl);
                })
              Button('复制链接')
                .height(36)
                .fontSize(12)
                .backgroundColor('#162032')
                .fontColor('#EEF2F9')
                .borderRadius(9)
                .border({ width: 1, color: '#22314C' })
                .onClick(() => {
                  this.copyUrlToClipboard(this.tsnetStatus.authUrl, 'Tailscale 登录链接');
                })
            }
            .width('100%')
          }
          .width('100%')
          .padding(12)
          .backgroundColor('#080C14')
          .borderRadius(10)
          .border({ width: 1, color: '#22314C' })
        }

        if (this.tsnetStatus.tailscaleIp.length === 0) {
          Row({ space: 8 }) {
            TextInput({
              text: this.tsnetAuthKeyInput,
              placeholder: '可选：填入 Auth Key (tskey-auth-...)',
            })
              .layoutWeight(1)
              .height(38)
              .fontSize(12)
              .fontColor('#EEF2F9')
              .placeholderColor('#64748B')
              .backgroundColor('#080C14')
              .borderRadius(9)
              .border({ width: 1, color: '#22314C' })
              .onChange((val: string) => {
                this.tsnetAuthKeyInput = val.trim();
              })
            Button('应用')
              .height(38)
              .fontSize(12)
              .backgroundColor('#162032')
              .fontColor('#38BDF8')
              .borderRadius(9)
              .border({ width: 1, color: '#22314C' })
              .onClick(() => {
                this.onToggleTsnet(true, this.tsnetAuthKeyInput);
              })
          }
          .width('100%')
        } else {
          Column({ space: 6 }) {
            ForEach(this.tsnetStatus.peers.slice(0, 5), (peer: TsnetPeer) => {
              Row({ space: 8 }) {
                Circle({ width: 7, height: 7 })
                  .fill(peer.online ? '#10B981' : '#64748B')
                Text(peer.name)
                  .fontSize(12)
                  .fontColor('#CBD5E1')
                  .layoutWeight(1)
                Text(peer.online ? '在线' : '离线')
                  .fontSize(11)
                  .fontColor(peer.online ? '#10B981' : '#8A9BB8')
              }
              .width('100%')
              .padding({ top: 6, bottom: 6, left: 8, right: 8 })
              .backgroundColor('#080C14')
              .borderRadius(8)
            }, (peer: TsnetPeer) => `${peer.id}-${peer.ip}`)

            Row({ space: 8 }) {
              Button('刷新组网节点')
                .layoutWeight(1)
                .height(32)
                .fontSize(12)
                .backgroundColor('#162032')
                .fontColor('#38BDF8')
                .borderRadius(8)
                .border({ width: 1, color: '#22314C' })
                .onClick(() => {
                  this.onScanLan();
                })
              Button('退出账号')
                .height(32)
                .fontSize(12)
                .backgroundColor('#162032')
                .fontColor('#FCA5A5')
                .borderRadius(8)
                .border({ width: 1, color: '#22314C' })
                .onClick(() => {
                  this.onLogoutTsnet();
                })
            }
            .width('100%')
          }
          .width('100%')
        }
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor('#0F1623')
    .borderRadius(14)
    .border({ width: 1, color: this.tsnetStatus.tailscaleIp.length > 0 ? '#1E5B45' : '#22314C' })
  }

  @Builder
  private buildPhoneShareCard() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Column({ space: 2 }) {
          Row({ space: 6 }) {
            Text('手机投屏')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor('#EEF2F9')
            if (this.phoneShareStatus.running) {
              Text(this.phoneShareStatus.capturing ? '传输中' : '等待授权')
                .fontSize(10)
                .fontColor(this.phoneShareStatus.capturing ? '#10B981' : '#F59E0B')
                .backgroundColor(this.phoneShareStatus.capturing ? '#0E2A24' : '#2B210B')
                .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                .borderRadius(6)
            }
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Button(this.phoneShareStatus.running ? '停止共享' : '开始共享')
          .height(34)
          .fontSize(12)
          .fontWeight(FontWeight.Bold)
          .backgroundColor(this.phoneShareStatus.running ? '#7F1D1D' : '#0EA5E9')
          .fontColor('#FFFFFF')
          .borderRadius(9)
          .onClick(() => {
            this.onTogglePhoneShare(!this.phoneShareStatus.running);
          })
      }
      .width('100%')

      if (this.phoneShareStatus.running) {
        Text(
          `端口 ${this.phoneShareStatus.port} · ${this.phoneShareStatus.width}x${this.phoneShareStatus.height}` +
          ` · 已编码 ${this.phoneShareStatus.frames} 帧 · 已连接电脑 ${this.phoneShareStatus.clients} 台` +
          (this.tsnetStatus.tailscaleIp.length > 0 ? ' · 已组网' : '')
        )
          .fontSize(11)
          .fontColor('#CBD5E1')
          .width('100%')
      }

      if (this.phoneShareStatus.lastError.length > 0) {
        Text(this.phoneShareStatus.lastError)
          .fontSize(11)
          .fontColor('#FCA5A5')
          .width('100%')
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor('#0F1623')
    .borderRadius(14)
    .border({ width: 1, color: this.phoneShareStatus.capturing ? '#0EA5E9' : '#22314C' })
  }

  @Builder
  private buildFormCard() {
    Column({ space: 14 }) {
      Row({ space: 8 }) {
        Text('连接')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor('#EEF2F9')
          .fontFamily('HarmonyOS Sans')
          .layoutWeight(1)

        Button('扫码')
          .height(32)
          .padding({ left: 12, right: 12 })
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .backgroundColor('#0E2A24')
          .fontColor('#10B981')
          .borderRadius(8)
          .border({ width: 1, color: '#1B4D3E' })
          .onClick(() => {
            void this.handleScanQr();
          })
      }
      .width('100%')

      Column({ space: 6 }) {
        Text('对方设备代码')
          .fontSize(12)
          .fontColor('#8A9BB8')
        TextInput({
          text: this.deviceId,
          placeholder: 'RD-0000-0000',
        })
          .height(44)
          .fontSize(15)
          .fontColor('#EEF2F9')
          .placeholderColor('#64748B')
          .backgroundColor('#080C14')
          .borderRadius(10)
          .border({ width: 1, color: '#22314C' })
          .onChange((val: string) => {
            const trimmed = val.trim();
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
              const parsed = parseConnectUrl(trimmed);
              if (parsed && (parsed.deviceId.length > 0 || parsed.pin.length > 0)) {
                this.mode = parsed.mode;
                this.serverUrl = parsed.serverUrl;
                this.deviceId = parsed.deviceId || parsed.serverUrl;
                if (parsed.pin.length > 0) {
                  this.pin = parsed.pin;
                }
                this.onToast('已识别口令');
                return;
              }
              this.deviceId = trimmed;
            } else {
              this.deviceId = val.toUpperCase();
            }
          })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      Column({ space: 6 }) {
        Text('密码')
          .fontSize(12)
          .fontColor('#8A9BB8')
        TextInput({
          text: this.pin,
          placeholder: '8 位密码',
        })
          .type(InputType.Password)
          .showPasswordIcon(false)
          .height(44)
          .fontSize(15)
          .fontColor('#EEF2F9')
          .placeholderColor('#64748B')
          .backgroundColor('#080C14')
          .borderRadius(10)
          .border({ width: 1, color: '#22314C' })
          .onChange((val: string) => {
            this.pin = val.toUpperCase();
          })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      if (this.errorMsg.length > 0) {
        Text(this.errorMsg)
          .width('100%')
          .fontSize(12)
          .fontColor('#FCA5A5')
          .backgroundColor('#3A1620')
          .borderRadius(8)
          .padding(10)
      }

      Button(this.connecting ? '连接中...' : '连接')
        .width('100%')
        .height(46)
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .backgroundColor('#2563EB')
        .fontColor('#FFFFFF')
        .borderRadius(11)
        .enabled(!this.connecting)
        .onClick(() => {
          this.onSubmitConnect();
        })

      if (this.logs.length > 0) {
        Column({ space: 4 }) {
          ForEach(this.logs.slice(-4), (line: string, idx: number) => {
            Text(line)
              .fontSize(11)
              .fontColor('#8A9BB8')
              .width('100%')
          }, (line: string, idx: number) => `${idx}-${line}`)
        }
        .width('100%')
        .padding(10)
        .backgroundColor('#080C14')
        .borderRadius(8)
        .border({ width: 1, color: '#22314C' })
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor('#0F1623')
    .borderRadius(14)
    .border({ width: 1, color: '#22314C' })
  }

  @Builder
  private buildRecentCard() {
    if (this.recentDevices.length > 0) {
      Column({ space: 10 }) {
        Text('最近连接')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor('#EEF2F9')
          .width('100%')

        Column({ space: 8 }) {
          ForEach(this.recentDevices.slice(0, 6), (item: RecentDeviceItem) => {
            Row({ space: 10 }) {
              Circle({ width: 8, height: 8 })
                .fill(this.isDeviceOnline(item.deviceId) ? '#10B981' : '#64748B')
              Column({ space: 2 }) {
                Text(item.deviceName || item.deviceId)
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#EEF2F9')
                Text(item.deviceId)
                  .fontSize(11)
                  .fontColor('#8A9BB8')
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)

              Button('连接')
                .height(30)
                .fontSize(12)
                .backgroundColor('#162032')
                .fontColor('#38BDF8')
                .borderRadius(8)
                .border({ width: 1, color: '#22314C' })
                .onClick(() => {
                  this.quickRemoteRecent(item);
                })
            }
            .width('100%')
            .padding(11)
            .backgroundColor('#080C14')
            .borderRadius(10)
            .border({ width: 1, color: '#22314C' })
            .onClick(() => {
              this.quickRemoteRecent(item);
            })
          }, (item: RecentDeviceItem) => `${item.mode}-${item.deviceId}-${item.serverUrl}`)
        }
        .width('100%')
      }
      .width('100%')
      .padding(16)
      .backgroundColor('#0F1623')
      .borderRadius(14)
      .border({ width: 1, color: '#22314C' })
    }
  }

  @Builder
  private buildDevicesCard() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Column({ space: 2 }) {
          Text('设备')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor('#EEF2F9')
            .fontFamily('HarmonyOS Sans')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Button(this.scanningLan ? '扫描中...' : '刷新')
          .height(32)
          .fontSize(12)
          .backgroundColor('#162032')
          .fontColor('#EEF2F9')
          .borderRadius(8)
          .border({ width: 1, color: '#22314C' })
          .enabled(!this.scanningLan)
          .onClick(() => {
            this.onScanLan();
          })
      }
      .width('100%')

      if (this.onlineDevices.length === 0) {
        Column({ space: 6 }) {
          Text(this.scanningLan ? '扫描中...' : '没有设备')
            .fontSize(13)
            .fontColor('#8A9BB8')
        }
        .width('100%')
        .padding(18)
        .backgroundColor('#080C14')
        .borderRadius(10)
        .border({ width: 1, color: '#22314C' })
      } else {
        Column({ space: 8 }) {
          if (this.acctDevices.length > 0) {
            Text('我的设备')
              .fontSize(12)
              .fontColor('#8A9BB8')
              .width('100%')
            ForEach(this.acctDevices, (dev: AcctDevice) => {
              Row({ space: 10 }) {
                Circle({ width: 8, height: 8 })
                  .fill(dev.online === true ? '#10B981' : '#64748B')
                Column({ space: 3 }) {
                  Text(dev.name ?? dev.deviceId ?? '')
                    .fontSize(14)
                    .fontColor('#EEF2F9')
                  Text(`${dev.deviceId ?? ''} · ${dev.online === true ? '在线' : '离线'}`)
                    .fontSize(11)
                    .fontColor('#8A9BB8')
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)

                if (dev.deviceId === this.myCode) {
                  Text('本机')
                    .fontSize(12)
                    .fontColor('#38BDF8')
                    .padding({ left: 10, right: 10, top: 6, bottom: 6 })
                    .backgroundColor('#162032')
                    .borderRadius(9)
                } else {
                  Button('连接')
                    .height(32)
                    .fontSize(12)
                    .fontColor('#FFFFFF')
                    .backgroundColor(dev.online === true ? '#2563EB' : '#162032')
                    .borderRadius(9)
                    .enabled(dev.online === true)
                    .onClick(() => { this.connectAccountDevice(dev.deviceId ?? ''); })
                }
              }
              .width('100%')
              .padding(12)
              .backgroundColor('#080C14')
              .borderRadius(10)
              .border({ width: 1, color: '#1B2740' })
            }, (dev: AcctDevice) => dev.deviceId ?? '')
          }
          ForEach(this.onlineDevices.filter((d) => !this.acctDevices.some((a) => a.deviceId === d.deviceId)), (dev: RemoteDeviceInfo) => {
            Row({ space: 10 }) {
              Column({ space: 4 }) {
                Row({ space: 6 }) {
                  Circle({ width: 8, height: 8 })
                    .fill(dev.online ? '#10B981' : '#64748B')
                  Text(dev.deviceName || dev.deviceId)
                    .fontSize(15)
                    .fontWeight(FontWeight.Medium)
                    .fontColor('#EEF2F9')
                }
                Text(dev.deviceId)
                  .fontSize(12)
                  .fontColor('#8A9BB8')
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)

              Button('连接')
                .height(34)
                .fontSize(12)
                .fontWeight(FontWeight.Medium)
                .backgroundColor('#2563EB')
                .fontColor('#FFFFFF')
                .borderRadius(8)
                .onClick(() => {
                  this.quickRemoteDevice(dev);
                })
            }
            .width('100%')
            .padding(13)
            .backgroundColor('#080C14')
            .borderRadius(10)
            .border({
              width: 1,
              color: this.deviceId === dev.deviceId ? '#38BDF8' : '#22314C',
            })
            .onClick(() => {
              this.quickRemoteDevice(dev);
            })
          }, (dev: RemoteDeviceInfo) => dev.deviceId)
        }
        .width('100%')
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor('#0F1623')
    .borderRadius(14)
    .border({ width: 1, color: '#22314C' })
  }

  build() {
    Stack() {
      Column() {
        Scroll() {
          Column({ space: 14 }) {
            if (this.tier === 'desktop' || this.tier === 'tablet') {
              Row({ space: 16 }) {
                Column({ space: 14 }) {
                  this.buildSelfCard()
                  this.buildFormCard()
                  this.buildTsnetCard()
                  this.buildPhoneShareCard()
                }
                .layoutWeight(1)

                Column({ space: 14 }) {
                  this.buildDevicesCard()
                  this.buildRecentCard()
                }
                .layoutWeight(1)
              }
              .width('100%')
              .alignItems(VerticalAlign.Top)
            } else {
              if (this.phoneSubTab === 'connect') {
                this.buildSelfCard()
                this.buildFormCard()
                this.buildRecentCard()
              } else if (this.phoneSubTab === 'devices') {
                this.buildDevicesCard()
                this.buildPhoneShareCard()
                this.buildRecentCard()
              } else if (this.phoneSubTab === 'account') {
                AccountPane({ onConnectDevice: (id: string) => { this.connectAccountDevice(id); } })
              } else {
                this.buildTsnetCard()
                this.buildPhoneShareCard()
              }
            }
          }
          .width('100%')
          .padding({ left: 14, right: 14, top: 8, bottom: 20 })
        }
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.Top)
        .scrollBar(BarState.Off)

        if (this.tier === 'phone') {
          Row({ space: 6 }) {
            Button('连接')
              .layoutWeight(1)
              .height(40)
              .fontSize(13)
              .fontWeight(this.phoneSubTab === 'connect' ? FontWeight.Bold : FontWeight.Normal)
              .backgroundColor(this.phoneSubTab === 'connect' ? '#173054' : 'transparent')
              .fontColor(this.phoneSubTab === 'connect' ? '#38BDF8' : '#8A9BB8')
              .borderRadius(10)
              .onClick(() => {
                this.phoneSubTab = 'connect';
              })

            Button('设备')
              .layoutWeight(1)
              .height(40)
              .fontSize(13)
              .fontWeight(this.phoneSubTab === 'devices' ? FontWeight.Bold : FontWeight.Normal)
              .backgroundColor(this.phoneSubTab === 'devices' ? '#173054' : 'transparent')
              .fontColor(this.phoneSubTab === 'devices' ? '#38BDF8' : '#8A9BB8')
              .borderRadius(10)
              .onClick(() => {
                this.phoneSubTab = 'devices';
              })

            Button('组网')
              .layoutWeight(1)
              .height(40)
              .fontSize(13)
              .fontWeight(this.phoneSubTab === 'mesh' ? FontWeight.Bold : FontWeight.Normal)
              .backgroundColor(this.phoneSubTab === 'mesh' ? '#173054' : 'transparent')
              .fontColor(
                this.phoneSubTab === 'mesh'
                  ? '#38BDF8'
                  : (this.tsnetStatus.tailscaleIp.length > 0 ? '#10B981' : '#8A9BB8')
              )
              .borderRadius(10)
              .onClick(() => {
                this.phoneSubTab = 'mesh';
                this.showTsnetCard = true;
              })

            Button('我的')
              .layoutWeight(1)
              .height(40)
              .fontSize(13)
              .fontWeight(this.phoneSubTab === 'account' ? FontWeight.Bold : FontWeight.Normal)
              .backgroundColor(this.phoneSubTab === 'account' ? '#173054' : 'transparent')
              .fontColor(this.phoneSubTab === 'account' ? '#38BDF8' : '#8A9BB8')
              .borderRadius(10)
              .onClick(() => {
                this.phoneSubTab = 'account';
              })
          }
          .width('100%')
          .padding({ left: 10, right: 10, top: 6, bottom: 10 })
          .backgroundColor('#0F1623')
          .border({ width: { top: 1 }, color: '#22314C' })
        }
      }
      .width('100%')
      .height('100%')

      if (this.promptDevice !== null) {
        Column() {
          Column({ space: 12 }) {
            Text(`连接 ${this.promptDevice.deviceName || this.promptDevice.deviceId}`)
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor('#EEF2F9')
            Text(`设备 ID: ${this.promptDevice.deviceId}`)
              .fontSize(12)
              .fontColor('#8A9BB8')

            TextInput({
              text: this.promptPin,
              placeholder: '8 位密码',
            })
              .height(44)
              .fontSize(15)
              .fontColor('#EEF2F9')
              .placeholderColor('#64748B')
              .backgroundColor('#080C14')
              .borderRadius(10)
              .border({ width: 1, color: '#22314C' })
              .onChange((val: string) => {
                this.promptPin = val.toUpperCase();
              })
              .onSubmit(() => {
                const p = this.promptPin.trim();
                if (!p) return;
                this.pin = p;
                this.promptDevice = null;
                this.onSubmitConnect();
              })

            Row({ space: 10 }) {
              Button('取消')
                .layoutWeight(1)
                .height(40)
                .backgroundColor('#162032')
                .fontColor('#8A9BB8')
                .borderRadius(9)
                .onClick(() => {
                  this.promptDevice = null;
                })
              Button('立即远程')
                .layoutWeight(1)
                .height(40)
                .backgroundColor('#2563EB')
                .fontColor('#FFFFFF')
                .fontWeight(FontWeight.Bold)
                .borderRadius(9)
                .onClick(() => {
                  const p = this.promptPin.trim();
                  if (!p) {
                    this.onToast('请输入密码');
                    return;
                  }
                  this.pin = p;
                  this.promptDevice = null;
                  this.onSubmitConnect();
                })
            }
            .width('100%')
          }
          .width('88%')
          .constraintSize({ maxWidth: 380 })
          .padding(18)
          .backgroundColor('#0F1623')
          .borderRadius(14)
          .border({ width: 1, color: '#38BDF8' })
        }
        .width('100%')
        .height('100%')
        .backgroundColor('#AA000000')
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .layoutWeight(1)
  }
}
