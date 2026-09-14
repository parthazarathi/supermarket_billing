// Minimal preload - exposes only safe, read-only app info to the renderer.
// The POS UI talks to the backend over HTTP; no Node APIs are exposed.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('martpos', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }
});
