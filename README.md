# RemoteDeck

内外网互通、多端共用的远程桌面 / 远程终端 / 文件管理工作台。电脑、平板、手机共用一套自适应界面，支持账号登录与多设备管理。

## 下载安装

发布页提供三个包：

| 包 | 说明 |
|---|---|
| `RemoteDeck-*-Setup-win-x64.zip` | Windows 安装版：解压后双击「安装.cmd」，装到当前用户目录，创建桌面/开始菜单快捷方式，可在「设置 → 应用」里卸载 |
| `RemoteDeck-*-win-x64.zip` | Windows 绿色版：解压直接运行 `RemoteDeck.exe`，不依赖本机 Node.js |
| `RemoteDeck-*-harmony.hap` | 鸿蒙手机 / 平板安装包 |

## 核心特性

### 连接

1. **内外网自动选路**
   - 内网直连：被控端本地提供 HTTP + WebSocket 服务（默认 `:9601`）与 UDP 发现信标（`:9602`），控制端优先竞速直连内网地址，零中继消耗。
   - 外网 P2P + 中继兜底：通过自建 relay 交换信令，优先尝试 WebRTC DataChannel 直连；对称 NAT 等场景自动回落到加密 WebSocket 中继。
   - 无服务器临时通道：被控端可开 `--tunnel`，自动拉起 `cloudflared` 临时通道。
2. **账号与设备**
   - 账号密码登录，邮箱注册需邮箱验证码（10 分钟有效，最多试 6 次）。
   - 每台登录的机器自动登记为该账号的设备，显示在线 / 离线，可一键连接。
   - 本机卡片显示自己的设备代码与验证码，验证码可自定义。
3. **三合一远程能力**
   - 远程桌面：原生屏采（空闲帧哈希跳过、多显示器切换、画质/FPS 自适应）+ 键鼠与 Unicode 文本注入 + 剪贴板同步。
   - 远程终端：Windows ConPTY 实时交互与动态尺寸。
   - 文件管理：目录浏览、新建、重命名、删除、在线文本编辑、分片上传下载。
   - 手机投屏：手机作为被控端共享屏幕，PC 端观看并操作。

### 客户端

- **PC 桌面端（>1024px）**：画面 / 终端 / 文件左右分屏工作台，完整键鼠透传。
- **平板端（721–1024px）**：紧凑顶栏 + 触控 / 外接键盘兼容 + 悬浮修饰键条。
- **手机端（≤720px）**：单手底部工具坞、触控板与直触缩放两种模式、双指捏合缩放、双指滚轮、虚拟组合键（`Esc`/`Tab`/`Ctrl+C`/`Ctrl+V`/`Alt+Tab`/`Win`/方向键）、中文输入法文本直发。
- 支持 PWA 添加到主屏幕（`manifest.webmanifest` + `sw.js`）。

## 安全

- 控制端与宿主之间用 HMAC-SHA256 挑战-响应校验，不传输明文 PIN。
- 支持按权限开关观看画面、键鼠控制、远程终端、文件管理，可设置只读。
- 账号令牌为服务端签名的 Bearer Token；密码使用 scrypt 加盐存储。
- 公网中继必须带 `--secret`，否则任何人都能注册一个假的被控端。

## 从源码运行

```bash
npm install
npm run build:native   # 原生助手（Go）
npm run build          # Web PWA
npm run start:app      # 开发模式启动桌面软件
npm test               # 单元与集成测试
```

### 只跑被控端

```bash
npm run start:agent
```

控制台会输出 **Device ID**、**Pairing PIN** 和内网访问地址。同一局域网或 tailnet 内的设备直接打开该地址即可控制。

### 自建公网中继

```bash
# 服务端
npm run start:relay -- --port 9600 --secret <足够长的随机口令>

# 被控端（secret 需一致）
npm run start:agent -- --relay wss://<你的中继地址>/ws --relay-secret <同一串口令>
```

控制端打开中继地址，登录账号后选择在线设备连接；同局域网时会自动优先切回内网直连。

> 中继地址由使用者在客户端里填写，代码不内置任何服务器地址。

## 端口

| 端口 | 协议 | 用途 |
|---|---|---|
| 9601 | TCP | 主控服务（PWA 静态资源、`/api/*`、`/ws` 控制通道、`/ws/phone-stream`） |
| 9602 | UDP | 局域网广播发现 |
| 9603 | TCP | 内嵌组网（tsnet）回连端口 |

9601 被占用时会重试约 6.5 秒，仍失败才退到随机端口并告警。若占用者本身就是本机另一个 RemoteDeck 宿主，这份实例会降级为只显示界面的客户端。

## 开机启动的两种模式

| 模式 | 入口 | 特点 |
|---|---|---|
| 登录自启（默认建议） | 计划任务 `RemoteDeckHost` | 登录后拉起，有窗口 |
| 开机服务 | 计划任务 `RemoteDeckBoot` + `remote-deck-svc.exe` | 以 SYSTEM 开机拉起、意外退出自动重启、可覆盖锁屏；没有窗口 |

两者会抢同一个 9601，不要同时启用。安装开机服务会自动清掉登录自启。

## 构建顺序

```bash
npm run build:native   # remote-native.exe / remote-deck-svc.exe
npm run build          # Web PWA
npm run build:tsnet    # remote-tsnet.exe + HarmonyOS libtsnet_bridge.so
npm run build:harmony  # HAP（依赖 build:tsnet 产出的 .so）
npm run package:win    # 打包 dist/RemoteDeck-win32-x64
```

`build:tsnet` 的前置条件：

- `packages/host-agent/tsnet/go.mod` 要求 Go 1.27+，脚本会暂存 GOROOT 并打补丁；离线机器需提前缓存 `golang.org/toolchain`。
- OpenHarmony NDK（`hdc` / clang）需在 DevEco Studio 安装路径下，脚本会自动探测。

打包 Windows 安装包：

```bash
npm run package:win
node apps/desktop/scripts/make-installer.mjs
```

## 排障：手机连不上电脑

1. `curl http://127.0.0.1:9601/api/health` 应返回 `deviceId` / `lanEndpoints`。
2. `netstat -ano | findstr "9601 9602"` 确认端口在监听。
3. 端口不是 9601 说明被别的程序占用，手机会按旧地址连不上，关掉占用进程后重启 App。
4. 手机端重新扫描局域网设备，或手动填电脑的 `IP:9601`。
5. 跨网时使用内嵌组网：两端都在 tailnet 内，把地址换成电脑的 `100.x`。

## 目录结构

```
apps/desktop      Electron 桌面端（托盘、窗口、安装/看护服务）
apps/web          React + esbuild 的自适应 Web 控制端 / PWA
apps/harmony      鸿蒙原生客户端（ArkTS + NAPI + H.264 解码）
packages/host-agent   被控端宿主：采集、输入、视频、终端、文件
packages/relay-server 公网中继：信令、账号、设备登记
packages/shared       两端共用的协议与工具
assets/icon.svg       应用图标母版
```
