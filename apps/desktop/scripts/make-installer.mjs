/**
 * Build a per-user Windows installer from the packaged app.
 *
 * There is no NSIS/Inno Setup on the build machine, so the installer is a
 * self-contained folder with two scripts: 安装.cmd copies the app into
 * %LOCALAPPDATA%\Programs\RemoteDeck, creates shortcuts, registers an uninstall
 * entry, and launches the app. 卸载.cmd reverses all of it.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const srcDir = path.join(repoRoot, 'dist', 'RemoteDeck-win32-x64');
const version = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')).version || '1.0.0';
const outRoot = path.join(repoRoot, 'dist', 'installers');
const payloadDir = path.join(outRoot, 'RemoteDeck-Setup', 'payload');
const setupDir = path.join(outRoot, 'RemoteDeck-Setup');

if (!existsSync(srcDir)) {
  console.error(`Package first: ${srcDir} is missing (npm run package:win)`);
  process.exit(1);
}

await fs.rm(setupDir, { recursive: true, force: true });
await fs.mkdir(payloadDir, { recursive: true });
await fs.cp(srcDir, payloadDir, { recursive: true });

const installCmd = `@echo off
setlocal EnableExtensions
title RemoteDeck ${version} 安装
set "SRC=%~dp0payload"
set "DEST=%LOCALAPPDATA%\\Programs\\RemoteDeck-${version}"
set "EXE=%DEST%\\RemoteDeck.exe"
set "ICON=%DEST%\\resources\\app\\apps\\desktop\\assets\\remotedeck.ico"

echo.
echo   RemoteDeck ${version}
echo   ----------------------------------------
echo   安装目录: %DEST%
echo.

taskkill /IM RemoteDeck.exe /F >nul 2>&1

rem A previous install can leave file handles/ACLs behind (the SYSTEM watchdog
rem may still hold the old copy). Move it aside instead of deleting in place so
rem one unreadable file cannot poison the new install.
if exist "%DEST%" (
  echo   停用旧版本...
  set "OLD=%DEST%.old-%RANDOM%%RANDOM%"
  call :retire "%DEST%"
)
mkdir "%DEST%" >nul 2>&1

echo   复制文件...
robocopy "%SRC%" "%DEST%" /E /IS /NFL /NDL /NJH /NJS /NP /COPY:DAT >nul
if errorlevel 8 (
  echo   [失败] 复制文件出错，请检查磁盘空间。
  pause
  exit /b 1
)
rem Make sure the current user really owns every installed file.
icacls "%DEST%" /grant "%USERNAME%:(OI)(CI)F" /T /C /Q >nul 2>&1

echo   更新看护服务启动路径...
powershell -NoProfile -Command "$p=Join-Path $env:ProgramData 'RemoteDeck\\svc-config.json'; if (Test-Path $p) { try { $j = Get-Content $p -Raw | ConvertFrom-Json; $j.appPath = '%EXE%'; ($j | ConvertTo-Json -Depth 4) | Set-Content $p -Encoding utf8 } catch {} }" >nul 2>&1

echo   创建快捷方式...
set "PS=%TEMP%\\rd-shortcuts.ps1"
> "%PS%" echo $ws = New-Object -ComObject WScript.Shell
>>"%PS%" echo $desktop = [Environment]::GetFolderPath('Desktop')
>>"%PS%" echo $s = $ws.CreateShortcut("$desktop\\RemoteDeck.lnk")
>>"%PS%" echo $s.TargetPath = '%EXE%'
>>"%PS%" echo $s.WorkingDirectory = '%DEST%'
>>"%PS%" echo $s.IconLocation = '%ICON%,0'
>>"%PS%" echo $s.Description = 'RemoteDeck 远程桌面'
>>"%PS%" echo $s.Save()
>>"%PS%" echo $start = [Environment]::GetFolderPath('Programs')
>>"%PS%" echo $s2 = $ws.CreateShortcut("$start\\RemoteDeck.lnk")
>>"%PS%" echo $s2.TargetPath = '%EXE%'
>>"%PS%" echo $s2.WorkingDirectory = '%DEST%'
>>"%PS%" echo $s2.IconLocation = '%ICON%,0'
>>"%PS%" echo $s2.Description = 'RemoteDeck 远程桌面'
>>"%PS%" echo $s2.Save()
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" >nul 2>&1
del "%PS%" >nul 2>&1

echo   注册卸载项...
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /v DisplayName /d "RemoteDeck" /f >nul
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /v DisplayVersion /d "${version}" /f >nul
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /v Publisher /d "RemoteDeck" /f >nul
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /v DisplayIcon /d "%ICON%,0" /f >nul
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /v InstallLocation /d "%DEST%" /f >nul
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /v UninstallString /d "\\"%DEST%\\卸载.cmd\\"" /f >nul
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /v NoModify /t REG_DWORD /d 1 /f >nul
reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /v NoRepair /t REG_DWORD /d 1 /f >nul

if not exist "%DEST%\\卸载.cmd" copy /y "%~dp0卸载.cmd" "%DEST%\\卸载.cmd" >nul 2>&1

echo.
echo   安装完成，正在启动 RemoteDeck...
start "" "%EXE%"
timeout /t 2 >nul
exit /b 0

:retire
rem Best effort: move the directory aside, then try to delete it in the
rem background. If a file is not ours we simply leave the backup behind.
move "%~1" "%~1.retired" >nul 2>&1
if exist "%~1" (
  start "" /min cmd /c "timeout /t 1 >nul & rd /s /q \\"%~1\\""
)
exit /b 0
`;

const uninstallCmd = `@echo off
setlocal EnableExtensions
title RemoteDeck 卸载
set "DEST=%LOCALAPPDATA%\\Programs\\RemoteDeck-${version}"

echo.
echo   正在卸载 RemoteDeck...
taskkill /IM RemoteDeck.exe /F >nul 2>&1
taskkill /IM remote-deck-svc.exe /F >nul 2>&1

reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteDeck" /f >nul 2>&1

set "PS=%TEMP%\\rd-unshort.ps1"
> "%PS%" echo $desktop = [Environment]::GetFolderPath('Desktop')
>>"%PS%" echo $start = [Environment]::GetFolderPath('Programs')
>>"%PS%" echo Remove-Item -LiteralPath "$desktop\\RemoteDeck.lnk" -Force -ErrorAction SilentlyContinue
>>"%PS%" echo Remove-Item -LiteralPath "$start\\RemoteDeck.lnk" -Force -ErrorAction SilentlyContinue
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" >nul 2>&1
del "%PS%" >nul 2>&1

echo   删除程序文件...
for /d %%D in ("%LOCALAPPDATA%\\Programs\\RemoteDeck*") do (
  start "" /min cmd /c "timeout /t 2 >nul & rd /s /q \\"%%~fD\\""
)

echo   卸载完成。
timeout /t 2 >nul
exit /b 0
`;

await fs.writeFile(path.join(setupDir, '安装.cmd'), installCmd.replace(/\r?\n/g, '\r\n'), 'utf8');
await fs.writeFile(path.join(setupDir, '卸载.cmd'), uninstallCmd.replace(/\r?\n/g, '\r\n'), 'utf8');
await fs.writeFile(
  path.join(setupDir, '使用说明.txt'),
  [
    `RemoteDeck ${version}`,
    '',
    '安装：双击「安装.cmd」，会把程序装到 %LOCALAPPDATA%\\Programs\\RemoteDeck-<版本>，',
    '      并在桌面和开始菜单创建 RemoteDeck 快捷方式，然后自动启动。',
    '',
    '卸载：双击「卸载.cmd」，或从 Windows「设置 → 应用」里卸载 RemoteDeck。',
    '',
    '程序是免登录的用户安装，不需要管理员权限。',
  ].join('\r\n'),
  'utf8',
);

const zipPath = path.join(outRoot, `RemoteDeck-${version}-Setup-win-x64.zip`);
await fs.rm(zipPath, { force: true });
execFileSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${setupDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
], { stdio: 'inherit' });

console.log(`Installer folder: ${setupDir}`);
console.log(`Installer zip:    ${zipPath}`);
