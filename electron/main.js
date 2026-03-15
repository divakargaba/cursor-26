require('dotenv').config();

// ---------------------------------------------------------------------------
// Guard against EPIPE errors on stdout/stderr.
// When the Electron app outlives the terminal that spawned it, the stdio
// pipe closes and every console.log throws an uncaught EPIPE exception.
// ---------------------------------------------------------------------------
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', (err) => {
      if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) return; // swallow
      throw err; // re-throw non-EPIPE errors
    });
  }
}

process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) return; // swallow
  console.error('[main] Uncaught exception:', err);
  process.exit(1);
});

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
const PassiveMonitor = require('../src/passive/monitor');
const USE_MCP = process.env.USE_MCP_BROWSER === '1';
const browser = USE_MCP ? require('../src/mcp-browser') : require('../src/browser');

// Target long edge for downscaled screenshots (Anthropic recommends 1024x768 max)
const TARGET_LONG_EDGE = 1024;

const ORB_WINDOW_SIZE = 200;
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 480;

let mb = null;
let agent = null;
let computer = null;
let passiveMonitor = null;
let displayConfig = null;
let isQuitting = false;
let agentHidOverlay = false; // true when agent hid overlay for tool execution (don't reset panel)

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

// ---------------------------------------------------------------------------
// Display config — compute once at startup
// ---------------------------------------------------------------------------

function computeDisplayConfig() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor || 1;

  const physicalWidth = Math.round(width * scaleFactor);
  const physicalHeight = Math.round(height * scaleFactor);

  // Downscale: fit within TARGET_LONG_EDGE maintaining aspect ratio
  const longEdge = Math.max(physicalWidth, physicalHeight);
  const downscale = TARGET_LONG_EDGE / longEdge;
  const displayWidth = Math.round(physicalWidth * downscale);
  const displayHeight = Math.round(physicalHeight * downscale);

  // Scale factors: API coords → physical coords
  const scaleX = physicalWidth / displayWidth;
  const scaleY = physicalHeight / displayHeight;

  return { physicalWidth, physicalHeight, displayWidth, displayHeight, scaleX, scaleY };
}

// ---------------------------------------------------------------------------
// Screenshot — capture and downscale for computer-use API
// ---------------------------------------------------------------------------

async function captureScreen() {
  try {
    if (!displayConfig) {
      displayConfig = computeDisplayConfig();
    }

    // Capture at full physical resolution
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: displayConfig.physicalWidth, height: displayConfig.physicalHeight },
    });
    if (sources.length === 0) return { ok: false, error: 'No screen sources' };

    // Downscale to target display dimensions
    const resized = sources[0].thumbnail.resize({
      width: displayConfig.displayWidth,
      height: displayConfig.displayHeight,
    });
    const jpeg = resized.toJPEG(50);

    return {
      ok: true,
      data: jpeg.toString('base64'),
      mediaType: 'image/jpeg',
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
    // Re-expand to panel size if it was collapsed to orb by a hide
    const bounds = mb.window.getBounds();
    if (bounds.width === ORB_WINDOW_SIZE && bounds.height === ORB_WINDOW_SIZE) {
      const cx = bounds.x + Math.round(bounds.width / 2);
      const newX = Math.round(cx - PANEL_WIDTH / 2);
      mb.window.setBounds({ x: newX, y: bounds.y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
    }
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

// Two-stage panel: expand from orb to full panel
ipcMain.on('expand-panel', () => {
  if (!mb || !mb.window || mb.window.isDestroyed()) return;
  const bounds = mb.window.getBounds();
  const cx = bounds.x + Math.round(bounds.width / 2);
  const newX = Math.round(cx - PANEL_WIDTH / 2);
  mb.window.setBounds({ x: newX, y: bounds.y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
});

ipcMain.on('collapse-panel', () => {
  if (!mb || !mb.window || mb.window.isDestroyed()) return;
  const bounds = mb.window.getBounds();
  const cx = bounds.x + Math.round(bounds.width / 2);
  const newX = Math.round(cx - ORB_WINDOW_SIZE / 2);
  mb.window.setBounds({ x: newX, y: bounds.y, width: ORB_WINDOW_SIZE, height: ORB_WINDOW_SIZE });
});

// Passive mode IPC handlers
ipcMain.on('nudge-dismissed', (_event, category) => {
  if (passiveMonitor) passiveMonitor.delivery.onDismissed(category);
});

ipcMain.on('tts-state', (_event, speaking) => {
  if (passiveMonitor) passiveMonitor.delivery.setTTSSpeaking(speaking);
});

ipcMain.on('abort-agent', () => {
  if (agent) agent.abort();
});

ipcMain.on('toggle-passive-mode', () => {
  if (!passiveMonitor) return;
  if (passiveMonitor.isActive()) {
    passiveMonitor.pause();
    sendToRenderer('agent-progress', { type: 'text', text: 'Passive mode paused.' });
  } else {
    passiveMonitor.resume();
    sendToRenderer('agent-progress', { type: 'text', text: 'Passive mode resumed.' });
  }
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
      width: ORB_WINDOW_SIZE,
      height: ORB_WINDOW_SIZE,
      resizable: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false, // Keep mic/audio alive when window is inactive
      },
    },
  });

  mb.on('ready', async () => {
    console.log('[startup] Tray app ready');

    // Forward renderer console logs to main process stdout
    mb.window.webContents.on('console-message', (_e, _level, message) => {
      console.log(`[renderer] ${message}`);
    });

    // Init native computer control
    computer = new Computer();
    console.log('[startup] Computer control ready');

    // Compute display config for computer-use coordinate scaling
    displayConfig = computeDisplayConfig();
    console.log(`[startup] Display: ${displayConfig.displayWidth}x${displayConfig.displayHeight} (physical ${displayConfig.physicalWidth}x${displayConfig.physicalHeight}, scale ${displayConfig.scaleX.toFixed(2)}x)`);

    // Connect to Chrome (Playwright CDP or MCP depending on USE_MCP_BROWSER)
    let cdpResult = { connected: false, message: 'Skipped' };
    try {
      if (USE_MCP) {
        cdpResult = await browser.autoConnectOrLaunchChrome({ noUsageStatistics: true });
        console.log(`[startup] Chrome MCP: ${cdpResult.message}`);
      } else {
        cdpResult = await browser.autoConnectOrLaunchChrome();
        console.log(`[startup] Chrome CDP: ${cdpResult.message}`);
      }
    } catch (err) {
      console.log('[startup] Browser connect error:', err.message);
      cdpResult = { connected: false, message: err.message };
    }

    // Init agent with computer-use display config
    agent = new Agent({
      browser,
      computer,
      screenshotFn: captureScreen,
      displayConfig,
      blurOverlayFn: () => {
        if (mb.window && !mb.window.isDestroyed()) {
          // Just blur — don't hide. The orb must NEVER vanish.
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

    console.log('[startup] Agent ready (computer-use API) — hey, ready when you are');

    // Init passive monitor (Mode 2)
    passiveMonitor = new PassiveMonitor({
      browser,
      computer,
      agent,
      memory: agent.memory,
      sendToRenderer,
    });
    passiveMonitor.start();
    console.log('[startup] Passive monitor started (30s scan loop)');

    // Register hotkey: Ctrl+Shift+Space activates voice
    globalShortcut.register('Ctrl+Shift+Space', () => {
      sendToRenderer('start-listening');
    });

    // Auto-show orb — give it brief focus so mic/AudioContext activates
    mb.showWindow();
    mb.window.focus();
    // Release focus after mic initializes
    setTimeout(() => {
      if (mb.window && !mb.window.isDestroyed()) mb.window.blur();
    }, 2000);
    console.log('[startup] Orb visible');

    // Keepalive: force-resume AudioContext from main process every 3s
    setInterval(() => {
      if (mb.window && !mb.window.isDestroyed()) {
        mb.window.webContents.executeJavaScript(
          'if(window._alwaysOnAudioCtx&&window._alwaysOnAudioCtx.state==="suspended")window._alwaysOnAudioCtx.resume()'
        ).catch(() => {});
      }
    }, 3000);
  });

  // On hide: collapse to orb but keep visible — orb must NEVER vanish
  mb.on('hide', () => {
    if (agentHidOverlay) {
      // Agent hid the overlay to execute a tool — don't reset panel
      agentHidOverlay = false;
      return;
    }
    sendToRenderer('focus-lost');
    sendToRenderer('panel-reset');
    // Collapse to orb size and re-show as inactive (no focus steal)
    if (mb.window && !mb.window.isDestroyed()) {
      const bounds = mb.window.getBounds();
      if (bounds.width !== ORB_WINDOW_SIZE || bounds.height !== ORB_WINDOW_SIZE) {
        const cx = bounds.x + Math.round(bounds.width / 2);
        const newX = Math.round(cx - ORB_WINDOW_SIZE / 2);
        mb.window.setBounds({ x: newX, y: bounds.y, width: ORB_WINDOW_SIZE, height: ORB_WINDOW_SIZE });
      }
      // Keep orb visible — never fully hide
      mb.window.showInactive();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (passiveMonitor) passiveMonitor.stop();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
