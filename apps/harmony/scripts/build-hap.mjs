import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harmonyRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(harmonyRoot, '../..');
const stageDir = path.join(os.tmpdir(), 'remotedeck-harmony-build');
const outDir = path.join(repoRoot, 'dist/RemoteDeck-harmony');

const devEcoDefault = 'D:\\Program Files\\Huawei\\DevEco Studio';
const devEcoHome = process.env.DEVECO_STUDIO_HOME || devEcoDefault;
const ohpmBin = path.join(devEcoHome, 'tools/ohpm/bin/ohpm.bat');
const hvigorwBin = path.join(devEcoHome, 'tools/hvigor/bin/hvigorw.bat');
const sdkHome = process.env.DEVECO_SDK_HOME || path.join(devEcoHome, 'sdk');

if (!existsSync(hvigorwBin) || !existsSync(ohpmBin)) {
  throw new Error(
    `DevEco Studio CLI tools not found under "${devEcoHome}". Set DEVECO_STUDIO_HOME if installed elsewhere.`,
  );
}

console.log(`Staging HarmonyOS project -> ${stageDir}`);
const stageProfilePath = path.join(stageDir, 'build-profile.json5');
let preservedSigningConfigs = null;
if (existsSync(stageProfilePath)) {
  try {
    const existingProfile = JSON.parse(await fs.readFile(stageProfilePath, 'utf8'));
    if (Array.isArray(existingProfile?.app?.signingConfigs) && existingProfile.app.signingConfigs.length > 0) {
      preservedSigningConfigs = existingProfile.app.signingConfigs;
    }
  } catch {
    // Ignore non-JSON5 / parse errors
  }
}

await fs.mkdir(stageDir, { recursive: true });
await fs.cp(harmonyRoot, stageDir, {
  recursive: true,
  force: true,
  filter: (src) => {
    const rel = path.relative(harmonyRoot, src);
    if (!rel) return true;
    const parts = rel.split(path.sep);
    return !parts.includes('build') && !parts.includes('.hvigor') && !parts.includes('oh_modules') && parts[0] !== 'scripts';
  },
});

if (preservedSigningConfigs) {
  try {
    const stagedProfile = JSON.parse(await fs.readFile(stageProfilePath, 'utf8'));
    if (!Array.isArray(stagedProfile?.app?.signingConfigs) || stagedProfile.app.signingConfigs.length === 0) {
      stagedProfile.app.signingConfigs = preservedSigningConfigs;
      await fs.writeFile(stageProfilePath, `${JSON.stringify(stagedProfile, null, 2)}\n`, 'utf8');
      console.log('Preserved existing DevEco Studio signingConfigs in staged build-profile.json5');
    }
  } catch {
    // Ignore
  }
}

const env = {
  ...process.env,
  DEVECO_SDK_HOME: sdkHome,
};

function runTool(cmd, args) {
  const res = spawnSync('cmd.exe', ['/c', cmd, ...args], {
    cwd: stageDir,
    env,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
}

runTool(ohpmBin, ['install', '--all']);
runTool(hvigorwBin, ['assembleHap', '-p', 'product=default', '--no-daemon']);

const hapSrc = path.join(stageDir, 'entry/build/default/outputs/default/entry-default-unsigned.hap');
if (!existsSync(hapSrc)) {
  throw new Error(`Expected HAP output missing at ${hapSrc}`);
}

await fs.mkdir(outDir, { recursive: true });
const hapDst = path.join(outDir, 'RemoteDeck-entry-default-unsigned.hap');
await fs.copyFile(hapSrc, hapDst);
const st = await fs.stat(hapDst);
console.log(`Built HarmonyOS HAP (${st.size} bytes) -> ${hapDst}`);

const signedSrc = path.join(stageDir, 'entry/build/default/outputs/default/entry-default-signed.hap');
if (existsSync(signedSrc)) {
  const signedDst = path.join(outDir, 'RemoteDeck-entry-default-signed.hap');
  await fs.copyFile(signedSrc, signedDst);
  const signedSt = await fs.stat(signedDst);
  console.log(`Built signed HarmonyOS HAP (${signedSt.size} bytes) -> ${signedDst}`);
}
