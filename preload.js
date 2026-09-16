// Minimal preload - exposes only safe, read-only app info and the update
// bridge to the renderer. The POS UI talks to the backend over HTTP; no
// Node APIs are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('martpos', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  desktop: {
    // electron-builder portable builds always set PORTABLE_EXECUTABLE_DIR.
    isPortable: !!process.env.PORTABLE_EXECUTABLE_DIR
  },
  updates: {
    getStatus: () => ipcRenderer.invoke('martpos:update:status'),
    check: () => ipcRenderer.invoke('martpos:update:check'),
    download: () => ipcRenderer.invoke('martpos:update:download'),
    install: () => ipcRenderer.invoke('martpos:update:install'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('martpos:update:event', listener);
      return () => ipcRenderer.removeListener('martpos:update:event', listener);
    }
  }
});
