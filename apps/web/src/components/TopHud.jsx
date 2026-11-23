import React, { useState } from 'react';

const CHANNEL_LABEL = {
  lan: { text: '内网直连', cls: 'badge-lan' },
  tailscale: { text: 'P2P 组网', cls: 'badge-lan' },
  tunnel: { text: '外网隧道', cls: 'badge-relay' },
  webrtc: { text: 'P2P 直连', cls: 'badge-p2p' },
  relay: { text: '云端中继', cls: 'badge-relay' },
};

const SYSTEM_SHORTCUTS = [
  { label: 'Ctrl + Shift + Esc (任务管理器)', vk: 0x1b, mods: { ctrl: true, shift: true } },
  { label: 'Ctrl + Alt + Del (安全选项)', vk: 0x2e, mods: { ctrl: true, alt: true } },
  { label: 'Win + D (显示桌面)', vk: 68, mods: { meta: true } },
  { label: 'Alt + Tab (切换窗口)', vk: 0x09, mods: { alt: true } },
  { label: 'Win + R (运行命令)', vk: 82, mods: { meta: true } },
  { label: 'Win + L (锁定电脑)', vk: 76, mods: { meta: true } },
  { label: 'Win (开始菜单)', vk: 0x5b, mods: {} },
];

export function TopHud({
  tier,
  sessionInfo,
  telemetry,
  activeTab,
  onChangeTab,
  displays,
  activeDisplayId,
  onChangeDisplay,
  qualityPreset,
  onChangeQuality,
  audioEnabled,
  onToggleAudio,
  privacyEnabled,
  onTogglePrivacy,
  onToggleImmersive,
  layoutOverride,
  onChangeLayoutOverride,
  onSyncClipboard,
  clipSync,
  onToggleClipSync,
  codecMode,
  h264Ready,
  onChangeCodec,
  onSendHotkey,
  pointerLocked = false,
  onTogglePointerLock,
  onToggleFullscreen,
  onDisconnect,
  permissions,
}) {
  const [hotkeyOpen, setHotkeyOpen] = useState(false);

  const ch = CHANNEL_LABEL[telemetry.channel || sessionInfo?.channel] || {
    text: '已连接',
    cls: 'badge-lan',
  };

  return (
    <header className={`top-hud tier-${tier}`}>
      <div className="hud-left">
        <div className="hud-device">
          <span className="dot online" />
          <strong className="hud-name">{sessionInfo?.deviceName || sessionInfo?.deviceId}</strong>
          <span className={`link-badge ${ch.cls}`}>{ch.text}</span>
        </div>
        <div className="hud-metrics">
          <span>{telemetry.rttMs != null ? `${telemetry.rttMs} ms` : '-- ms'}</span>
          <span>{telemetry.fps} FPS</span>
          {tier !== 'phone' && <span>{telemetry.kbps} kbps</span>}
        </div>
      </div>

      <nav className="hud-tabs" aria-label="工作区切换">
        <button
          type="button"
          className={`hud-tab ${activeTab === 'screen' ? 'active' : ''}`}
          onClick={() => onChangeTab('screen')}
        >
          画面
        </button>
        {permissions?.terminal !== false && (
          <button
            type="button"
            className={`hud-tab ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={() => onChangeTab('terminal')}
          >
            终端
          </button>
        )}
        {permissions?.files !== false && (
          <button
            type="button"
            className={`hud-tab ${activeTab === 'files' ? 'active' : ''}`}
            onClick={() => onChangeTab('files')}
          >
            文件
          </button>
        )}
        {tier === 'desktop' && (
          <button
            type="button"
            className={`hud-tab ${activeTab === 'split' ? 'active' : ''}`}
            onClick={() => onChangeTab('split')}
          >
            分屏工作台
          </button>
        )}
        <button
          type="button"
          className={`hud-tab ${activeTab === 'phones' ? 'active' : ''}`}
          onClick={() => onChangeTab('phones')}
        >
          手机镜像
        </button>
      </nav>

      <div className="hud-actions">
        {displays.length > 1 && (
          <select
            className="compact-select"
            value={activeDisplayId}
            onChange={(e) => onChangeDisplay(Number(e.target.value))}
            aria-label="切换显示器"
          >
            {displays.map((d) => (
              <option key={d.id} value={d.id}>
                屏 {d.id + 1} ({d.width}×{d.height})
              </option>
            ))}
          </select>
        )}

        <select
          className="compact-select"
          value={qualityPreset}
          onChange={(e) => onChangeQuality(e.target.value)}
          aria-label="画质档位"
        >
          <option value="auto">智能自适应</option>
          <option value="eco">省流 (4G)</option>
          <option value="balanced">均衡</option>
          <option value="hd">高清</option>
          <option value="uhd">超清（原画）</option>
        </select>

        {h264Ready && (
          <select
            className="compact-select"
            value={codecMode}
            onChange={(e) => onChangeCodec(e.target.value)}
            title="H.264 编码可大幅降低带宽；不可用时自动回退 JPEG"
            aria-label="编码格式"
          >
            <option value="jpeg">JPEG</option>
            <option value="h264">H.264</option>
          </select>
        )}

        {permissions?.control !== false && (activeTab === 'screen' || activeTab === 'split') && onSendHotkey && (
          <div className="hud-hotkey-wrap">
            <button
              type="button"
              className={`btn-ghost ${hotkeyOpen ? 'btn-active-pill' : ''}`}
              onClick={() => setHotkeyOpen((v) => !v)}
              title="向远端发送组合快捷键"
            >
              快捷键 ▾
            </button>
            {hotkeyOpen && (
              <div className="hud-hotkey-menu">
                {SYSTEM_SHORTCUTS.map((sc) => (
                  <button
                    key={sc.label}
                    type="button"
                    className="hud-hotkey-item"
                    onClick={() => {
                      onSendHotkey(sc.vk, sc.mods);
                      setHotkeyOpen(false);
                    }}
                  >
                    {sc.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {permissions?.audio !== false && (
          <button
            type="button"
            className={`btn-ghost ${audioEnabled ? 'btn-active-pill' : ''}`}
            onClick={onToggleAudio}
            title="开启/关闭远端系统声音"
          >
            {audioEnabled ? '声音开' : '声音'}
          </button>
        )}

        {permissions?.control !== false && (
          <button
            type="button"
            className={`btn-ghost ${privacyEnabled ? 'btn-active-pill' : ''}`}
            onClick={onTogglePrivacy}
            title="被控端防窥黑屏"
          >
            {privacyEnabled ? '防窥中' : '防窥'}
          </button>
        )}

        {tier !== 'phone' && (
          <select
            className="compact-select"
            value={layoutOverride}
            onChange={(e) => onChangeLayoutOverride(e.target.value)}
            aria-label="布局模式"
          >
            <option value="auto">自适应</option>
            <option value="desktop">桌面布局</option>
            <option value="tablet">平板布局</option>
            <option value="phone">手机布局</option>
          </select>
        )}

        <button type="button" className="btn-ghost" onClick={onSyncClipboard} title="同步剪贴板">
          {tier === 'phone' ? '剪贴' : '剪贴板'}
        </button>

        {permissions?.control !== false && (
          <button
            type="button"
            className={`btn-ghost ${clipSync ? 'btn-active-pill' : ''}`}
            onClick={onToggleClipSync}
            title="开启后，被控端复制的内容会自动同步到本机"
          >
            {clipSync ? '剪贴同步中' : '剪贴同步'}
          </button>
        )}

        {permissions?.control !== false && tier === 'desktop' && (activeTab === 'screen' || activeTab === 'split') && onTogglePointerLock && (
          <button
            type="button"
            className={`btn-ghost ${pointerLocked ? 'btn-active-pill' : ''}`}
            onClick={onTogglePointerLock}
            title="锁定鼠标为相对位移模式（适合 3D 游戏与视角旋转，按 Esc 退出）"
          >
            {pointerLocked ? '已锁鼠标' : '锁鼠标'}
          </button>
        )}

        {activeTab === 'screen' && (
          <button type="button" className="btn-ghost" onClick={onToggleImmersive} title="收起工具栏进入悬浮球沉浸模式">
            沉浸
          </button>
        )}

        <button type="button" className="btn-ghost" onClick={onToggleFullscreen} title="全屏/横屏">
          {tier === 'phone' ? '横屏' : '全屏'}
        </button>

        <button type="button" className="btn-danger-ghost" onClick={onDisconnect}>
          断开
        </button>
      </div>
    </header>
  );
}
