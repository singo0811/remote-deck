import React, { useEffect, useRef, useState } from 'react';
import { FRAME_KIND, MSG } from '../lib/protocol.js';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

const UPLOAD_CHUNK = 64 * 1024;

export function FilePanel({ tier, transport, fsEventsRef, fsTick, onNotify }) {
  const [roots, setRoots] = useState([]);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null); // { path, content, truncated }
  const [selected, setSelected] = useState(() => new Set());
  const [uploads, setUploads] = useState([]); // [{ name, pct, state, sentBytes, file, total }]
  const [dragging, setDragging] = useState(false);
  const lastSeqRef = useRef(0);
  const fileInputRef = useRef(null);
  const draggingCountRef = useRef(0);
  const pendingStartsRef = useRef(new Map());

  const sendFs = (type, extra = {}) => {
    const reqId = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    transport.sendJson({ type, reqId, ...extra });
    return reqId;
  };

  const openDir = (dirPath) => {
    setLoading(true);
    setSelected(new Set());
    sendFs(MSG.FS_LIST, { path: dirPath });
  };

  useEffect(() => {
    sendFs(MSG.FS_ROOTS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const list = fsEventsRef.current || [];
    while (lastSeqRef.current < list.length) {
      const ev = list[lastSeqRef.current];
      lastSeqRef.current += 1;

      if (ev.type === MSG.FS_ERROR) {
        setLoading(false);
        onNotify?.(`文件操作失败: ${ev.error}`);
        continue;
      }

      if (ev.op === 'roots') {
        setRoots(ev.roots || []);
        if (!currentPath && ev.roots?.[0]?.path) {
          openDir(ev.roots[0].path);
        }
      } else if (ev.op === 'list') {
        setLoading(false);
        setCurrentPath(ev.path || '');
        setParentPath(ev.parent || null);
        setItems(ev.items || []);
      } else if (ev.op === 'read_text') {
        setPreview({ path: ev.path, content: ev.content, truncated: ev.truncated });
      } else if (ev.op === 'write_text') {
        onNotify?.('文件已保存');
        setPreview(null);
        openDir(currentPath);
      } else if (ev.op === 'mkdir' || ev.op === 'rename' || ev.op === 'delete') {
        openDir(currentPath);
      } else if (ev.op === 'upload_start') {
        const waiter = pendingStartsRef.current.get(ev.transferId);
        if (waiter) {
          pendingStartsRef.current.delete(ev.transferId);
          waiter(ev);
        }
      } else if (ev.op === 'upload_done') {
        onNotify?.(`上传完成: ${ev.path}`);
        setUploads((prev) => prev.map((u) => (u.state === 'uploading' ? { ...u, pct: 100, state: 'done' } : u)));
        openDir(currentPath);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fsTick]);

  const handleMkdir = () => {
    const name = window.prompt('输入新文件夹名称:');
    if (!name) return;
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const target = currentPath.endsWith(sep) ? `${currentPath}${name}` : `${currentPath}${sep}${name}`;
    sendFs(MSG.FS_MKDIR, { path: target });
  };

  const handleRename = (item) => {
    const nextName = window.prompt('输入新名称:', item.name);
    if (!nextName || nextName === item.name) return;
    const sep = item.path.includes('\\') ? '\\' : '/';
    const dir = item.path.slice(0, item.path.lastIndexOf(sep));
    const newPath = `${dir}${sep}${nextName}`;
    sendFs(MSG.FS_RENAME, { oldPath: item.path, newPath });
  };

  const handleDelete = (item) => {
    if (!window.confirm(`确认删除 "${item.name}"？`)) return;
    sendFs(MSG.FS_DELETE, { path: item.path });
  };

  const toggleSelect = (itemPath) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemPath)) next.delete(itemPath);
      else next.add(itemPath);
      return next;
    });
  };

  const selectAll = () => {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.path))));
  };

  const handleZipDownload = () => {
    const paths = selected.size > 0 ? [...selected] : (currentPath ? [currentPath] : []);
    if (paths.length === 0) return;
    const transferId = `zip-${Date.now()}`;
    notify(`正在打包 ${paths.length} 项...`);
    sendFs(MSG.FS_ZIP_DOWNLOAD, { paths, transferId });
  };

  const notify = (msg) => onNotify?.(msg);

  const uploadOne = async (file, resumeOffset = 0) => {
    const transferId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;

    // Wait for the host to create/truncate the destination file first, otherwise
    // early binary chunks can arrive before the upload is registered.
    const startAck = new Promise((resolve) => {
      pendingStartsRef.current.set(transferId, resolve);
      setTimeout(() => {
        if (pendingStartsRef.current.has(transferId)) {
          pendingStartsRef.current.delete(transferId);
          resolve(null);
        }
      }, 6000);
    });

    sendFs(MSG.FS_UPLOAD_START, {
      transferId,
      dirPath: currentPath,
      fileName: file.name,
      total: file.size,
      offset: resumeOffset,
    });

    const ack = await startAck;
    let offset = Number.isFinite(ack?.offset) ? ack.offset : resumeOffset;

    setUploads((prev) => [
      ...prev.filter((u) => u.name !== file.name),
      { name: file.name, pct: file.size ? Math.round((offset / file.size) * 100) : 0, state: 'uploading', file, sentBytes: offset, total: file.size },
    ]);

    while (offset < file.size || file.size === 0) {
      const slice = file.slice(offset, offset + UPLOAD_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const buf = new Uint8Array(await slice.arrayBuffer());
      offset += buf.byteLength;
      const done = offset >= file.size;
      const ok = transport.sendBinary(FRAME_KIND.FILE_UP, { transferId, done }, buf);
      if (!ok) {
        // Transport gone: keep the progress so the user can resume later.
        setUploads((prev) =>
          prev.map((u) => (u.name === file.name ? { ...u, state: 'failed', sentBytes: offset - buf.byteLength } : u)),
        );
        return;
      }
      setUploads((prev) =>
        prev.map((u) =>
          u.name === file.name
            ? { ...u, pct: file.size > 0 ? Math.round((offset / file.size) * 100) : 100, sentBytes: offset }
            : u,
        ),
      );
      if (done) break;
    }
  };

  const handleUploadFiles = async (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length || !currentPath) return;
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      await uploadOne(file, 0);
    }
  };

  const resumeUpload = async (entry) => {
    if (!entry?.file) return;
    // Restart the transfer from the last acknowledged byte (host appends).
    const restartFrom = Math.max(0, entry.sentBytes || 0);
    setUploads((prev) => prev.map((u) => (u.name === entry.name ? { ...u, state: 'uploading' } : u)));
    await uploadOne(entry.file, restartFrom);
  };

  const handleUploadChange = async (e) => {
    const files = e.target.files;
    e.target.value = '';
    await handleUploadFiles(files);
  };

  const onDragEnter = (e) => {
    e.preventDefault();
    draggingCountRef.current += 1;
    if (e.dataTransfer?.types?.includes('Files')) setDragging(true);
  };
  const onDragOver = (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    draggingCountRef.current = Math.max(0, draggingCountRef.current - 1);
    if (draggingCountRef.current === 0) setDragging(false);
  };
  const onDrop = async (e) => {
    e.preventDefault();
    draggingCountRef.current = 0;
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await handleUploadFiles(files);
    }
  };

  const allSelected = items.length > 0 && selected.size === items.length;

  return (
    <div
      className={`file-panel tier-${tier}${dragging ? ' drop-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="panel-toolbar">
        <div className="file-roots">
          {roots.map((r) => (
            <button
              key={r.path}
              type="button"
              className={`chip-btn ${currentPath.startsWith(r.path) ? 'active' : ''}`}
              onClick={() => openDir(r.path)}
            >
              {r.name}
            </button>
          ))}
        </div>
        <div className="panel-controls">
          {parentPath && (
            <button type="button" className="btn-ghost" onClick={() => openDir(parentPath)}>
              上级
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={() => openDir(currentPath)}>
            刷新
          </button>
          <button type="button" className="btn-secondary" onClick={handleMkdir}>
            新建目录
          </button>
          <button type="button" className="btn-secondary" onClick={handleZipDownload}>
            {selected.size > 0 ? `打包下载 (${selected.size})` : '打包当前目录'}
          </button>
          <button type="button" className="btn-primary" onClick={() => fileInputRef.current?.click()}>
            上传文件
          </button>
          <input ref={fileInputRef} type="file" hidden multiple onChange={handleUploadChange} />
        </div>
      </div>

      <div className="path-bar">
        <span>当前路径:</span>
        <code>{currentPath || '加载中...'}</code>
        {items.length > 0 && (
          <button type="button" className="link-btn select-all-btn" onClick={selectAll}>
            {allSelected ? '取消全选' : '全选'}
          </button>
        )}
      </div>

      {uploads.length > 0 && (
        <div className="upload-list">
          {uploads.map((u) => (
            <div key={u.name} className={`upload-row state-${u.state}`}>
              <span className="upload-name">{u.name}</span>
              <span className="upload-pct">
                {u.state === 'failed' ? `中断 ${formatBytes(u.sentBytes || 0)}/${formatBytes(u.total || 0)}` : `${u.pct}%`}
              </span>
              {u.state === 'failed' && (
                <button type="button" className="btn-ghost" onClick={() => resumeUpload(u)}>
                  断点续传
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="empty-box">正在读取目录...</div>
      ) : items.length === 0 ? (
        <div className="empty-box">
          目录为空
          <small className="drop-hint">可以直接把文件拖进这个区域上传</small>
        </div>
      ) : tier === 'phone' ? (
        <div className="file-cards">
          {items.map((item) => (
            <div key={item.path} className={`file-card${selected.has(item.path) ? ' selected' : ''}`}>
              <div className="file-card-main">
                <input
                  type="checkbox"
                  className="file-check"
                  checked={selected.has(item.path)}
                  onChange={() => toggleSelect(item.path)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span
                  className="file-card-click"
                  onClick={() => (item.isDir ? openDir(item.path) : sendFs(MSG.FS_READ_TEXT, { path: item.path }))}
                >
                  <span className="file-icon">{item.isDir ? '📁' : '📄'}</span>
                  <span className="file-card-info">
                    <strong>{item.name}</strong>
                    <small>{item.isDir ? '文件夹' : formatBytes(item.size)}</small>
                  </span>
                </span>
              </div>
              <div className="file-card-actions">
                {!item.isDir && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => sendFs(MSG.FS_DOWNLOAD, { path: item.path, transferId: `dl-${Date.now()}` })}
                  >
                    下载
                  </button>
                )}
                <button type="button" className="btn-ghost" onClick={() => handleRename(item)}>
                  改名
                </button>
                <button type="button" className="btn-danger-ghost" onClick={() => handleDelete(item)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="file-table-wrap">
          <table className="file-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input type="checkbox" checked={allSelected} onChange={selectAll} />
                </th>
                <th>名称</th>
                <th>大小</th>
                <th>修改时间</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.path} className={selected.has(item.path) ? 'selected' : ''}>
                  <td className="col-check">
                    <input
                      type="checkbox"
                      checked={selected.has(item.path)}
                      onChange={() => toggleSelect(item.path)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => (item.isDir ? openDir(item.path) : sendFs(MSG.FS_READ_TEXT, { path: item.path }))}
                    >
                      <span>{item.isDir ? '📁' : '📄'}</span> {item.name}
                    </button>
                  </td>
                  <td>{item.isDir ? '--' : formatBytes(item.size)}</td>
                  <td>{item.mtimeMs ? new Date(item.mtimeMs).toLocaleString() : '--'}</td>
                  <td className="col-actions">
                    {!item.isDir && (
                      <>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => sendFs(MSG.FS_READ_TEXT, { path: item.path })}
                        >
                          查看
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => sendFs(MSG.FS_DOWNLOAD, { path: item.path, transferId: `dl-${Date.now()}` })}
                        >
                          下载
                        </button>
                      </>
                    )}
                    <button type="button" className="btn-ghost" onClick={() => handleRename(item)}>
                      改名
                    </button>
                    <button type="button" className="btn-danger-ghost" onClick={() => handleDelete(item)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>{preview.path}</strong>
              <button type="button" className="btn-ghost" onClick={() => setPreview(null)}>关闭</button>
            </div>
            {preview.truncated && (
              <div className="alert-warn">文件超过 256KB，仅展示前 256KB（保存前请注意）。</div>
            )}
            <textarea
              className="preview-editor"
              value={preview.content}
              onChange={(e) => setPreview((p) => ({ ...p, content: e.target.value }))}
            />
            <div className="modal-foot">
              <button type="button" className="btn-ghost" onClick={() => setPreview(null)}>取消</button>
              {!preview.truncated && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => sendFs(MSG.FS_WRITE_TEXT, { path: preview.path, content: preview.content })}
                >
                  保存修改
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
