require('dotenv').config();

const {
  app,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  desktopCapturer,
} = require('electron');
const path = require('path');
const { menubar } = require('menubar');
const Agent = require('../src/agent');
const Computer = require('../src/computer');
const browser = require('../src/browser');

let mb = null;
let agent = null;
let computer = null;
let isQuitting = false;

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mb && mb.window) {
      mb.showWindow();
    }
  });
}

function createTrayIcon(color) {
  const size = 16;
  const canvas = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="8" cy="8" r="6" fill="${color}"/>
  </svg>`;
  return nativeImage.createFromBuffer(
    Buffer.from(canvas),
    { width: size, height: size }
  );
}

function setTrayState(state) {
  const colors = { idle: '#666666', active: '#7c5cbf', speaking: '#22c55e' };
  if (mb && mb.tray) {
    mb.tray.setImage(createTrayIcon(colors[state] || colors.idle));
  }
}

function sendToRenderer(channel, data) {
  if (mb && mb.window && !mb.window.isDestroyed()) {
    mb.window.webContents.send(channel, data);
  }
}

// --- Screenshot (Tier 3 fallback) ---

async function captureScreen() {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    if (sources.length === 0) return { ok: false, error: 'No screen sources' };
    const jpeg = sources[0].thumbnail.toJPEG(50);
    return { ok: true, data: jpeg.toString('base64'), mediaType: 'image/jpeg' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- IPC Handlers ---

ipcMain.handle('send-message', async (_event, { text }) => {
  try {
    const reply = await agent.chat(text);
    return { ok: true, reply };
  } catch (err) {
    console.error('Agent error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.on('hide-overlay', () => {
  if (mb) mb.hideWindow();
});

ipcMain.on('clear-history', () => {
  if (agent) agent.clearHistory();
});

ipcMain.on('show-panel', () => {
  // showInactive — NEVER steal focus from the target app
  if (mb && mb.window && !mb.window.isDestroyed()) {
    mb.window.showInactive();
  }
});

ipcMain.on('set-tray-state', (_event, state) => {
  setTrayState(state);
});

// Blur overlay — release focus so keystrokes land in target app
ipcMain.on('blur-overlay', () => {
  if (mb && mb.window && !mb.window.isDestroyed()) {
    mb.window.blur();
  }
});

// Confirmation flow
ipcMain.handle('confirm-action', async (_event, { actionId }) => {
  if (agent && agent._pendingConfirmation && agent._pendingConfirmation.id === actionId) {
    agent._pendingConfirmation.resolve({ confirmed: true });
    return { ok: true };
  }
  return { ok: false, error: 'No pending confirmation' };
});

ipcMain.handle('cancel-action', async (_event, { actionId }) => {
  if (agent && agent._pendingConfirmation && agent._pendingConfirmation.id === actionId) {
    agent._pendingConfirmation.resolve({ confirmed: false, reason: 'User cancelled' });
    return { ok: true };
  }
  return { ok: false, error: 'No pending confirmation' };
});

ipcMain.handle('capture-screenshot', async () => {
  return await captureScreen();
});

// Whisper API fallback for voice transcription
ipcMain.handle('transcribe-audio', async (_event, { audioBase64 }) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'OPENAI_API_KEY not set — Whisper fallback unavailable' };
  }

  try {
    const buffer = Buffer.from(audioBase64, 'base64');
    const { Blob } = require('node:buffer');
    const blob = new Blob([buffer], { type: 'audio/webm' });

    const formData = new FormData();
    formData.append('file', blob, 'audio.webm');
    formData.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      return { ok: false, error: `Whisper API error: ${response.status}` };
    }

    const data = await response.json();
    return { ok: true, text: data.text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- App lifecycle ---

app.whenReady().then(async () => {
  mb = menubar({
    index: `file://${path.join(__dirname, 'panel.html')}`,
    icon: createTrayIcon('#666666'),
    tooltip: 'AI Assistant',
    preloadWindow: true,
    showDockIcon: false,
    browserWindow: {
      width: 380,
      height: 560,
      resizable: false,
      frame: false,
      transparent: true,
      alwaysOnTop: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });

  mb.on('ready', async () => {
    console.log('[startup] Tray app ready');

    // Init native computer control
    computer = new Computer();
    console.log('[startup] Computer control ready');

    // Try CDP connect to Chrome — auto-launch if not running with debug port
    let cdpResult = { connected: false, message: 'Skipped' };
    try {
      cdpResult = await browser.autoConnectOrLaunchChrome();
    } catch (err) {
      console.log('[startup] CDP auto-connect error:', err.message);
    }
    console.log(`[startup] Chrome CDP: ${cdpResult.message}`);

    // Init agent
    agent = new Agent({
      browser,
      computer,
      screenshotFn: captureScreen,
      blurOverlayFn: () => {
        if (mb.window && !mb.window.isDestroyed()) {
          mb.window.blur();
        }
      },
      onProgress: (info) => sendToRenderer('agent-progress', info),
      onConfirmationRequest: (preview) => {
        return new Promise((resolve) => {
          const id = preview.id || `confirm_${Date.now()}`;
          agent._pendingConfirmation = { id, resolve };
          sendToRenderer('confirmation-request', { ...preview, id });
        });
      },
    });

    console.log('[startup] Agent ready — hey, ready when you are');

    // Register hotkey: Ctrl+Shift+Space activates voice
    globalShortcut.register('Ctrl+Shift+Space', () => {
      sendToRenderer('start-listening');
      // Panel auto-opens when response arrives
    });
  });

  // Emit focus-lost when panel loses focus
  mb.on('hide', () => {
    sendToRenderer('focus-lost');
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
