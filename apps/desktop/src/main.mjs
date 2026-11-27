import electron from 'electron';
const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } = electron;
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostAgent } from '@remote-deck/host-agent';
import { buildAppIconPng } from './tray-icon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(__dirname, '../../web/dist');
const preloadPath = path.join(__dirname, 'preload.cjs');
const isSmokeTest = process.argv.includes('--smoke-test') || process.env.REMOTEDECK_SMOKE_TEST === '1';

// Launched by the SYSTEM-session watchdog: let the native helper follow the
// secure (lock-screen) desktop for capture and input injection.
if (process.argv.includes('--secure-desktop')) {
  process.env.REMOTEDECK_SECURE_DESKTOP = '1';
}

// A second launch normally just focuses the first window. That is wrong when the
// first one is the headless boot-service instance (SYSTEM session, no window at
// all): the user starts the app, it quits immediately, and nothing appears.
// So the headless instance never takes the singleton lock, and a second launch
// continues as a UI-only client of the host that already owns the LAN port.
const isHeadlessInstance = process.argv.includes('--headless') || process.env.REMOTEDECK_SECURE_DESKTOP === '1';
const gotLock = isSmokeTest || isHeadlessInstance ? true : app.requestSingleInstanceLock();
const uiOnlyInstance = !isHeadlessInstance && !gotLock;

let mainWindow = null;
let tray = null;
let agent = null;
let isQuitting = false;
let settingsPath = '';
let desktopSettings = {
  relayUrl: '',
  relaySecret: '',
  quickTunnel: false,
  tsnetEnabled: false,
  tsnetAuthKey: '',
  requireApproval: false,
  autoRotatePin: false,
  tunnelToken: '',
  tunnelHostname: '',
  permissions: { view: true, control: true, terminal: true, files: true, audio: true },
};

const AUTOSTART_TASK = 'RemoteDeckHost';
const BOOT_TASK = 'RemoteDeckBoot';

function servicePaths() {
  const base = process.env.ProgramData || path.join(process.env.SystemDrive || 'C:', 'ProgramData');
  const dir = path.join(base, 'RemoteDeck');
  return {
    dir,
    config: path.join(dir, 'svc-config.json'),
    // Side-by-side with RemoteDeck.exe (installed layout).
    exe: path.join(path.dirname(process.execPath), 'remote-deck-svc.exe'),
    // Inside the packaged app: resources/app/node_modules/@remote-deck/host-agent/bin
    packaged: path.resolve(__dirname, '../../../node_modules/@remote-deck/host-agent/bin/remote-deck-svc.exe'),
    // Electron resourcesPath fallback
    resPackaged: process.resourcesPath
      ? path.join(process.resourcesPath, 'app/node_modules/@remote-deck/host-agent/bin/remote-deck-svc.exe')
      : '',
    // Repo checkout while developing.
    fallbackExe: path.resolve(__dirname, '../../../packages/host-agent/bin/remote-deck-svc.exe'),
  };
}

function resolveSvcExe() {
  const p = servicePaths();
  for (const candidate of [p.exe, p.packaged, p.resPackaged, p.fallbackExe]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return '';
}

async function runElevatedBat(commands) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const batPath = path.join(app.getPath('temp'), `remotedeck-uac-${stamp}.cmd`);
  const logPath = path.join(app.getPath('temp'), `remotedeck-uac-${stamp}.log`);
  const lines = ['@echo off', 'chcp 65001 >nul'];
  for (const cmd of commands) {
    lines.push(`(${cmd}) >> "${logPath}" 2>&1`);
    lines.push('if errorlevel 1 exit /b 1');
  }
  const content = `${lines.join('\r\n')}\r\n`;
  await fs.writeFile(batPath, content, 'utf8');
  try {
    const escaped = batPath.replace(/'/g, "''");
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `$p = Start-Process -FilePath '${escaped}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch (err) {
    let detail = '';
    try {
      detail = (await fs.readFile(logPath, 'utf8')).trim();
    } catch {}
    throw new Error(detail || String(err?.message || err));
  } finally {
    void fs.rm(batPath, { force: true }).catch(() => {});
    void fs.rm(logPath, { force: true }).catch(() => {});
  }
}

function taskExists(name) {
  try {
    execFileSync('schtasks', ['/Query', '/TN', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return true;
  } catch (err) {
    const msg = `${err?.stderr || ''}\n${err?.stdout || ''}\n${err?.message || ''}`;
    if (/access is denied|拒绝访问/i.test(msg)) {
      return true;
    }
    return false;
  }
}

// Another RemoteDeck host may already be serving the preferred LAN port (for
// example the SYSTEM-session boot service). In that case this instance becomes
// a UI-only client of it instead of starting a second "ghost" host on a
// random port that phones cannot discover.
async function probeLocalHost(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.service === 'remote-deck-host' ? body : null;
  } catch {
    return null;
  }
}

// Drops the redundant "start RemoteDeck on logon" entries. The boot service is
// the single owner of the host, so these would only fight it for the LAN port.
async function clearLogonAutostart() {
  try {
    execFileSync('schtasks', ['/Delete', '/TN', AUTOSTART_TASK, '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {}
  // The task may have been registered with RunLevel=HighestAvailable, which a
  // non-elevated process cannot delete; retry through the UAC helper.
  if (taskExists(AUTOSTART_TASK)) {
    try {
      await runElevatedBat([`schtasks /Delete /TN "${AUTOSTART_TASK}" /F`]);
    } catch (err) {
      console.warn(`[remote-deck] could not remove ${AUTOSTART_TASK}: ${err?.message || err}`);
    }
  }
  try {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false });
  } catch {}
}

function svcProcessRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq remote-deck-svc.exe'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /remote-deck-svc\.exe/i.test(out);
  } catch {
    return false;
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Boot-time SYSTEM task that runs the watchdog and keeps the agent alive. */
function bootTaskXml(svcExe, args) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RemoteDeck boot watchdog (keeps the host agent reachable)</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT8S</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(svcExe)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * LAN clients cannot reach the host unless Windows lets inbound traffic through.
 * The active network is often classified "Public", where inbound is blocked by
 * default — the phone then silently falls back to the Tailscale overlay and every
 * frame takes an extra internet detour (high latency, low throughput).
 *
 * The app runs with highest available privileges, so it can install the rules
 * itself instead of leaving users to discover netsh.
 */
function ensureLanFirewallRules() {
  if (process.platform !== 'win32') return;
  const rules = [
    { name: 'RemoteDeck Host (TCP 9601)', protocol: 'TCP', port: 9601 },
    { name: 'RemoteDeck Discovery (UDP 9602)', protocol: 'UDP', port: 9602 },
  ];
  for (const rule of rules) {
    try {
      const existing = execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${rule.name}`], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      });
      if (/RemoteDeck/i.test(existing)) continue;
    } catch {
      // Not present (or netsh could not read it) — fall through and try to add.
    }
    try {
      execFileSync(
        'netsh',
        [
          'advfirewall', 'firewall', 'add', 'rule',
          `name=${rule.name}`,
          'dir=in', 'action=allow',
          `protocol=${rule.protocol}`,
          `localport=${rule.port}`,
          'profile=private,public',
          'remoteip=localsubnet',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 },
      );
      console.log(`[remote-deck] added firewall rule: ${rule.name}`);
    } catch (err) {
      console.warn(`[remote-deck] could not add firewall rule ${rule.name}: ${err.message}`);
    }
  }
}

/** Write a logon-trigger task that starts RemoteDeck with the highest available privileges. */
async function writeAutostartTaskXml(exePath) {
  const user = `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`.replace(/^\\/, '');
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RemoteDeck host agent (highest privileges, logon)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(exePath)}</Command>
    </Exec>
  </Actions>
</Task>`;
  const xmlPath = path.join(app.getPath('temp'), `remotedeck-task-${Date.now()}.xml`);
  await fs.writeFile(xmlPath, Buffer.from(`\ufeff${xml}`, 'utf16le'));
  return xmlPath;
}

async function loadSettings() {
  const userData = app.getPath('userData');
  const perUser = path.join(userData, 'settings.json');
  // The boot guardian runs as SYSTEM and therefore has its own %APPDATA%; the
  // relay settings must be shared or that instance comes up with no relay at all
  // and never appears in the device list.
  const sharedDir = (() => {
    const base = process.env.ProgramData || path.join(process.env.SystemDrive || 'C:', 'ProgramData');
    return path.join(base, 'RemoteDeck');
  })();
  const shared = path.join(sharedDir, 'settings.json');

  settingsPath = shared;
  try {
    const raw = await fs.readFile(shared, 'utf8');
    desktopSettings = { ...desktopSettings, ...JSON.parse(raw) };
    return;
  } catch {}

  // Migrate the per-user file once so existing installs keep their relay.
  try {
    const raw = await fs.readFile(perUser, 'utf8');
    desktopSettings = { ...desktopSettings, ...JSON.parse(raw) };
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(shared, JSON.stringify(desktopSettings, null, 2), 'utf8');
  } catch {}
}

async function saveSettings() {
  if (!settingsPath) return;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(desktopSettings, null, 2), 'utf8');
}

function broadcastStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rd:host-status', status);
  }
  refreshTrayMenu(status);
}

function refreshTrayMenu(status) {
  if (!tray) return;
  const st = status || agent?.getHostStatus();
  const menu = Menu.buildFromTemplate([
    {
      label: st ? `设备 ID: ${st.deviceId}` : 'RemoteDeck 运行中',
      enabled: false,
    },
    {
      label: st ? `配对码: ${st.pin || '—'}` : '',
      visible: Boolean(st),
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '打开 RemoteDeck 主界面',
      click: () => showMainWindow(),
    },
    {
      label: '复制设备 ID 与配对码',
      click: () => {
        if (st) {
          clipboard.writeText(`设备ID: ${st.deviceId}\n配对码: ${st.pin}`);
        }
      },
    },
    {
      label: st?.quickTunnelEnabled ? '关闭外网公网隧道' : '开启外网公网隧道 (Cloudflare)',
      click: async () => {
        if (!agent) return;
        desktopSettings.quickTunnel = !agent.enableQuickTunnel;
        agent.setQuickTunnel(desktopSettings.quickTunnel);
        await saveSettings();
      },
    },
    { type: 'separator' },
    {
      label: '退出 RemoteDeck',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Path of the shared identity file used by both the GUI and the SYSTEM watchdog. */
async function ensureSharedIdentity(userData) {
  const sharedDir = servicePaths().dir;
  const shared = path.join(sharedDir, 'agent-identity.json');
  const legacy = path.join(userData, 'agent-identity.json');
  try {
    await fs.mkdir(sharedDir, { recursive: true });
    if (!existsSync(shared) && existsSync(legacy)) {
      // First run after upgrading: migrate the existing identity so the PIN stays valid.
      await fs.copyFile(legacy, shared);
    }
  } catch {
    // ProgramData not writable (portable run) -> fall back to the per-user path.
    if (existsSync(legacy)) return legacy;
    return path.join(userData, 'agent-identity.json');
  }
  return shared;
}

async function startHostAgent() {
  ensureLanFirewallRules();
  const userData = app.getPath('userData');
  // Identity must be shared: the SYSTEM-session watchdog and the normal desktop
  // app are different accounts, otherwise the device ID / PIN would differ.
  const identityPath = await ensureSharedIdentity(app.getPath('userData'));
  const preferredPort = isSmokeTest ? 0 : 9601;

  const makeAgent = (port) =>
    new HostAgent({
      lanPort: port,
      lanHost: '0.0.0.0',
      discoveryPort: isSmokeTest ? 0 : 9602,
      relayUrl: desktopSettings.relayUrl || '',
      relaySecret: desktopSettings.relaySecret || '',
      quickTunnel: desktopSettings.quickTunnel,
      tsnetEnabled: desktopSettings.tsnetEnabled,
      tsnetAuthKey: desktopSettings.tsnetAuthKey,
      tsnetStateDir: path.join(path.dirname(identityPath), 'tsnet-state'),
      tunnelToken: desktopSettings.tunnelToken,
      tunnelHostname: desktopSettings.tunnelHostname,
      requireApproval: desktopSettings.requireApproval,
      autoRotatePin: desktopSettings.autoRotatePin,
      permissions: desktopSettings.permissions,
      configPath: identityPath,
      webDistDir,
      onStatusChange: (st) => broadcastStatus(st),
      onApproveSession: async ({ channel }) => {
        if (isSmokeTest) return true;
        const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        if (win) showMainWindow();
        const result = await Promise.race([
          dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['允许远程控制', '拒绝'],
            defaultId: 0,
            cancelId: 1,
            title: 'RemoteDeck 连接请求',
            message: '检测到新的远程设备请求控制本机',
            detail: `连接方式: ${channel === 'webrtc' ? 'P2P 直连' : channel === 'relay' ? '外网中继' : '局域网直连'}`,
            noLink: true,
          }),
          new Promise((resolve) => setTimeout(() => resolve({ response: 1 }), 25000)),
        ]);
        return result.response === 0;
      },
    });

  // The LAN port must stay stable: phones cache the host address and the tsnet
  // tunnel forwards to it. A previous instance may still be releasing the port
  // when the boot-service watchdog starts us, so retry before giving up.
  if (preferredPort === 0) {
    agent = makeAgent(0);
    return await agent.start();
  }

  // A second launch (single-instance lock held by the headless boot service)
  // just borrows that host so the window still works.
  if (uiOnlyInstance) {
    const existing = await probeLocalHost(preferredPort);
    if (existing && existing.deviceId) {
      return { ...existing, lanPort: preferredPort, pin: '', reusedHost: true };
    }
  }

  const retryDelays = [250, 500, 750, 1000, 1000, 1000, 1000, 1000];
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const candidate = makeAgent(preferredPort);
    try {
      const status = await candidate.start();
      agent = candidate;
      return status;
    } catch (err) {
      lastErr = err;
      await candidate.stop().catch(() => {});
      if (!err || err.code !== 'EADDRINUSE') throw err;
      const delay = retryDelays[attempt];
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Still busy: if the occupant is another RemoteDeck host on this machine, run
  // as a UI client of it instead of becoming an undiscoverable ghost host.
  const other = await probeLocalHost(preferredPort);
  if (other && other.deviceId) {
    console.warn(
      `[remote-deck] port ${preferredPort} is already served by RemoteDeck host ` +
        `${other.deviceId}; this instance will show its UI instead of starting a second agent.`,
    );
    return {
      ...other,
      lanPort: preferredPort,
      pin: '',
      reusedHost: true,
    };
  }

  console.warn(
    `[remote-deck] port ${preferredPort} stayed busy (${lastErr?.message || lastErr}); ` +
      'falling back to a random port — the phone must rediscover this host.',
  );
  agent = makeAgent(0);
  return await agent.start();
}

function registerIpc() {
  ipcMain.handle('rd:get-host-status', () => agent?.getHostStatus() || null);
  ipcMain.handle('rd:regenerate-pin', async () => await agent?.regeneratePin());
  ipcMain.handle('rd:set-permissions', async (_ev, perms) => {
    const next = agent?.setPermissions(perms);
    desktopSettings.permissions = next;
    await saveSettings();
    return next;
  });
  ipcMain.handle('rd:set-quick-tunnel', async (_ev, enabled) => {
    desktopSettings.quickTunnel = Boolean(enabled);
    agent?.setQuickTunnel(desktopSettings.quickTunnel);
    await saveSettings();
    return agent?.getHostStatus();
  });
  ipcMain.handle('rd:set-relay-config', async (_ev, cfg) => {
    desktopSettings.relayUrl = String(cfg?.relayUrl || '').trim();
    desktopSettings.relaySecret = String(cfg?.relaySecret || '').trim();
    agent?.setRelayConfig({
      relayUrl: desktopSettings.relayUrl,
      relaySecret: desktopSettings.relaySecret,
    });
    await saveSettings();
    return agent?.getHostStatus();
  });
  ipcMain.handle('rd:get-relay-config', () => ({
    relayUrl: desktopSettings.relayUrl || '',
    relaySecret: desktopSettings.relaySecret || '',
  }));
  ipcMain.handle('rd:set-tsnet-config', async (_ev, cfg) => {
    if (typeof cfg?.enabled === 'boolean') {
      desktopSettings.tsnetEnabled = cfg.enabled;
    }
    if (typeof cfg?.authKey === 'string') {
      desktopSettings.tsnetAuthKey = cfg.authKey.trim();
    }
    agent?.setTsnetConfig({
      enabled: desktopSettings.tsnetEnabled,
      authKey: desktopSettings.tsnetAuthKey,
    });
    await saveSettings();
    return agent?.getHostStatus();
  });
  ipcMain.handle('rd:logout-tsnet', async () => {
    desktopSettings.tsnetEnabled = false;
    desktopSettings.tsnetAuthKey = '';
    agent?.logoutTsnet();
    await saveSettings();
    return agent?.getHostStatus();
  });
  ipcMain.handle('rd:set-security', async (_ev, sec) => {
    const next = agent?.setSecurityOptions(sec);
    if (typeof next?.requireApproval === 'boolean') desktopSettings.requireApproval = next.requireApproval;
    if (typeof next?.autoRotatePin === 'boolean') desktopSettings.autoRotatePin = next.autoRotatePin;
    await saveSettings();
    return agent?.getHostStatus();
  });
  ipcMain.handle('rd:set-privacy', async (_ev, enabled) => {
    try {
      await agent?.setPrivacy(Boolean(enabled));
      return { ok: true, status: agent?.getHostStatus() };
    } catch (err) {
      return { ok: false, error: err?.message || '隐私黑屏开启失败', status: agent?.getHostStatus() };
    }
  });
  ipcMain.handle('rd:relaunch-admin', async () => {
    if (process.platform !== 'win32') return false;
    try {
      const exe = process.execPath.replace(/'/g, "''");
      const args = app.isPackaged
        ? ''
        : ` -ArgumentList '${process.argv.slice(1).map((a) => a.replace(/'/g, "''")).join("','")}'`;
      isQuitting = true;
      await agent?.stop().catch(() => {});
      spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${exe}'${args} -Verb RunAs`],
        { detached: true, stdio: 'ignore', windowsHide: true },
      ).unref();
      app.quit();
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('rd:set-tunnel-config', async (_ev, cfg) => {
    desktopSettings.tunnelToken = String(cfg?.token || '').trim();
    desktopSettings.tunnelHostname = String(cfg?.hostname || '').trim();
    agent?.setTunnelConfig({
      token: desktopSettings.tunnelToken,
      hostname: desktopSettings.tunnelHostname,
    });
    await saveSettings();
    return agent?.getHostStatus();
  });
  ipcMain.handle('rd:get-tunnel-config', () => ({
    token: desktopSettings.tunnelToken || '',
    hostname: desktopSettings.tunnelHostname || '',
    named: Boolean(desktopSettings.tunnelToken),
  }));
  ipcMain.handle('rd:get-admin-autostart', () => {
    if (process.platform !== 'win32') return false;
    try {
      execFileSync('schtasks', ['/Query', '/TN', AUTOSTART_TASK], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('rd:set-admin-autostart', async (_ev, enabled) => {
    if (process.platform !== 'win32') return false;
    try {
      if (enabled) {
        // Register via task XML so quoting and RunLevel are exact (schtasks /TR
        // mangles paths with spaces on some Windows builds).
        const xmlPath = await writeAutostartTaskXml(process.execPath);
        try {
          try {
            execFileSync('schtasks', ['/Create', '/TN', AUTOSTART_TASK, '/XML', xmlPath, '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          } catch {
            await runElevatedBat([
              `schtasks /Create /TN "${AUTOSTART_TASK}" /XML "${xmlPath}" /F`,
            ]);
          }
        } finally {
          await fs.rm(xmlPath, { force: true }).catch(() => {});
        }
      } else {
        try {
          execFileSync('schtasks', ['/Delete', '/TN', AUTOSTART_TASK, '/F'], { stdio: 'ignore', windowsHide: true });
        } catch {
          await runElevatedBat([
            `schtasks /Delete /TN "${AUTOSTART_TASK}" /F`,
          ]);
        }
      }
      try {
        execFileSync('schtasks', ['/Query', '/TN', AUTOSTART_TASK], { stdio: 'ignore', windowsHide: true });
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  });
  ipcMain.handle('rd:get-service-status', async () => {
    if (process.platform !== 'win32') return { supported: false };
    const p = servicePaths();
    let mode = 'user';
    try {
      const raw = JSON.parse(await fs.readFile(p.config, 'utf8'));
      if (raw.systemSession) mode = 'system';
    } catch {}
    const running = svcProcessRunning();
    return {
      supported: true,
      installed: taskExists(BOOT_TASK) || running,
      running,
      mode,
      elevated: Boolean(agent?.elevated),
      exeAvailable: Boolean(resolveSvcExe()),
    };
  });

  ipcMain.handle('rd:install-service', async (_ev, mode = 'user') => {
    if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
    const p = servicePaths();
    const svcExe = resolveSvcExe();
    if (!svcExe) return { ok: false, error: '未找到 remote-deck-svc.exe（请先运行 npm run build:native）' };
    try {
      await fs.mkdir(p.dir, { recursive: true });
      await fs.writeFile(
        p.config,
        JSON.stringify(
          {
            appPath: process.execPath,
            args: mode === 'system' ? ['--secure-desktop'] : [],
            restart: true,
            systemSession: mode === 'system',
          },
          null,
          2,
        ),
        'utf8',
      );

    const stagedSvcExe = path.join(p.dir, 'remote-deck-svc.exe');
      let targetSvcExe = stagedSvcExe;
      try {
        await fs.copyFile(svcExe, stagedSvcExe);
      } catch {
        try {
          await fs.access(stagedSvcExe);
        } catch {
          targetSvcExe = svcExe;
        }
      }

    const args = `--config "${p.config}"${mode === 'system' ? ' --system-session' : ''}`;
      const xml = bootTaskXml(targetSvcExe, args);
      const xmlPath = path.join(app.getPath('temp'), `remotedeck-boot-${Date.now()}.xml`);
      await fs.writeFile(xmlPath, Buffer.from(`\ufeff${xml}`, 'utf16le'));
      try {
        try {
          execFileSync('schtasks', ['/Create', '/TN', BOOT_TASK, '/XML', xmlPath, '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          execFileSync('schtasks', ['/Run', '/TN', BOOT_TASK], { stdio: 'ignore', windowsHide: true });
        } catch {
          await runElevatedBat([
            `schtasks /Create /TN "${BOOT_TASK}" /XML "${xmlPath}" /F`,
            `schtasks /Run /TN "${BOOT_TASK}"`,
          ]);
        }
      } finally {
        await fs.rm(xmlPath, { force: true }).catch(() => {});
      }
      if (!taskExists(BOOT_TASK)) {
        return { ok: false, error: '计划任务未创建（可能未授予管理员权限）' };
      }
      // The boot service is now the single owner of the host; remove the logon
      // autostart entries so a second instance cannot fight it for the LAN port.
      await clearLogonAutostart();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('rd:uninstall-service', async () => {
    if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
    try {
      let directOk = true;
      try {
        try { execFileSync('schtasks', ['/End', '/TN', BOOT_TASK], { stdio: 'ignore', windowsHide: true }); } catch {}
        execFileSync('schtasks', ['/Delete', '/TN', BOOT_TASK, '/F'], { stdio: 'ignore', windowsHide: true });
        try { execFileSync('taskkill', ['/IM', 'remote-deck-svc.exe', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
      } catch {
        directOk = false;
      }
      if (!directOk && taskExists(BOOT_TASK)) {
        await runElevatedBat([
          `schtasks /End /TN "${BOOT_TASK}" || ver >nul`,
          `schtasks /Delete /TN "${BOOT_TASK}" /F`,
          `taskkill /IM remote-deck-svc.exe /F || ver >nul`,
        ]);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('rd:get-auto-launch', () => {    if (!app.isPackaged) return false;
    return Boolean(app.getLoginItemSettings().openAtLogin);
  });
  ipcMain.handle('rd:set-auto-launch', (_ev, enabled) => {
    const openAtLogin = Boolean(enabled);
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin });
      return Boolean(app.getLoginItemSettings().openAtLogin);
    }
    return false;
  });
}

app.on('second-instance', () => {
  showMainWindow();
});

app.whenReady().then(async () => {
  await loadSettings();
  registerIpc();
  const status = await startHostAgent();

  // Windows groups taskbar buttons by AppUserModelID; without an explicit one
  // the packaged app inherits electron.exe's identity and shows its icon.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.remotedeck.desktop');
  }
  app.setName('RemoteDeck');

  const iconPath = path.join(__dirname, '..', 'assets', 'remotedeck.ico');
  const iconImg = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromBuffer(buildAppIconPng(64));

  if (!isSmokeTest) {
    tray = new Tray(iconImg);
    tray.setToolTip(`RemoteDeck (${status.deviceId})`);
    tray.on('double-click', () => showMainWindow());
    refreshTrayMenu(status);
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    show: !isSmokeTest,
    backgroundColor: '#0b0f17',
    title: 'RemoteDeck · 远程桌面与多端工作台',
    icon: iconImg,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && !isSmokeTest) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${status.lanPort}/`);

  if (isSmokeTest) {
    const check = await mainWindow.webContents.executeJavaScript(
      `Promise.all([
        window.remoteDeckDesktop.getHostStatus(),
        new Promise(r => setTimeout(() => r({
          hasHostCard: !!document.querySelector('.host-desk-card'),
          hasQrImg: !!document.querySelector('.qr-img'),
          title: document.title,
          deviceIdText: document.body.innerText.includes(${JSON.stringify(status.deviceId)})
        }), 500))
      ])`,
    );
    console.log('SMOKE_TEST_OK:', JSON.stringify(check));
    isQuitting = true;
    await agent.stop();
    app.quit();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (agent) {
    await agent.stop().catch(() => {});
  }
});
