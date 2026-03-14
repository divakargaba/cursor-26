const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calibrationAPI', {
  sendCorners: (corners) => ipcRenderer.send('calibration-corners', corners),
});
