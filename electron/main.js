require('dotenv').config();

const {
  app,
  BrowserWindow,
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
const { loadCalibration, runCalibration, validateCalibration } = require('../src/calibration');

let mb = null;
let agent = null;
let computer = null;
let calibration = null;
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
  // Create a small PNG tray icon programmatically.
  // macOS requires actual image data (not SVG) and prefers 16x16 or 22x22 template images.
  // We build a minimal 16x16 RGBA buffer and draw a filled circle.
  const size = 16;
  const r = 6;
  const cx = 8, cy = 8;

  // Parse hex color
  const hex = color.replace('#', '');
  const cr = parseInt(hex.substring(0, 2), 16);
  const cg = parseInt(hex.substring(2, 4), 16);
  const cb = parseInt(hex.substring(4, 6), 16);

  // Create RGBA pixel buffer
  const pixels = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        const offset = (y * size + x) * 4;
        pixels[offset] = cr;
        pixels[offset + 1] = cg;
        pixels[offset + 2] = cb;
        pixels[offset + 3] = 255;
      }
    }
  }

  return nativeImage.createFromBuffer(
    createPNGBuffer(size, size, pixels),
    { width: size, height: size }
  );
}

/**
 * Create a minimal PNG from raw RGBA pixel data.
 * Avoids needing canvas or sharp — just raw zlib + PNG structure.
 */
function createPNGBuffer(width, height, rgbaPixels) {
  const zlib = require('zlib');

  // PNG filter: prepend 0 (None filter) to each row
  const filtered = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (width * 4 + 1)] = 0; // filter byte
    rgbaPixels.copy(filtered, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const deflated = zlib.deflateSync(filtered);

  // Build PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crcData = Buffer.concat([typeB, data]);
    const crc = Buffer.alloc(4);
    crc.writeInt32BE(crc32(crcData));
    return Buffer.concat([len, typeB, data, crc]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', iend),
  ]);
}

/** CRC32 for PNG chunks */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) | 0;
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
    const scaleFactor = primaryDisplay.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
    });
    if (sources.length === 0) return { ok: false, error: 'No screen sources' };
    const thumb = sources[0].thumbnail;
    const imgSize = thumb.getSize();
    console.log(`[screenshot] display: ${width}x${height} logical, scaleFactor=${scaleFactor}, thumbnail: ${imgSize.width}x${imgSize.height}`);
    const jpeg = thumb.toJPEG(50);
    return {
      ok: true,
      data: jpeg.toString('base64'),
      mediaType: 'image/jpeg',
      scaleFactor,
      logicalWidth: width,
      logicalHeight: height,
    };
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
    index: `file:///${path.join(__dirname, 'panel.html').replace(/\\/g, '/')}`,
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

    // Screen calibration — verify physical cursor positioning
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      calibration = loadCalibration();
      calibration = validateCalibration(calibration, primaryDisplay);
      if (!calibration) {
        console.log('[startup] Running physical coordinate verification...');
        calibration = await runCalibration({ screenshotFn: captureScreen });
        console.log(`[startup] Calibration done: ${calibration.screenshot_width}x${calibration.screenshot_height} physical pixels, max error ${calibration.accuracy.max_error_px}px`);
      } else {
        console.log(`[startup] Loaded calibration: ${calibration.screenshot_width}x${calibration.screenshot_height} physical pixels`);
      }
    } catch (err) {
      console.warn('[startup] Calibration failed (continuing without):', err.message);
    }

    // Try to connect to Chrome CDP — connect only (never launch)
    let cdpResult = { connected: false, message: 'Skipped' };
    try {
      cdpResult = await browser.autoConnectOrLaunchChrome();
    } catch (err) {
      console.log('[startup] CDP auto-connect error:', err.message);
      cdpResult = { connected: false, message: err.message };
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
      hideOverlayFn: () => {
        if (mb.window && !mb.window.isDestroyed()) {
          mb.hideWindow();
        }
      },
      showOverlayFn: () => {
        if (mb && mb.window && !mb.window.isDestroyed()) {
          mb.showWindow();
          mb.window.showInactive();
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
