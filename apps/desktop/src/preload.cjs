const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteDeckDesktop', {
  isDesktopApp: true,
  getHostStatus: () => ipcRenderer.invoke('rd:get-host-status'),
  regeneratePin: () => ipcRenderer.invoke('rd:regenerate-pin'),
  setPermissions: (perms) => ipcRenderer.invoke('rd:set-permissions', perms),
  setSecurity: (sec) => ipcRenderer.invoke('rd:set-security', sec),
  setPrivacy: (enabled) => ipcRenderer.invoke('rd:set-privacy', enabled),
  relaunchAdmin: () => ipcRenderer.invoke('rd:relaunch-admin'),
  setQuickTunnel: (enabled) => ipcRenderer.invoke('rd:set-quick-tunnel', enabled),
  setTunnelConfig: (cfg) => ipcRenderer.invoke('rd:set-tunnel-config', cfg),
  getTunnelConfig: () => ipcRenderer.invoke('rd:get-tunnel-config'),
  getAdminAutostart: () => ipcRenderer.invoke('rd:get-admin-autostart'),
  setAdminAutostart: (enabled) => ipcRenderer.invoke('rd:set-admin-autostart', enabled),
  getServiceStatus: () => ipcRenderer.invoke('rd:get-service-status'),
  installService: (mode) => ipcRenderer.invoke('rd:install-service', mode),
  uninstallService: () => ipcRenderer.invoke('rd:uninstall-service'),
  setRelayConfig: (cfg) => ipcRenderer.invoke('rd:set-relay-config', cfg),
  getRelayConfig: () => ipcRenderer.invoke('rd:get-relay-config'),
  setTsnetConfig: (cfg) => ipcRenderer.invoke('rd:set-tsnet-config', cfg),
  logoutTsnet: () => ipcRenderer.invoke('rd:logout-tsnet'),
  getAutoLaunch: () => ipcRenderer.invoke('rd:get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('rd:set-auto-launch', enabled),
  onHostStatus: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_ev, payload) => cb(payload);
    ipcRenderer.on('rd:host-status', listener);
    return () => ipcRenderer.removeListener('rd:host-status', listener);
  },
});
