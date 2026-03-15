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

  expandPanel: () =>
    ipcRenderer.send('expand-panel'),

  collapsePanel: () =>
    ipcRenderer.send('collapse-panel'),

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

  onPanelReset: (callback) => {
    ipcRenderer.on('panel-reset', () => callback());
  },

  // Passive mode (Mode 2)
  dismissNudge: (category) =>
    ipcRenderer.send('nudge-dismissed', category),

  reportTTSState: (speaking) =>
    ipcRenderer.send('tts-state', speaking),

  togglePassiveMode: () =>
    ipcRenderer.send('toggle-passive-mode'),

  onPassiveNudge: (callback) => {
    ipcRenderer.on('passive-nudge', (_event, data) => callback(data));
  },
});
