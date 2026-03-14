// browser.js — CDP browser control via Playwright (cross-platform)
// Connects to Chrome AND Electron apps (Discord, Spotify, Slack, etc.)
// via --remote-debugging-port for full DOM access.
//
// Platform-aware: detects Windows vs macOS for Chrome launch/detection,
// window title detection, and Electron app paths.

const { chromium } = require('playwright');
const { exec, execSync } = require('child_process');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ---------------------------------------------------------------------------
// Window title detection — platform-specific
// On Windows: koffi + user32.dll (fast, synchronous)
// On macOS: AppleScript (slightly slower, but reliable)
// ---------------------------------------------------------------------------

let _GetForegroundWindow, _GetWindowTextA;
if (IS_WIN) {
  try {
    const koffi = require('koffi');
    const u32 = koffi.load('user32.dll');
    _GetForegroundWindow = u32.func('void * __stdcall GetForegroundWindow()');
    _GetWindowTextA = u32.func('int __stdcall GetWindowTextA(void *hWnd, uint8_t *buf, int maxCount)');
  } catch {
    // koffi not available — detectCurrentApp will be limited
  }
}

/**
 * Get the title of the currently focused window (cross-platform).
 * Returns string or '' on failure.
 */
function _getForegroundTitle() {
  if (IS_WIN && _GetForegroundWindow) {
    try {
      const hwnd = _GetForegroundWindow();
      const buf = Buffer.alloc(256);
      const len = _GetWindowTextA(hwnd, buf, 256);
      return buf.toString('utf8', 0, len);
    } catch {
      return '';
    }
  }
  if (IS_MAC) {
    try {
      return execSync(`osascript -e 'tell application "System Events" to set frontApp to first application process whose frontmost is true
try
  set winTitle to name of front window of frontApp
on error
  set winTitle to name of frontApp
end try
return winTitle'`, { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return '';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// App registry — Electron apps and their CDP debug ports
// ---------------------------------------------------------------------------

const APP_DEBUG_PORTS = {
  chrome: 9222, discord: 9224, spotify: 9227, slack: 9225,
  vscode: 9223, figma: 9226, notion: 9228, whatsapp: 9229,
  obsidian: 9230, teams: 9231,
};

// Platform-specific launch commands for Electron apps
const APP_LAUNCH_COMMANDS = IS_MAC ? {
  // macOS — Electron app CDP launch is not yet implemented.
  // Chrome is handled separately in autoConnectOrLaunchChrome().
  vscode: 'code --remote-debugging-port=9223',
} : {
  // Windows
  discord: '%LOCALAPPDATA%\\Discord\\Update.exe --processStart Discord.exe --process-start-args="--remote-debugging-port=9224"',
  spotify: '%APPDATA%\\Spotify\\Spotify.exe --remote-debugging-port=9227',
  slack: '%LOCALAPPDATA%\\slack\\slack.exe --remote-debugging-port=9225',
  chrome: 'start chrome --remote-debugging-port=9222',
  vscode: 'code --remote-debugging-port=9223',
  obsidian: '%LOCALAPPDATA%\\Obsidian\\Obsidian.exe --remote-debugging-port=9230',
  teams: '%LOCALAPPDATA%\\Microsoft\\Teams\\current\\Teams.exe --remote-debugging-port=9231',
};

// Title fragments → app name mapping (cross-platform)
const TITLE_TO_APP = [
  { pattern: /discord/i, app: 'discord' },
  { pattern: /spotify/i, app: 'spotify' },
  { pattern: /slack/i, app: 'slack' },
  { pattern: /visual studio code|vs ?code/i, app: 'vscode' },
  { pattern: /figma/i, app: 'figma' },
  { pattern: /notion/i, app: 'notion' },
  { pattern: /whatsapp/i, app: 'whatsapp' },
  { pattern: /obsidian/i, app: 'obsidian' },
  { pattern: /teams/i, app: 'teams' },
  { pattern: /google chrome|chrome/i, app: 'chrome' },
];

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let browser = null;   // Chrome CDP connection
let page = null;      // Current Chrome page
const connections = {}; // { appName: { browser, page, port, appName } }

// ---------------------------------------------------------------------------
// Chrome CDP (cross-platform)
// ---------------------------------------------------------------------------

/**
 * Check if a CDP endpoint is actually responding before connecting Playwright.
 * Uses a simple HTTP GET to /json/version — faster than letting Playwright timeout.
 */
async function _isCDPAlive(port = 9222) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function connectToChrome() {
  try {
    // Quick HTTP check first — avoids slow Playwright timeout if CDP isn't there
    const alive = await _isCDPAlive(9222);
    if (!alive) {
      browser = null;
      page = null;
      return false;
    }

    browser = await chromium.connectOverCDP('http://localhost:9222');
    await getCurrentPage();
    console.log('[browser] Connected to Chrome via CDP');
    return true;
  } catch (err) {
    browser = null;
    page = null;
    console.log('[browser] CDP connect failed:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Platform-specific Chrome detection and launch helpers
// ---------------------------------------------------------------------------

/**
 * Check if Chrome is currently running.
 * Returns Promise<boolean>.
 */
function _isChromeRunning() {
  return new Promise((resolve) => {
    if (IS_WIN) {
      exec('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { windowsHide: true }, (err, stdout) => {
        resolve(stdout && stdout.toLowerCase().includes('chrome.exe'));
      });
    } else if (IS_MAC) {
      exec('pgrep -x "Google Chrome"', (err, stdout) => {
        resolve(!err && stdout.trim().length > 0);
      });
    } else {
      exec('pgrep -x chrome || pgrep -x chromium', (err, stdout) => {
        resolve(!err && stdout.trim().length > 0);
      });
    }
  });
}

/**
 * Get the Chrome user data directory for the current platform.
 * Returns path string or null.
 */
function _getChromeUserDataDir() {
  if (IS_WIN) {
    return process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
      : null;
  }
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  // Linux
  return path.join(os.homedir(), '.config', 'google-chrome');
}

/**
 * Get a temp directory path for a debug Chrome profile.
 */
function _getDebugProfileDir() {
  if (IS_WIN) {
    const base = process.env.TEMP || path.join(process.env.LOCALAPPDATA || '', 'Temp');
    return path.join(base, 'chrome-cdp-debug');
  }
  return path.join(os.tmpdir(), 'chrome-cdp-debug');
}

/**
 * Launch Chrome with remote debugging port.
 * @param {string|null} userDataDir - optional user data dir
 * @param {object} opts - { noFirstRun: bool }
 */
function _launchChrome(userDataDir, opts = {}) {
  if (IS_WIN) {
    const udArg = userDataDir ? ` --user-data-dir="${userDataDir}"` : '';
    const nfr = opts.noFirstRun ? ' --no-first-run' : '';
    exec(`start "" "chrome" --remote-debugging-port=9222${udArg}${nfr}`, { shell: true, windowsHide: true });
  } else if (IS_MAC) {
    // On macOS, use 'open' to launch Chrome with args
    const args = ['--remote-debugging-port=9222'];
    if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
    if (opts.noFirstRun) args.push('--no-first-run');
    const argsStr = args.join(' ');
    exec(`open -na "Google Chrome" --args ${argsStr}`);
  } else {
    // Linux fallback
    const udArg = userDataDir ? ` --user-data-dir="${userDataDir}"` : '';
    const nfr = opts.noFirstRun ? ' --no-first-run' : '';
    exec(`google-chrome --remote-debugging-port=9222${udArg}${nfr} &`, { shell: true });
  }
}

/**
 * Auto-connect to Chrome or launch it with CDP debug port.
 * Flow:
 * 1. Try existing CDP connection on port 9222
 * 2. If fails, detect if Chrome is running without debug port
 * 3. If Chrome isn't running, launch with --remote-debugging-port=9222
 * 4. If Chrome IS running (no CDP), launch a new instance with debug port + temp profile
 * Returns { connected: bool, message: string }
 */
async function autoConnectOrLaunchChrome() {
  // First try existing CDP
  const connected = await connectToChrome();
  if (connected) {
    return { connected: true, message: 'Connected to existing Chrome CDP' };
  }

  const userDataDir = _getChromeUserDataDir();

  // Check if any Chrome is running
  const isRunning = await _isChromeRunning();

  if (!isRunning) {
    // Chrome not running — launch with debug port and user's existing profile
    console.log('[browser] Chrome not running — launching with CDP debug port...');
    _launchChrome(userDataDir);

    // Wait for Chrome to start — use HTTP check for faster detection
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 800));
      const alive = await _isCDPAlive(9222);
      if (alive) {
        const ok = await connectToChrome();
        if (ok) return { connected: true, message: 'Launched Chrome with CDP debug port' };
      }
    }
    return { connected: false, message: 'Launched Chrome but could not connect to CDP' };
  }

  // Chrome IS running but without debug port
  // Launch a secondary instance with a separate debugging profile
  console.log('[browser] Chrome running without CDP. Launching debug instance...');
  const debugProfile = _getDebugProfileDir();
  _launchChrome(debugProfile, { noFirstRun: true });

  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 800));
    const alive = await _isCDPAlive(9222);
    if (alive) {
      const ok = await connectToChrome();
      if (ok) return { connected: true, message: 'Connected to Chrome debug instance' };
    }
  }

  const hint = IS_MAC
    ? 'Close all Chrome windows and try again, or launch Chrome from terminal: open -na "Google Chrome" --args --remote-debugging-port=9222'
    : 'Close all Chrome windows and try again, or restart Chrome with: chrome --remote-debugging-port=9222';

  return {
    connected: false,
    message: `Chrome is running but without --remote-debugging-port=9222. ${hint}`,
  };
}

function isConnected() {
  return browser !== null && browser.isConnected() && page !== null;
}

async function getCurrentPage() {
  try {
    if (!browser || !browser.isConnected()) {
      page = null;
      return null;
    }
    const contexts = browser.contexts();
    if (!contexts.length) { page = null; return null; }
    const pages = contexts[0].pages();
    if (!pages.length) { page = null; return null; }
    page = pages[pages.length - 1];
    return page;
  } catch (err) {
    console.error('[browser] getCurrentPage error:', err.message);
    page = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Page context extraction (shared between Chrome and Electron apps)
// ---------------------------------------------------------------------------

function _extractElements(pageRef) {
  return pageRef.evaluate(() => {
    const selector = [
      'input', 'textarea', 'button', 'a', 'select',
      '[role="button"]', '[role="link"]',
      'h1', 'h2', 'h3', 'p', 'td', 'th',
      'label', '[aria-label]',
    ].join(', ');
    const nodes = document.querySelectorAll(selector);
    const results = [];
    const MAX = 150;
    for (let i = 0; i < nodes.length && results.length < MAX; i++) {
      const el = nodes[i];
      if (el.offsetParent === null && el.tagName !== 'INPUT' && el.type !== 'hidden') continue;
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim();
      const truncated = text.length > 150 ? text.slice(0, 150) + '...' : text;
      results.push({
        tag: el.tagName.toLowerCase(),
        text: truncated,
        id: el.id || null,
        role: el.getAttribute('role') || null,
        type: el.getAttribute('type') || null,
        href: el.tagName === 'A' ? el.getAttribute('href') : null,
      });
    }
    return results;
  });
}

async function getPageContext() {
  try {
    await getCurrentPage();
    if (!page) return null;
    const url = page.url();
    const title = await page.title();
    const elements = await _extractElements(page);
    return { url, title, elements };
  } catch (err) {
    console.error('[browser] getPageContext error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Electron app CDP connections
// ---------------------------------------------------------------------------

/**
 * Connect to an Electron app via its CDP debug port.
 * Returns { browser, page, port, appName } or null.
 */
async function connectToApp(appName) {
  const key = appName.toLowerCase();
  const port = APP_DEBUG_PORTS[key];
  if (!port) return null;

  // Return existing connection if still alive
  if (connections[key]) {
    try {
      if (connections[key].browser.isConnected()) {
        return connections[key];
      }
    } catch { /* stale — reconnect */ }
    delete connections[key];
  }

  // Quick HTTP check before slow Playwright connect
  const alive = await _isCDPAlive(port);
  if (!alive) return null;

  try {
    const appBrowser = await chromium.connectOverCDP(`http://localhost:${port}`);
    const contexts = appBrowser.contexts();
    const pages = contexts[0]?.pages() || [];

    // Electron apps have multiple webviews — find the main content one
    const mainPage = pages.find((p) => {
      const url = p.url();
      return !url.includes('devtools://') &&
        !url.includes('chrome-extension://') &&
        !url.startsWith('about:');
    }) || pages[pages.length - 1];

    if (!mainPage) {
      console.error(`[browser] Connected to ${key} but no usable page found`);
      return null;
    }

    const conn = { browser: appBrowser, page: mainPage, port, appName: key };
    connections[key] = conn;
    console.log(`[browser] Connected to ${key} via CDP on port ${port}`);
    return conn;
  } catch (err) {
    if (err.message && err.message.includes('ECONNREFUSED')) {
      // App not running with debug port — expected, not an error
    } else {
      console.error(`[browser] Failed to connect to ${key}:`, err.message);
    }
    return null;
  }
}

/**
 * Kill an existing app instance and relaunch with --remote-debugging-port.
 * Waits 3 seconds, then tries to connect.
 * Returns connection or null.
 */
async function launchAndConnect(appName) {
  const key = appName.toLowerCase();
  const cmd = APP_LAUNCH_COMMANDS[key];
  if (!cmd) {
    if (IS_MAC) {
      console.warn(`[browser] Electron app CDP launch for "${key}" is not yet supported on macOS.`);
    }
    return null;
  }

  // Kill existing instance — platform-specific
  try {
    const { execSync } = require('child_process');
    if (IS_WIN) {
      execSync(`taskkill /IM ${key}.exe /F 2>nul`, { windowsHide: true });
    } else if (IS_MAC) {
      execSync(`pkill -f "${key}" 2>/dev/null || true`, { stdio: 'pipe' });
    } else {
      execSync(`pkill -f "${key}" 2>/dev/null || true`, { stdio: 'pipe' });
    }
  } catch { /* not running — fine */ }

  // Launch with debug port
  return new Promise((resolve) => {
    exec(cmd, { shell: true });

    // Wait for app to start, then connect
    setTimeout(async () => {
      const conn = await connectToApp(key);
      resolve(conn);
    }, 3000);
  });
}

/**
 * Detect the currently focused app and try CDP connection.
 * Returns { type: 'cdp', connection, appName } or { type: 'native', appName, title }.
 */
async function detectCurrentApp() {
  // On Windows use koffi, on macOS use AppleScript
  const title = _getForegroundTitle();
  if (!title) {
    return { type: 'none', appName: null, title: '' };
  }

  try {
    // Map title to known app
    for (const { pattern, app } of TITLE_TO_APP) {
      if (pattern.test(title)) {
        // Try CDP connection
        const conn = await connectToApp(app);
        if (conn) {
          return { type: 'cdp', connection: conn, appName: app };
        }
        // On macOS, Electron app CDP is mostly unsupported — give clear message
        if (IS_MAC && app !== 'chrome') {
          return {
            type: 'native',
            appName: app,
            title,
            note: `Electron app CDP for ${app} is not yet supported on macOS. Use keyboard shortcuts instead.`,
          };
        }
        return { type: 'native', appName: app, title };
      }
    }

    return { type: 'native', appName: null, title };
  } catch {
    return { type: 'none', appName: null, title: '' };
  }
}

/**
 * Get page context from an Electron app's CDP connection.
 */
async function getAppPageContext(appName) {
  const conn = connections[appName.toLowerCase()];
  if (!conn || !conn.page) return null;

  try {
    // Refresh the page reference — Electron might have changed views
    const contexts = conn.browser.contexts();
    const pages = contexts[0]?.pages() || [];
    const mainPage = pages.find((p) => {
      const url = p.url();
      return !url.includes('devtools://') &&
        !url.includes('chrome-extension://') &&
        !url.startsWith('about:');
    }) || pages[pages.length - 1];

    if (!mainPage) return null;
    conn.page = mainPage;

    const url = mainPage.url();
    const title = await mainPage.title();
    const elements = await _extractElements(mainPage);
    return { url, title, elements, appName };
  } catch (err) {
    console.error(`[browser] getAppPageContext(${appName}) error:`, err.message);
    // Connection might be dead — clean up
    delete connections[appName.toLowerCase()];
    return null;
  }
}

// ---------------------------------------------------------------------------
// Browser actions (cross-platform — these use Playwright which is already cross-platform)
// ---------------------------------------------------------------------------

async function cdpClick(selector) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };
    await page.click(selector, { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    console.error('[browser] cdpClick error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cdpClickText(text) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };
    await page.getByText(text, { exact: false }).first().click({ timeout: 5000 });
    return { ok: true };
  } catch (err) {
    console.error('[browser] cdpClickText error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cdpType(selector, text) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };
    await page.fill(selector, text, { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    console.error('[browser] cdpType error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cdpNavigate(url) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { ok: true };
  } catch (err) {
    console.error('[browser] cdpNavigate error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cdpPressKey(key) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };
    await page.keyboard.press(key);
    return { ok: true };
  } catch (err) {
    console.error('[browser] cdpPressKey error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cdpScroll(direction) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };
    const delta = direction === 'up' ? -400 : 400;
    await page.mouse.wheel(0, delta);
    return { ok: true };
  } catch (err) {
    console.error('[browser] cdpScroll error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cdpWaitForLoad(ms = 2000) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };
    await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => { });
    return { ok: true };
  } catch (err) {
    console.error('[browser] cdpWaitForLoad error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Chrome
  connectToChrome,
  autoConnectOrLaunchChrome,
  isConnected,
  isCDPAlive: _isCDPAlive,
  getPageContext,
  getCurrentPage,
  // Electron apps
  connectToApp,
  launchAndConnect,
  detectCurrentApp,
  getAppPageContext,
  // Browser actions
  cdpClick,
  cdpClickText,
  cdpType,
  cdpNavigate,
  cdpPressKey,
  cdpScroll,
  cdpWaitForLoad,
  // Registry
  APP_DEBUG_PORTS,
};
