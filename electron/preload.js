const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiAssistant', {
  sendMessage: (text) =>
    ipcRenderer.invoke('send-message', { text }),

  confirmAction: (actionId) =>
    ipcRenderer.invoke('confirm-action', { actionId }),

  cancelAction: (actionId) =>
    ipcRenderer.invoke('cancel-action', { actionId }),

  hideOverlay: () =>
    ipcRenderer.send('hide-overlay'),

  clearHistory: () =>
    ipcRenderer.send('clear-history'),

  blurOverlay: () =>
    ipcRenderer.send('blur-overlay'),

  showPanel: () =>
    ipcRenderer.send('show-panel'),

  setTrayState: (state) =>
    ipcRenderer.send('set-tray-state', state),

  captureScreenshot: () =>
    ipcRenderer.invoke('capture-screenshot'),

  transcribeAudio: (audioBase64) =>
    ipcRenderer.invoke('transcribe-audio', { audioBase64 }),

  onAgentProgress: (callback) => {
    ipcRenderer.on('agent-progress', (_event, data) => callback(data));
  },

  onConfirmationRequest: (callback) => {
    ipcRenderer.on('confirmation-request', (_event, data) => callback(data));
  },

  onDomContextUpdate: (callback) => {
    ipcRenderer.on('dom-context-update', (_event, data) => callback(data));
  },

  onStartListening: (callback) => {
    ipcRenderer.on('start-listening', () => callback());
  },

  onFocusLost: (callback) => {
    ipcRenderer.on('focus-lost', () => callback());
  },
});
