# RemoteDeck

内外网互通、多端共用自适应界面的远程桌面 / 远程终端 / 文件管理工作台。

## 核心特性

1. **内外网自动路由**
   - **内网直连（LAN / Tailscale）**：被控端本地暴露 HTTP + WebSocket 服务（默认 `:9601`）与 UDP 发现信标（`:9602`）；控制端连接时优先竞速探测内网直连，零中继带宽消耗。
   - **外网 P2P + 云端中继兜底**：通过自建 `relay-server` 交换信令并尝试 **WebRTC DataChannel P2P** 直连；对称 NAT 等复杂网络下自动无缝维持 **WebSocket 加密认证隧道**。
   - **零 VPS 临时公网隧道**：被控端可选开启 `--tunnel`，自动拉起 `cloudflared` 临时安全通道。
2. **三端交互级自适应 Web / PWA 控制端（PC / 平板 / 手机共用一套代码）**
   - **PC 桌面端（>1024px）**：支持画面 / 终端 / 文件 / 左右分屏工作台、完整键鼠透传。
   - **平板端（721–1024px）**：紧凑顶栏 + 触控/外接键盘兼容 + 悬浮修饰键条。
   - **手机端（≤720px）**：单手底部工具坞、**触控板模式 / 直触缩放模式**切换、双指捏合缩放、双指滚轮、虚拟组合键（`Esc`/`Tab`/`Ctrl+C`/`Ctrl+V`/`Alt+Tab`/`Win`/方向键）以及 **中文输入法文本直发**；文件面板自动转为单列触控卡片。
   - 支持 **PWA 添加到主屏幕**（`manifest.webmanifest` + `sw.js`）。
3. **三合一远程能力 & 端到端安全**
   - **远程桌面**：Go 原生 Win32 BitBlt 屏采（空闲帧哈希跳过、多显示器切换、画质/FPS 自适应）+ `SendInput` 键鼠与 Unicode 文本注入 + 剪贴板同步。
   - **远程终端**：Windows ConPTY（`CreatePseudoConsole`）/ Shell 实时交互与动态尺寸调整。
   - **文件管理**：目录浏览、新建目录、重命名、删除、在线文本预览/编辑、分片上传下载。
   - **安全鉴权**：HMAC-SHA256 挑战-响应校验（不传输明文 PIN），支持只读、禁用终端/文件等权限开关。

## 快速开始

### 方式一：直接双击运行 Windows 桌面软件（推荐）

已打包好免安装绿色桌面软件（不依赖本机预装 Node.js）：
- 可执行文件：`dist/RemoteDeck-win32-x64/RemoteDeck.exe`
- 如需重新打包：

```bash
cd remote-deck
npm install
npm run package:win
```

打开 `RemoteDeck.exe` 后即可在软件界面内直接：
- 查看本机 **设备 ID**、**临时访问配对码**、**内网二维码**，手机/平板扫码即可远程；
- 一键开启 **外网公网隧道 (Cloudflare)** 生成外网二维码，或填写自建 **公网中继地址**；
- 精细开关 **观看画面 / 键鼠控制 / 远程终端 / 文件管理** 权限及 **开机自启动**；
- 窗口关闭时自动驻留 **Windows 系统托盘**，右键托盘可随时打开界面或复制配对信息；
- 在软件窗口内直接输入另一台设备的 ID 与配对码，远程操控对方屏幕、终端和文件。

### 方式二：鸿蒙原生客户端（HarmonyOS NEXT 手机 / 平板 / 2in1）

已内置完整鸿蒙原生 ArkTS 工程（`apps/harmony`）并已编译生成 HAP 安装包：
- 工程目录：`apps/harmony`
- 构建产物：`dist/RemoteDeck-harmony/RemoteDeck-entry-default-unsigned.hap`
- 重新编译命令：

```bash
cd remote-deck
npm run build:harmony
```

> 注：Hvigor 要求工程路径仅包含英文/数字/常见符号（不能含中文目录名，否则会报 `00306003 Specification Limit Violation`）。执行 `npm run build:harmony` 后会自动生成纯英文路径工程目录（位于系统临时目录 `remotedeck-harmony-build`），在 **DevEco Studio** 中直接打开该纯英文路径目录（或将 `apps/harmony` 复制到纯英文路径）即可自动生成调试签名并一键安装到鸿蒙真机/模拟器。

支持能力：
- **内外网自动选路**：UDP 局域网广播发现（`:9602`）+ 内网多网卡竞速直连 + 中继信令/WebSocket 加密通道（HMAC-SHA256 挑战-响应）+ 扫码/链接直连；
- **多端自适应**：同时支持 `phone` / `tablet` / `2in1`，按窗口宽度自动切换手机、平板、桌面（含桌面+终端左右分屏）布局，也可在右上角手动切换视图模式；
- **完整远程交互**：触控板模式 / 直触缩放模式、双指捏合缩放、右键/滚轮/快捷组合键/中文输入法直发、远程终端（ConPTY + ANSI 清理 + 常用快捷键）、文件管理（浏览、文本编辑保存、分片上传下载）、系统剪贴板同步。

### 方式三：命令行开发/服务器部署

```bash
cd remote-deck
npm install
npm run build:native   # 编译 Go 原生助手 -> packages/host-agent/bin/remote-native.exe
npm run build          # 构建多端自适应 Web PWA -> apps/web/dist
npm run start:app      # 开发模式启动桌面软件
```

### 方式一：纯内网直连（无需公网服务器）

在被控机器启动：

```bash
npm run start:agent
```

控制台会输出 **Device ID**、**Pairing PIN** 以及内网访问地址（例如 `http://192.168.1.25:9601`）。在同一局域网或 Tailscale 虚拟局域网内的手机、平板或另一台电脑浏览器直接打开该地址即可控制。

### 方式二：内外网互通（自建公网 Relay）

1. 在公网 VPS 启动中继服务端（或使用 `docker compose up -d`）：

```bash
npm run start:relay -- --port 9600
```

2. 在被控机器连接中继：

```bash
npm run start:agent -- --relay ws://你的公网IP或域名:9600/ws
```

3. 手机（4G/5G 外网）或任何浏览器打开 `http(s)://你的公网IP或域名:9600`，选择在线设备并输入配对码连接。同在局域网时会自动优先切走内网直连，外网时优先尝试 WebRTC P2P 并由中继保底。

### 方式三：无公网服务器临时外网通道

```bash
npm run start:agent -- --tunnel
```

## 运行测试

```bash
npm test
```

## 端口与局域网发现

被控端只用两个固定端口，改动它们会让已经配对过的手机找不到电脑：

| 端口 | 协议 | 用途 |
|---|---|---|
| 9601 | TCP | 主控服务（PWA 静态资源、`/api/*`、`/ws` 控制通道、`/ws/phone-stream`） |
| 9602 | UDP | 局域网广播发现（手机发送 `REMOTEDECK_DISCOVER` 后回设备信息） |
| 9603 | TCP | 内嵌组网（tsnet）转发到本机的端口，供 tailnet 内设备回连 |

服务启动时会优先占用 9601；如果被占用会在约 6.5 秒内重试，仍不行才退到随机端口，并在日志里告警。若占用者**本身就是本机另一个 RemoteDeck 宿主**（例如开机服务实例），这份实例会降级成"只显示界面"的客户端，不会另起一个手机发现不了的宿主。

## 开机启动：两种模式只能留一个

| 模式 | 入口 | 特点 |
|---|---|---|
| 登录自启（默认建议） | 计划任务 `RemoteDeckHost` | 登录后拉起，有桌面窗口，普通场景够用 |
| 开机服务 | 计划任务 `RemoteDeckBoot` + `remote-deck-svc.exe` | 以 SYSTEM 在开机时拉起、意外退出自动重启、可覆盖锁屏场景；**没有桌面窗口** |

两条链路会抢同一个 9601，所以不要同时启用：安装开机服务会自动清掉登录自启（`clearLogonAutostart`），需要回到登录自启时再手动把「管理员权限自启」打开。

## 构建顺序

```bash
npm run build:native   # remote-native.exe / remote-deck-svc.exe（Go，需要本机 Go）
npm run build          # Web PWA
npm run build:tsnet    # remote-tsnet.exe + HarmonyOS libtsnet_bridge.so
npm run build:harmony  # HAP（依赖 build:tsnet 产出的 .so）
npm run package:win    # 打包 dist/RemoteDeck-win32-x64
```

`build:tsnet` 有两个前置条件，缺一会在构建期直接报错而不是运行时才炸：

- `packages/host-agent/tsnet/go.mod` 要求 **Go 1.27+**，脚本会用该工具链暂存一份 GOROOT 打补丁；离线机器需要提前把 `golang.org/toolchain` 缓存好。
- OpenHarmony NDK（`hdc`/clang）需在 DevEco Studio 安装路径下，脚本会自动探测。

## 排障：手机连不上电脑

1. 电脑端执行 `curl http://127.0.0.1:9601/api/health`，应返回 `deviceId` / `lanEndpoints`。
2. 确认 9601（TCP）和 9602（UDP）在监听：`netstat -ano | findstr "9601 9602"`。
3. 端口不是 9601 说明被别的程序占了，此时手机会按旧地址连不上——关掉占用进程后重启 App 即可。
4. 手机端重新扫描局域网设备（走 9602 广播），或手动填电脑的 `IP:9601`。
5. 跨网（非同一局域网）时改用内嵌组网：手机与电脑都要在 tailnet 里，并把 9601 换成电脑的 `100.x` 地址。

