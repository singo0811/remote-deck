import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.resolve(__dirname, '..', 'native');
const binDir = path.resolve(__dirname, '..', 'bin');
fs.mkdirSync(binDir, { recursive: true });

const exeName = process.platform === 'win32' ? 'remote-native.exe' : 'remote-native';
const outPath = path.join(binDir, exeName);

console.log(`Building native helper -> ${outPath}`);
execFileSync('go', ['build', '-o', outPath, '.'], {
  cwd: nativeDir,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0' },
});
console.log('Native helper built successfully.');

// Boot watchdog (LocalSystem) that keeps the agent alive in the user session.
if (process.platform === 'win32') {
  const svcOut = path.join(binDir, 'remote-deck-svc.exe');
  console.log(`Building boot watchdog -> ${svcOut}`);
  execFileSync('go', ['build', '-o', svcOut, './svc'], {
    cwd: nativeDir,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0' },
  });
  console.log('Boot watchdog built successfully.');
}
