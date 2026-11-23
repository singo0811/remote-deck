import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZipBuffer } from '@remote-deck/shared';

const TEXT_PREVIEW_LIMIT = 256 * 1024;
const DOWNLOAD_CHUNK_BYTES = 64 * 1024;
const ZIP_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Filesystem service for browsing, previewing, uploading, and downloading host files.
 */
export class FileService {
  constructor(options = {}) {
    this.allowedRoots = Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0
      ? options.allowedRoots.map((r) => path.resolve(r))
      : null;
    this.activeUploads = new Map();
  }

  assertAllowed(targetPath) {
    const resolved = path.resolve(String(targetPath || ''));
    if (!this.allowedRoots) return resolved;
    const ok = this.allowedRoots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!ok) {
      throw new Error(`Access denied outside allowed roots: ${resolved}`);
    }
    return resolved;
  }

  async listRoots() {
    if (this.allowedRoots) {
      return this.allowedRoots.map((root) => ({
        name: root,
        path: root,
        kind: 'allowed',
      }));
    }

    const roots = [];
    const home = os.homedir();
    roots.push({ name: `主目录 (${path.basename(home) || home})`, path: home, kind: 'home' });

    const desktop = path.join(home, 'Desktop');
    try {
      await fs.access(desktop);
      roots.push({ name: '桌面 (Desktop)', path: desktop, kind: 'desktop' });
    } catch {}

    if (process.platform === 'win32') {
      for (let code = 67; code <= 90; code++) {
        const letter = String.fromCharCode(code);
        const drive = `${letter}:\\`;
        try {
          await fs.access(drive);
          roots.push({ name: `本地磁盘 (${letter}:)`, path: drive, kind: 'drive' });
        } catch {}
      }
    } else {
      roots.push({ name: '根目录 (/)', path: '/', kind: 'drive' });
    }
    return roots;
  }

  async listDir(targetPath) {
    const dir = this.assertAllowed(targetPath || os.homedir());
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await fs.stat(fullPath);
        isDir = st.isDirectory();
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // Inaccessible entry (e.g. Windows System Volume Information)
      }
      items.push({
        name: entry.name,
        path: fullPath,
        isDir,
        size,
        mtimeMs,
      });
    }

    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const parent = path.dirname(dir);
    return {
      path: dir,
      parent: parent !== dir ? parent : null,
      items,
    };
  }

  async mkdir(dirPath) {
    const target = this.assertAllowed(dirPath);
    await fs.mkdir(target, { recursive: true });
    return { path: target };
  }

  async rename(oldPath, newPath) {
    const src = this.assertAllowed(oldPath);
    const dst = this.assertAllowed(newPath);
    await fs.rename(src, dst);
    return { oldPath: src, newPath: dst };
  }

  async remove(targetPath) {
    const target = this.assertAllowed(targetPath);
    const parsed = path.parse(target);
    if (target === parsed.root) {
      throw new Error('Refusing to remove filesystem root');
    }
    await fs.rm(target, { recursive: true, force: false });
    return { path: target };
  }

  async readText(filePath) {
    const target = this.assertAllowed(filePath);
    const st = await fs.stat(target);
    if (st.isDirectory()) {
      throw new Error('Cannot preview a directory');
    }
    const fh = await fs.open(target, 'r');
    try {
      const readLen = Math.min(st.size, TEXT_PREVIEW_LIMIT);
      const buf = Buffer.allocUnsafe(readLen);
      const { bytesRead } = await fh.read(buf, 0, readLen, 0);
      return {
        path: target,
        size: st.size,
        truncated: st.size > TEXT_PREVIEW_LIMIT,
        content: buf.subarray(0, bytesRead).toString('utf8'),
      };
    } finally {
      await fh.close();
    }
  }

  async writeText(filePath, content) {
    const target = this.assertAllowed(filePath);
    await fs.writeFile(target, String(content ?? ''), 'utf8');
    const st = await fs.stat(target);
    return { path: target, size: st.size };
  }

  async streamDownload(filePath, transferId, emitChunk) {
    const target = this.assertAllowed(filePath);
    const st = await fs.stat(target);
    if (st.isDirectory()) {
      throw new Error('Cannot download a directory directly');
    }
    const fh = await fs.open(target, 'r');
    try {
      let offset = 0;
      const buf = Buffer.allocUnsafe(DOWNLOAD_CHUNK_BYTES);
      if (st.size === 0) {
        await emitChunk({
          transferId,
          fileName: path.basename(target),
          offset: 0,
          total: 0,
          done: true,
        }, Buffer.alloc(0));
        return;
      }
      while (offset < st.size) {
        const { bytesRead } = await fh.read(buf, 0, DOWNLOAD_CHUNK_BYTES, offset);
        if (bytesRead <= 0) break;
        const nextOffset = offset + bytesRead;
        const done = nextOffset >= st.size;
        await emitChunk({
          transferId,
          fileName: path.basename(target),
          offset,
          total: st.size,
          done,
        }, buf.subarray(0, bytesRead));
        offset = nextOffset;
      }
    } finally {
      await fh.close();
    }
  }

  async startUpload({ transferId, dirPath, fileName, total = 0, offset = 0 }) {
    const dir = this.assertAllowed(dirPath);
    const safeName = path.basename(String(fileName || 'upload.bin'));
    const destPath = this.assertAllowed(path.join(dir, safeName));
    await fs.mkdir(dir, { recursive: true });
    const resumeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    if (resumeOffset > 0) {
      // Resume: keep the bytes already received and continue appending.
      const existing = await fs.stat(destPath).catch(() => null);
      const keep = existing ? Math.min(existing.size, resumeOffset) : 0;
      await fs.truncate(destPath, keep).catch(() => {});
      const stream = createWriteStream(destPath, { flags: 'a' });
      this.activeUploads.set(transferId, { destPath, stream, written: keep, total });
      return { transferId, path: destPath, offset: keep };
    }
    const stream = createWriteStream(destPath);
    this.activeUploads.set(transferId, { destPath, stream, written: 0, total });
    return { transferId, path: destPath, offset: 0 };
  }

  async #collectZipEntries(targets, baseRoot, out, state) {
    for (const target of targets) {
      const full = this.assertAllowed(target);
      const st = await fs.stat(full).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        const children = await fs.readdir(full).catch(() => []);
        for (const child of children) {
          await this.#collectZipEntries([path.join(full, child)], baseRoot, out, state);
        }
        continue;
      }
      if (!st.isFile()) continue;
      if (state.bytes + st.size > state.maxBytes) {
        state.truncated = true;
        continue;
      }
      const data = await fs.readFile(full);
      state.bytes += data.length;
      const rel = path.relative(baseRoot, full) || path.basename(full);
      out.push({ name: rel, data, mtimeMs: st.mtimeMs });
    }
  }

  /**
   * Pack one or more files/directories into a single ZIP and stream it as a normal
   * download, so phones/tablets can fetch a whole folder in one tap.
   */
  async streamZip(targets, transferId, emitChunk) {
    const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
    if (list.length === 0) throw new Error('没有选择要打包的文件');
    const roots = list.map((t) => this.assertAllowed(t));
    const baseRoot = roots.length === 1
      ? (await fs.stat(roots[0]).catch(() => null))?.isDirectory()
        ? path.dirname(roots[0])
        : path.dirname(roots[0])
      : path.dirname(roots[0]);

    const entries = [];
    const state = { bytes: 0, maxBytes: ZIP_MAX_BYTES, truncated: false };
    for (const root of roots) {
      await this.#collectZipEntries([root], baseRoot, entries, state);
    }
    if (entries.length === 0) {
      throw new Error('没有可打包的内容（可能全部超出 200MB 上限）');
    }

    const zip = buildZipBuffer(entries);
    const firstName = entries.length === 1
      ? entries[0].name.replace(/[\\/]/g, '_')
      : `remotedeck-${new Date().toISOString().slice(0, 10)}`;
    const fileName = `${firstName}.zip`;
    const total = zip.length;

    let offset = 0;
    while (offset < total) {
      const end = Math.min(total, offset + DOWNLOAD_CHUNK_BYTES);
      const done = end >= total;
      await emitChunk({ transferId, fileName, offset, total, done, zipped: true }, zip.subarray(offset, end));
      offset = end;
    }
    return { fileName, size: total, files: entries.length, truncated: state.truncated };
  }

  async appendUploadChunk(transferId, chunk) {
    const entry = this.activeUploads.get(transferId);
    if (!entry) throw new Error(`Unknown upload transferId: ${transferId}`);
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    await new Promise((resolve, reject) => {
      entry.stream.write(buf, (err) => (err ? reject(err) : resolve()));
    });
    entry.written += buf.length;
    return { written: entry.written, total: entry.total };
  }

  async finishUpload(transferId) {
    const entry = this.activeUploads.get(transferId);
    if (!entry) throw new Error(`Unknown upload transferId: ${transferId}`);
    this.activeUploads.delete(transferId);
    await new Promise((resolve, reject) => {
      entry.stream.end((err) => (err ? reject(err) : resolve()));
    });
    return { path: entry.destPath, size: entry.written };
  }

  closeAllUploads() {
    for (const entry of this.activeUploads.values()) {
      try {
        entry.stream.destroy();
      } catch {}
    }
    this.activeUploads.clear();
  }
}
