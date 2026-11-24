import { http } from '@kit.NetworkKit';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';

const DEFAULT_SERVER = 'https://miaosizhineng.online';
const PREFS_NAME = 'remotedeck_account';
const TOKEN_KEY = 'token';
const PHONE_ID_KEY = 'phone_device_id';

interface JsonHeader {
  'Content-Type': string;
  Authorization?: string;
}

interface AuthBody {
  username: string;
  password: string;
  code?: string;
}

interface EmailBody {
  email: string;
}

interface DeviceBody {
  deviceId: string;
  name: string;
  platform: string;
  kind: string;
}

interface AccountUser {
  username?: string;
  email?: string;
}

interface AccountDevice {
  deviceId?: string;
  name?: string;
  platform?: string;
  kind?: string;
  online?: boolean;
}

interface ApiResult {
  ok?: boolean;
  token?: string;
  error?: string;
  user?: AccountUser;
  devices?: AccountDevice[];
}

async function request(
  url: string,
  method: http.RequestMethod,
  body: Object | null,
  token: string = '',
): Promise<ApiResult> {
  const req = http.createHttp();
  try {
    const header: JsonHeader = { 'Content-Type': 'application/json' };
    if (token.length > 0) header.Authorization = `Bearer ${token}`;
    const options: http.HttpRequestOptions = {
      method: method,
      header: header,
      connectTimeout: 12000,
      readTimeout: 12000,
    };
    if (body !== null) options.extraData = JSON.stringify(body);
    const res = await req.request(url, options);
    const text = typeof res.result === 'string' ? res.result : '';
    return JSON.parse(text) as ApiResult;
  } catch (err) {
    const msg = (err as Error)?.message ?? '网络错误';
    const failed: ApiResult = { ok: false, error: msg };
    return failed;
  } finally {
    req.destroy();
  }
}

const postJson = (url: string, body: Object, token: string = '') =>
  request(url, http.RequestMethod.POST, body, token);
const getJson = (url: string, token: string) =>
  request(url, http.RequestMethod.GET, null, token);

@Component
export struct AccountPane {
  onConnectDevice: (id: string) => void = () => {};

  @State token: string = '';
  @State username: string = '';
  @State email: string = '';
  @State devices: AccountDevice[] = [];
  @State registerMode: boolean = false;
  @State nameInput: string = '';
  @State passwordInput: string = '';
  @State codeInput: string = '';
  @State codeSent: boolean = false;
  @State busy: boolean = false;
  @State errorMsg: string = '';
  @State loaded: boolean = false;

  private server: string = DEFAULT_SERVER;
  private phoneId: string = '';
  private pingTimer: number = -1;
  private listTimer: number = -1;

  aboutToAppear(): void {
    void this.init();
  }

  aboutToDisappear(): void {
    if (this.pingTimer >= 0) clearInterval(this.pingTimer);
    if (this.listTimer >= 0) clearInterval(this.listTimer);
  }

  private getContext(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private async readPref(key: string): Promise<string> {
    try {
      const store = await preferences.getPreferences(this.getContext(), PREFS_NAME);
      return (await store.get(key, '')) as string;
    } catch {
      return '';
    }
  }

  private async writePref(key: string, value: string): Promise<void> {
    try {
      const store = await preferences.getPreferences(this.getContext(), PREFS_NAME);
      await store.put(key, value);
      await store.flush();
    } catch {
      // Best effort.
    }
  }

  private async ensurePhoneId(): Promise<string> {
    if (this.phoneId.length > 0) return this.phoneId;
    let id = await this.readPref(PHONE_ID_KEY);
    if (id.length === 0) {
      const seed = Math.floor(Math.random() * 9000) + 1000;
      id = `PH-${Date.now().toString(36).slice(-4).toUpperCase()}-${seed}`;
      await this.writePref(PHONE_ID_KEY, id);
    }
    this.phoneId = id;
    return id;
  }

  private async init(): Promise<void> {
    await this.ensurePhoneId();
    const saved = await this.readPref(TOKEN_KEY);
    if (saved.length === 0) {
      this.loaded = true;
      return;
    }
    const res = await getJson(`${this.server}/api/auth/me`, saved);
    if (res.ok === true) {
      this.applyUser(saved, res);
      this.startTimers();
    } else {
      this.token = '';
      await this.writePref(TOKEN_KEY, '');
    }
    this.loaded = true;
  }

  private applyUser(token: string, res: ApiResult): void {
    const user: AccountUser = res.user ?? {};
    this.token = token;
    this.username = user.username ?? '';
    this.email = user.email ?? '';
  }

  private phoneName(): string {
    const market = deviceInfo.marketName;
    return market && market.length > 0 ? market : '手机';
  }

  private startTimers(): void {
    if (this.pingTimer >= 0) clearInterval(this.pingTimer);
    if (this.listTimer >= 0) clearInterval(this.listTimer);
    void this.reportSelf();
    void this.refreshDevices();
    this.pingTimer = setInterval(() => { void this.reportSelf(); }, 60000);
    this.listTimer = setInterval(() => { void this.refreshDevices(); }, 15000);
  }

  private async reportSelf(): Promise<void> {
    if (this.token.length === 0) return;
    const id = await this.ensurePhoneId();
    const body: DeviceBody = {
      deviceId: id,
      name: this.phoneName(),
      platform: 'harmony',
      kind: 'phone',
    };
    await postJson(`${this.server}/api/auth/device`, body, this.token);
  }

  private async refreshDevices(): Promise<void> {
    if (this.token.length === 0) return;
    const res = await getJson(`${this.server}/api/auth/devices`, this.token);
    if (res.ok === true) this.devices = res.devices ?? [];
  }

  private isEmailInput(): boolean {
    const value = this.nameInput.trim();
    return this.registerMode && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  }

  private async sendCode(): Promise<void> {
    if (this.busy || !this.isEmailInput()) return;
    this.busy = true;
    this.errorMsg = '';
    try {
      const body: EmailBody = { email: this.nameInput.trim() };
      const res = await postJson(`${this.server}/api/auth/email/code`, body);
      if (res.ok === true) this.codeSent = true;
      else this.errorMsg = res.error ?? '发送失败';
    } finally {
      this.busy = false;
    }
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.errorMsg = '';
    try {
      const path = this.registerMode ? '/api/auth/register' : '/api/auth/login';
      const body: AuthBody = {
        username: this.nameInput.trim(),
        password: this.passwordInput,
        code: this.isEmailInput() ? this.codeInput.trim() : undefined,
      };
      const res = await postJson(`${this.server}${path}`, body);
      const token = res.token ?? '';
      if (res.ok !== true || token.length === 0) {
        this.errorMsg = res.error ?? '操作失败';
        return;
      }
      await this.writePref(TOKEN_KEY, token);
      this.applyUser(token, res);
      this.passwordInput = '';
      this.startTimers();
    } finally {
      this.busy = false;
    }
  }

  private async logout(): Promise<void> {
    if (this.pingTimer >= 0) clearInterval(this.pingTimer);
    if (this.listTimer >= 0) clearInterval(this.listTimer);
    this.pingTimer = -1;
    this.listTimer = -1;
    await this.writePref(TOKEN_KEY, '');
    this.token = '';
    this.username = '';
    this.email = '';
    this.devices = [];
  }

  @Builder
  private authView() {
    Column({ space: 18 }) {
      Column({ space: 6 }) {
        Text('RemoteDeck')
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .fontColor('#EEF2F9')
          .fontFamily('HarmonyOS Sans')
        Text(this.registerMode ? '创建账号' : '登录')
          .fontSize(13)
          .fontColor('#8A9BB8')
      }
      .alignItems(HorizontalAlign.Center)
      .width('100%')
      .margin({ top: 8, bottom: 6 })

      Column({ space: 7 }) {
        Text('账号')
          .fontSize(12)
          .fontColor('#8A9BB8')
        TextInput({ text: this.nameInput, placeholder: '用户名或邮箱' })
          .height(46)
          .fontSize(15)
          .fontColor('#EEF2F9')
          .placeholderColor('#566B88')
          .backgroundColor('#080C14')
          .borderRadius(10)
          .border({ width: 1, color: '#22314C' })
          .padding({ left: 14, right: 14 })
          .onChange((v: string) => { this.nameInput = v; })
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')

      Column({ space: 7 }) {
        Text('密码')
          .fontSize(12)
          .fontColor('#8A9BB8')
        TextInput({ text: this.passwordInput, placeholder: this.registerMode ? '至少 6 位' : '输入密码' })
          .type(InputType.Password)
          .height(46)
          .fontSize(15)
          .fontColor('#EEF2F9')
          .placeholderColor('#566B88')
          .backgroundColor('#080C14')
          .borderRadius(10)
          .border({ width: 1, color: '#22314C' })
          .padding({ left: 14, right: 14 })
          .onChange((v: string) => { this.passwordInput = v; })
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')

      if (this.isEmailInput()) {
        Column({ space: 7 }) {
          Text('邮箱验证码')
            .fontSize(12)
            .fontColor('#8A9BB8')
          Row({ space: 8 }) {
            TextInput({ text: this.codeInput, placeholder: '6 位验证码' })
              .type(InputType.Number)
              .height(46)
              .layoutWeight(1)
              .fontSize(15)
              .fontColor('#EEF2F9')
              .placeholderColor('#566B88')
              .backgroundColor('#080C14')
              .borderRadius(10)
              .border({ width: 1, color: '#22314C' })
              .padding({ left: 14, right: 14 })
              .onChange((v: string) => { this.codeInput = v; })
            Button(this.codeSent ? '重发' : '获取')
              .height(46)
              .width(84)
              .fontSize(13)
              .fontColor('#38BDF8')
              .backgroundColor('#162032')
              .borderRadius(10)
              .border({ width: 1, color: '#22314C' })
              .enabled(!this.busy)
              .onClick(() => { void this.sendCode(); })
          }
          .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
      }

      if (this.errorMsg.length > 0) {
        Text(this.errorMsg)
          .fontSize(12)
          .fontColor('#FCA5A5')
          .width('100%')
          .padding({ left: 12, right: 12, top: 9, bottom: 9 })
          .backgroundColor('#2A1416')
          .borderRadius(8)
      }

      Button(this.busy ? '请稍候...' : (this.registerMode ? '注册并登录' : '登录'))
        .width('100%')
        .height(48)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor('#FFFFFF')
        .backgroundColor('#2563EB')
        .borderRadius(10)
        .enabled(!this.busy)
        .margin({ top: 4 })
        .onClick(() => { void this.submit(); })

      Text(this.registerMode ? '已有账号，去登录' : '没有账号，去注册')
        .fontSize(12)
        .fontColor('#38BDF8')
        .onClick(() => {
          this.registerMode = !this.registerMode;
          this.errorMsg = '';
        })
    }
    .width('100%')
    .padding({ left: 22, right: 22, top: 26, bottom: 26 })
    .backgroundColor('#0F1623')
    .borderRadius(18)
    .border({ width: 1, color: '#22314C' })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  private deviceRow(dev: AccountDevice) {
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

      if (dev.deviceId === this.phoneId) {
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
          .onClick(() => { this.onConnectDevice(dev.deviceId ?? ''); })
      }
    }
    .width('100%')
    .padding(12)
    .backgroundColor('#080C14')
    .borderRadius(10)
    .border({ width: 1, color: '#1B2740' })
  }

  @Builder
  private profileView() {
    Column({ space: 14 }) {
      Row({ space: 8 }) {
        Column({ space: 3 }) {
          Text(this.email.length > 0 ? this.email : this.username)
            .fontSize(17)
            .fontWeight(FontWeight.Bold)
            .fontColor('#EEF2F9')
          Text('已登录')
            .fontSize(11)
            .fontColor('#8A9BB8')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Button('退出')
          .height(32)
          .fontSize(12)
          .backgroundColor('#162032')
          .fontColor('#8A9BB8')
          .borderRadius(9)
          .onClick(() => { void this.logout(); })
      }
      .width('100%')

      Divider().color('#1B2740')

      Row({ space: 6 }) {
        Text('本机代码')
          .fontSize(12)
          .fontColor('#8A9BB8')
        Text(this.phoneId)
          .fontSize(12)
          .fontColor('#CBD5E1')
          .fontFamily('HarmonyOS Sans')
      }
      .width('100%')

      Text('我的设备')
        .fontSize(12)
        .fontColor('#8A9BB8')
        .width('100%')

      if (this.devices.length === 0) {
        Text('登录过的电脑和手机会出现在这里')
          .fontSize(12)
          .fontColor('#64748B')
          .width('100%')
      } else {
        ForEach(this.devices, (dev: AccountDevice) => {
          this.deviceRow(dev)
        }, (dev: AccountDevice) => dev.deviceId ?? '')
      }
    }
    .width('100%')
    .padding(18)
    .backgroundColor('#0F1623')
    .borderRadius(16)
    .border({ width: 1, color: '#22314C' })
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column() {
      if (!this.loaded) {
        Text('加载中...')
          .fontSize(13)
          .fontColor('#8A9BB8')
          .margin({ top: 24 })
      } else if (this.token.length > 0) {
        this.profileView()
      } else {
        this.authView()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
