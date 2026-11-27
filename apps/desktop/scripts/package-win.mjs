import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const electronDist = path.join(repoRoot, 'node_modules/electron/dist');
const customOutput = process.argv[2];
const outDir = customOutput ? path.resolve(customOutput) : path.join(repoRoot, 'dist/RemoteDeck-win32-x64');
const appDir = path.join(outDir, 'resources/app');
const appVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || '0.0.0';

if (!existsSync(electronDist)) {
  throw new Error(`Electron dist not found at ${electronDist}`);
}

const nativeExe = path.join(repoRoot, 'packages/host-agent/bin/remote-native.exe');
if (!existsSync(nativeExe)) {
  throw new Error(`Native helper missing at ${nativeExe}. Run "npm run build:native" first.`);
}

const webDist = path.join(repoRoot, 'apps/web/dist');
if (!existsSync(path.join(webDist, 'index.html'))) {
  throw new Error(`Web dist missing at ${webDist}. Run "npm run build" first.`);
}

console.log(`Packaging RemoteDeck -> ${outDir}`);
if (customOutput) {
  await fs.mkdir(outDir);
} else {
  await fs.rm(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  await fs.mkdir(outDir, { recursive: true });
}

// 1. Copy Electron runtime and rename electron.exe -> RemoteDeck.exe
await fs.cp(electronDist, outDir, { recursive: true });
await fs.rename(path.join(outDir, 'electron.exe'), path.join(outDir, 'RemoteDeck.exe'));
await fs.rm(path.join(outDir, 'resources/default_app.asar'), { force: true });

// 2. Populate resources/app
await fs.mkdir(appDir, { recursive: true });
await fs.writeFile(
  path.join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: 'remote-deck-desktop',
      version: appVersion,
      private: true,
      type: 'module',
      main: 'apps/desktop/src/main.mjs',
    },
    null,
    2,
  ),
  'utf8',
);

await fs.cp(path.join(repoRoot, 'apps/desktop/src'), path.join(appDir, 'apps/desktop/src'), { recursive: true });
await fs.cp(path.join(repoRoot, 'apps/desktop/assets'), path.join(appDir, 'apps/desktop/assets'), { recursive: true });
await fs.cp(webDist, path.join(appDir, 'apps/web/dist'), { recursive: true });

// Copy workspace packages into node_modules/@remote-deck/* (physical copies, no symlinks)
const sharedDest = path.join(appDir, 'node_modules/@remote-deck/shared');
await fs.mkdir(sharedDest, { recursive: true });
await fs.cp(path.join(repoRoot, 'packages/shared/package.json'), path.join(sharedDest, 'package.json'));
await fs.cp(path.join(repoRoot, 'packages/shared/src'), path.join(sharedDest, 'src'), { recursive: true });

const agentDest = path.join(appDir, 'node_modules/@remote-deck/host-agent');
await fs.mkdir(agentDest, { recursive: true });
await fs.cp(path.join(repoRoot, 'packages/host-agent/package.json'), path.join(agentDest, 'package.json'));
await fs.cp(path.join(repoRoot, 'packages/host-agent/src'), path.join(agentDest, 'src'), { recursive: true });
await fs.cp(path.join(repoRoot, 'packages/host-agent/bin'), path.join(agentDest, 'bin'), { recursive: true });

// Bundle cloudflared.exe into packaged app if locally cached so WAN tunnel works offline/instantly
const localCloudflared = path.join(
  process.env.LOCALAPPDATA || '',
  'remote-deck',
  'bin',
  'cloudflared.exe',
);
const bundledCloudflared = path.join(agentDest, 'bin', 'cloudflared.exe');
if (!existsSync(bundledCloudflared) && localCloudflared && existsSync(localCloudflared)) {
  await fs.cp(localCloudflared, bundledCloudflared);
  console.log('Bundled cached cloudflared.exe into packaged bin/');
}

// 3. Copy runtime dependency closure (ws, werift, etc.) from root node_modules
const rootNodeModules = path.join(repoRoot, 'node_modules');
const appNodeModules = path.join(appDir, 'node_modules');
const visited = new Set();

async function copyPackageClosure(pkgName) {
  if (visited.has(pkgName) || pkgName.startsWith('@remote-deck/')) return;
  visited.add(pkgName);

  const srcPkgDir = path.join(rootNodeModules, pkgName);
  if (!existsSync(srcPkgDir)) return;

  const dstPkgDir = path.join(appNodeModules, pkgName);
  await fs.mkdir(path.dirname(dstPkgDir), { recursive: true });
  await fs.cp(srcPkgDir, dstPkgDir, { recursive: true, dereference: true });

  try {
    const pkgJson = JSON.parse(await fs.readFile(path.join(srcPkgDir, 'package.json'), 'utf8'));
    const deps = Object.keys(pkgJson.dependencies || {});
    for (const dep of deps) {
      await copyPackageClosure(dep);
    }
  } catch {}
}

const agentPkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'packages/host-agent/package.json'), 'utf8'));
for (const dep of Object.keys(agentPkg.dependencies || {})) {
  await copyPackageClosure(dep);
}

console.log(`Packaged ${visited.size} runtime npm modules + RemoteDeck.exe`);

// Keep the Windows guardian service pointed at the build we just wrote. It
// otherwise keeps relaunching a stale copy from whatever path it was installed
// with, which looks like "the new icon / UI never showed up". The installed
// copy under %LOCALAPPDATA% wins when present, because that is what the Start
// Menu shortcut and the uninstaller use.
try {
  const svcConfigPath = path.join(process.env.ProgramData || 'C:\\ProgramData', 'RemoteDeck', 'svc-config.json');
  if (existsSync(svcConfigPath)) {
    const raw = readFileSync(svcConfigPath, 'utf8').replace(/^\uFEFF/, '');
    const svcConfig = JSON.parse(raw);
    const exePath = path.join(outDir, 'RemoteDeck.exe');
    const installedPath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'RemoteDeck', 'RemoteDeck.exe');
    const desired = process.env.LOCALAPPDATA && existsSync(installedPath) ? installedPath : exePath;
    if (svcConfig.appPath !== desired) {
      svcConfig.appPath = desired;
      writeFileSync(svcConfigPath, JSON.stringify(svcConfig, null, 2), 'utf8');
      console.log(`Guardian service now launches: ${desired}`);
    }
  }
} catch (err) {
  console.log(`Guardian config not updated: ${err.message}`);
}

console.log(`Done: ${path.join(outDir, 'RemoteDeck.exe')}`);
