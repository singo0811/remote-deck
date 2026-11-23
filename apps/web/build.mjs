import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const distDir = path.join(__dirname, 'dist');

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

// Copy static public assets
for (const entry of await fs.readdir(publicDir)) {
  await fs.copyFile(path.join(publicDir, entry), path.join(distDir, entry));
}

await esbuild.build({
  entryPoints: [path.join(__dirname, 'src/main.jsx')],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  target: ['es2020'],
  jsx: 'automatic',
  outfile: path.join(distDir, 'app.js'),
  loader: {
    '.js': 'jsx',
    '.jsx': 'jsx',
    '.css': 'css',
  },
});

console.log('Built apps/web -> apps/web/dist');
