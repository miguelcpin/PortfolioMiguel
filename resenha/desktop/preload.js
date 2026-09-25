// Ponte mínima entre a página e o app desktop (sem acesso ao Node na página).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
  getServer: () => ipcRenderer.invoke('get-server'),
  setServer: (url) => ipcRenderer.invoke('set-server', url),
  changeServer: () => ipcRenderer.invoke('change-server'),
  focus: () => ipcRenderer.send('focus'),
  setBadge: (count) => ipcRenderer.send('badge', count),
  // Hospedar o servidor neste PC
  hostInfo: () => ipcRenderer.invoke('host-info'),
  hostStart: (opts) => ipcRenderer.invoke('host-start', opts),
  hostStop: () => ipcRenderer.invoke('host-stop'),
  hostAutostart: (on) => ipcRenderer.invoke('host-autostart', on),
});
