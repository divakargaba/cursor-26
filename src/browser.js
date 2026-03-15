// browser.js — CDP browser control via Playwright (cross-platform)
// Connects to Chrome AND Electron apps (Discord, Spotify, Slack, etc.)
// via --remote-debugging-port for full DOM access.
//
// Platform-aware: detects Windows vs macOS for Chrome launch/detection,
// window title detection, and Electron app paths.

const { chromium } = require('playwright');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
// Find Chrome's actual install path (not in PATH on Windows)
// ---------------------------------------------------------------------------

function findChromePath() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  // Fallback: try registry
  try {
    const regOut = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
      { encoding: 'utf8', windowsHide: true, timeout: 3000 }
    );
    const match = regOut.match(/REG_SZ\s+(.+)/);
    if (match && fs.existsSync(match[1].trim())) return match[1].trim();
  } catch {}

  // Last resort — hope it's in PATH
  return 'chrome';
}

let _chromePath = null;
function getChromePath() {
  if (!_chromePath) {
    _chromePath = findChromePath();
    console.log(`[browser] Chrome path: ${_chromePath}`);
  }
  return _chromePath;
}

// ---------------------------------------------------------------------------
// App registry — Electron apps and their CDP debug ports
// ---------------------------------------------------------------------------

const APP_DEBUG_PORTS = {
  chrome: 9222, discord: 9224, spotify: 9227, slack: 9225,
  vscode: 9223, figma: 9226, notion: 9228, whatsapp: 9229,
  obsidian: 9230, teams: 9231,
};

// APP_LAUNCH_COMMANDS removed — the assistant never launches or kills user apps.

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
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.log(`[browser] CDP check port ${port}: HTTP ${res.status}`);
    }
    return res.ok;
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout (1.5s)' : (err.cause?.code || err.message || 'unknown');
    console.log(`[browser] CDP check port ${port} failed: ${reason}`);
    return false;
  }
}

// Track why CDP isn't connected — exposed to agent for context
let _lastCDPFailReason = '';

function getLastCDPFailReason() {
  return _lastCDPFailReason;
}

async function connectToChrome() {
  try {
    // Quick HTTP check first — avoids slow Playwright timeout if CDP isn't there
    const alive = await _isCDPAlive(9222);
    if (!alive) {
      const isRunning = await _isChromeRunning();
      _lastCDPFailReason = isRunning
        ? 'Chrome is running but port 9222 is not responding (not launched with --remote-debugging-port=9222)'
        : 'Chrome is not running';
      console.log(`[browser] CDP not alive: ${_lastCDPFailReason}`);
      browser = null;
      page = null;
      return false;
    }

    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

    // Tabs may take a moment to appear — retry a few times
    let p = null;
    for (let i = 0; i < 3; i++) {
      p = await getCurrentPage();
      if (p) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!p) {
      _lastCDPFailReason = 'CDP connected but no usable tabs found after retries';
      console.log(`[browser] ${_lastCDPFailReason}`);
      return false;
    }
    _lastCDPFailReason = '';
    console.log('[browser] Connected to Chrome via CDP');
    return true;
  } catch (err) {
    browser = null;
    page = null;
    _lastCDPFailReason = `CDP connect error: ${err.message}`;
    console.log(`[browser] ${_lastCDPFailReason}`);
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
 * Get the debug profile directory for Chrome CDP.
 * Chrome 136+ requires --user-data-dir to be a NON-default path for
 * --remote-debugging-port to take effect.
 */
function _getDebugUserDataDir() {
  if (IS_MAC) {
    return path.join(process.env.HOME || '/tmp', 'Library', 'Application Support', 'Google', 'ChromeDebug');
  } else if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Public', 'Google', 'ChromeDebug');
  }
  return path.join(process.env.HOME || '/tmp', '.config', 'google-chrome-debug');
}

/**
 * Launch Chrome with CDP enabled.
 * Uses a dedicated debug profile directory (required by Chrome 136+).
 */
function _launchChromeWithCDP() {
  const debugDir = _getDebugUserDataDir();
  const port = 9222;

  if (IS_MAC) {
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${debugDir}`,
    ], { detached: true, stdio: 'ignore' }).unref();
  } else if (IS_WIN) {
    // Try common Chrome locations on Windows
    const possiblePaths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const chromePath = possiblePaths.find((p) => fs.existsSync(p));
    if (!chromePath) {
      console.log('[browser] Could not find Chrome installation on Windows');
      return false;
    }
    spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${debugDir}`,
    ], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } else {
    spawn('google-chrome', [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${debugDir}`,
    ], { detached: true, stdio: 'ignore' }).unref();
  }

  console.log(`[browser] Launched Chrome with CDP on port ${port} (profile: ${debugDir})`);
  return true;
}

/**
 * Try to connect to Chrome's CDP on port 9222.
 * If Chrome isn't running with CDP, launches it automatically with the
 * correct flags (including --user-data-dir required by Chrome 136+).
 */
async function autoConnectOrLaunchChrome() {
  // Try existing CDP on port 9222
  const connected = await connectToChrome();
  if (connected) {
    return { connected: true, message: 'Connected to existing Chrome CDP' };
  }

  // CDP not available — launch Chrome with debugging enabled
  console.log('[browser] CDP not available, launching Chrome with debugging enabled...');
  const launched = _launchChromeWithCDP();
  if (!launched) {
    _lastCDPFailReason = 'Could not find or launch Chrome';
    return { connected: false, message: _lastCDPFailReason };
  }

  // Wait for Chrome to start and CDP to become available
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const alive = await _isCDPAlive(9222);
    if (alive) {
      const ok = await connectToChrome();
      if (ok) {
        return { connected: true, message: 'Launched Chrome and connected via CDP' };
      }
    }
  }

  _lastCDPFailReason = 'Launched Chrome but CDP did not become available within 10s';
  console.log(`[browser] ${_lastCDPFailReason}`);
  return { connected: false, message: _lastCDPFailReason };
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
    if (!contexts.length) {
      console.log('[browser] getCurrentPage: 0 contexts');
      page = null;
      return null;
    }

    // Search ALL contexts for pages (on macOS, default context may be empty)
    let allPages = [];
    for (const ctx of contexts) {
      const ctxPages = ctx.pages();
      allPages.push(...ctxPages);
    }
    console.log(`[browser] getCurrentPage: ${contexts.length} contexts, ${allPages.length} total pages`);
    if (!allPages.length) { page = null; return null; }

    // If we already have a valid page reference AND it's still in the list, keep it.
    // switchToTab explicitly sets `page`, so we respect that selection.
    if (page && allPages.includes(page)) {
      return page;
    }

    // No valid cached page — try to find the visible/active tab.
    // Playwright doesn't expose "active tab" directly, so pick the last page
    // (most recently opened/activated).
    page = allPages[allPages.length - 1];
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

/**
 * Extract rich page context from a Playwright page reference.
 * Returns { elements, inputs, mainContent, selectedText, metadata, focusedElement }.
 */
function _extractRichContext(pageRef) {
  return pageRef.evaluate(() => {
    // --- Visibility helper ---
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    // --- 1. Interactive elements (prioritized, max 40) ---
    const interactiveSelector = [
      'input', 'textarea', 'button', 'a', 'select',
      '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[role="tab"]', '[role="treeitem"]', '[role="option"]',
      '[contenteditable="true"]', '[data-slate-editor]',
    ].join(', ');
    const nodes = document.querySelectorAll(interactiveSelector);
    const focused = document.activeElement;
    const elements = [];
    const MAX_ELEMENTS = 40;

    // Focused element first
    if (focused && focused !== document.body && isVisible(focused)) {
      const text = (focused.innerText || focused.value || focused.placeholder || focused.getAttribute('aria-label') || '').trim();
      elements.push({
        tag: focused.tagName.toLowerCase(),
        text: text.length > 100 ? text.slice(0, 100) + '...' : text,
        id: focused.id || null,
        role: focused.getAttribute('role') || null,
        type: focused.getAttribute('type') || null,
        href: focused.tagName === 'A' ? focused.getAttribute('href') : null,
        focused: true,
      });
    }

    for (let i = 0; i < nodes.length && elements.length < MAX_ELEMENTS; i++) {
      const el = nodes[i];
      if (el === focused) continue; // already added
      if (!isVisible(el)) continue;
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim();
      elements.push({
        tag: el.tagName.toLowerCase(),
        text: text.length > 100 ? text.slice(0, 100) + '...' : text,
        id: el.id || null,
        role: el.getAttribute('role') || null,
        type: el.getAttribute('type') || null,
        href: el.tagName === 'A' ? el.getAttribute('href') : null,
      });
    }

    // --- 2. Input fields with current values ---
    const inputNodes = document.querySelectorAll('input, textarea, select, [contenteditable="true"], [data-slate-editor]');
    const inputs = [];
    for (let i = 0; i < inputNodes.length && inputs.length < 15; i++) {
      const el = inputNodes[i];
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : null);
      // Skip hidden/submit inputs
      if (type === 'hidden' || type === 'submit') continue;
      const value = (el.value || el.textContent || '').trim();
      const label = el.getAttribute('aria-label')
        || (el.labels && el.labels[0] ? el.labels[0].textContent.trim() : null)
        || el.getAttribute('placeholder')
        || el.getAttribute('name')
        || el.id
        || null;
      inputs.push({
        tag,
        type,
        id: el.id || null,
        name: el.getAttribute('name') || null,
        label,
        placeholder: el.getAttribute('placeholder') || null,
        value: value.length > 80 ? value.slice(0, 80) + '...' : value,
        focused: el === focused,
      });
    }

    // --- 3. Main page content ---
    let mainContent = null;
    // Try common content containers
    const contentSelectors = [
      'article', 'main', '[role="main"]',
      '.post-content', '.article-body', '.email-body',
      '.message-content', '.chat-messages',
    ];
    for (const sel of contentSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        const text = (el.innerText || '').trim();
        if (text.length > 50) {
          mainContent = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
          break;
        }
      }
    }
    // Fallback: body text (truncated)
    if (!mainContent) {
      const bodyText = (document.body.innerText || '').trim();
      if (bodyText.length > 100) {
        mainContent = bodyText.length > 2000 ? bodyText.slice(0, 2000) + '...' : bodyText;
      }
    }

    // --- 4. Selected text ---
    const selection = window.getSelection();
    const selectedText = selection && selection.toString().trim() ? selection.toString().trim() : null;

    // --- 5. Focused element description ---
    let focusedElement = null;
    if (focused && focused !== document.body && isVisible(focused)) {
      const tag = focused.tagName.toLowerCase();
      const label = focused.getAttribute('aria-label') || focused.getAttribute('placeholder') || focused.id || tag;
      focusedElement = `${tag}[${label}]`;
    }

    // --- 6. Page metadata ---
    const url = window.location.href;
    let domain;
    try { domain = new URL(url).hostname; } catch { domain = 'unknown'; }
    const metadata = {
      url,
      domain,
      formCount: document.forms.length,
      title: document.title,
    };

    return { elements, inputs, mainContent, selectedText, focusedElement, metadata };
  });
}

async function getPageContext() {
  try {
    await getCurrentPage();
    if (!page) return null;
    const url = page.url();
    const title = await page.title();
    console.log(`[browser] getPageContext → tab: ${url.slice(0, 80)} — "${title.slice(0, 50)}"`);

    const rich = await _extractRichContext(page);
    return {
      url,
      title,
      elements: rich.elements || [],
      inputs: rich.inputs || [],
      mainContent: rich.mainContent || null,
      selectedText: rich.selectedText || null,
      focusedElement: rich.focusedElement || null,
      metadata: rich.metadata || { domain: 'unknown' },
    };
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
 * launchAndConnect is disabled — the assistant must never kill or relaunch user apps.
 * Use connectToApp() to connect to an app that already has a CDP debug port.
 */
async function launchAndConnect(_appName) {
  console.log(`[browser] launchAndConnect disabled — will not kill or relaunch apps. Use connectToApp() instead.`);
  return null;
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
    const rich = await _extractRichContext(mainPage);
    return {
      url, title, appName,
      elements: rich.elements || [],
      inputs: rich.inputs || [],
      mainContent: rich.mainContent || null,
      selectedText: rich.selectedText || null,
      focusedElement: rich.focusedElement || null,
      metadata: rich.metadata || { domain: 'unknown' },
    };
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

/**
 * List all open tabs (pages) in the Chrome browser context.
 * Returns [{ url, title, index }] or empty array.
 */
/**
 * Get all tab URLs without awaiting .title() (which can hang on some pages).
 * Returns array of { url } objects synchronously from Playwright's page cache.
 */
function getTabUrls() {
  try {
    if (!browser || !browser.isConnected()) return [];
    const contexts = browser.contexts();
    if (!contexts.length) return [];
    const results = [];
    for (const ctx of contexts) {
      for (const p of ctx.pages()) {
        try {
          const url = p.url();
          if (url && !url.startsWith('chrome://') &&
              !url.startsWith('chrome-extension://') &&
              !url.startsWith('devtools://') &&
              url !== 'about:blank') {
            results.push({ url });
          }
        } catch { /* skip */ }
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function listTabs() {
  try {
    if (!browser || !browser.isConnected()) return [];
    const contexts = browser.contexts();
    if (!contexts.length) return [];
    // Search all contexts for pages
    const allPages = [];
    for (const ctx of contexts) {
      allPages.push(...ctx.pages());
    }
    const tabs = [];
    for (let i = 0; i < allPages.length; i++) {
      try {
        const url = allPages[i].url();
        const title = await allPages[i].title();
        tabs.push({ url, title, index: i });
      } catch {
        tabs.push({ url: '(error)', title: '(error)', index: i });
      }
    }
    return tabs;
  } catch (err) {
    console.error('[browser] listTabs error:', err.message);
    return [];
  }
}

/**
 * Switch to a tab whose URL or title matches the given pattern (case-insensitive).
 * Sets the module-level `page` to the matched tab so all subsequent actions use it.
 * Returns { ok, url, title } or { ok: false, error }.
 */
async function switchToTab(pattern) {
  try {
    if (!browser || !browser.isConnected()) {
      return { ok: false, error: 'No browser connection' };
    }
    const contexts = browser.contexts();
    if (!contexts.length) return { ok: false, error: 'No browser context' };
    // Search all contexts
    const allPages = [];
    for (const ctx of contexts) {
      allPages.push(...ctx.pages());
    }

    const regex = new RegExp(pattern, 'i');
    for (const p of allPages) {
      try {
        const url = p.url();
        const title = await p.title();
        if (regex.test(url) || regex.test(title)) {
          page = p;
          // Bring the tab to front via CDP
          try { await p.bringToFront(); } catch { /* best effort */ }
          console.log(`[browser] Switched to tab: ${url} — "${title}"`);
          return { ok: true, url, title };
        }
      } catch { /* skip broken page */ }
    }
    return { ok: false, error: `No tab matching "${pattern}". Use list_tabs to see open tabs.` };
  } catch (err) {
    console.error('[browser] switchToTab error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cdpClick(selector) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };

    // Attempt 1: direct selector click
    try {
      await page.click(selector, { timeout: 3000 });
      return { ok: true };
    } catch (selectorError) {
      console.log(`[browser] click_selector failed for "${selector}", trying fallbacks...`);

      // Fallback 1: Try finding by visible text if the element has text content
      try {
        const textContent = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el?.textContent?.trim();
        }, selector);

        if (textContent) {
          await page.click(`text="${textContent}"`, { timeout: 3000 });
          console.log(`[browser] fallback_text worked for "${selector}"`);
          return { ok: true, method: 'fallback_text' };
        }
      } catch { /* text fallback failed */ }

      // Fallback 2: If selector was an ID, try by attribute
      try {
        if (selector.startsWith('#')) {
          const id = selector.slice(1);
          await page.click(`[id="${id}"]`, { timeout: 3000 });
          console.log(`[browser] fallback_attribute worked for "${selector}"`);
          return { ok: true, method: 'fallback_attribute' };
        }
      } catch { /* attribute fallback failed */ }

      // Fallback 3: Force click bypasses actionability checks
      try {
        await page.click(selector, { timeout: 2000, force: true });
        console.log(`[browser] force_click worked for "${selector}"`);
        return { ok: true, method: 'force_click' };
      } catch { /* force click also failed */ }

      // All fallbacks failed
      return {
        ok: false,
        error: `Could not click "${selector}". Element may not exist, may be hidden, or may have changed. Suggestion: use read_page to refresh the element list, or try click_text with the visible label.`,
      };
    }
  } catch (err) {
    console.error('[browser] cdpClick error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cdpClickText(text) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };

    // Strategy 1: role-based (only interactive/visible elements)
    try {
      await page.getByRole('link', { name: text }).or(
        page.getByRole('button', { name: text })
      ).or(
        page.getByRole('treeitem', { name: text })
      ).first().click({ timeout: 2000 });
      return { ok: true };
    } catch {}

    // Strategy 2: JS — find visible clickable element with matching text
    const clicked = await page.evaluate((searchText) => {
      const lower = searchText.toLowerCase();
      const candidates = document.querySelectorAll(
        'a, button, [role="button"], [role="link"], [role="treeitem"], [role="listitem"], [role="menuitem"], [role="tab"], li, span, div[class*="channel"], div[class*="chat"]'
      );
      for (const el of candidates) {
        if (el.offsetParent === null) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (t.toLowerCase() === lower || t.toLowerCase().includes(lower)) {
          const rect = el.getBoundingClientRect();
          if (rect.height > 0 && rect.width > 0) {
            el.scrollIntoViewIfNeeded?.();
            el.click();
            return true;
          }
        }
      }
      return false;
    }, text);

    if (clicked) return { ok: true };
    return { ok: false, error: `No visible element with text "${text}" found` };
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
    // Bring Chrome to front so user sees what's happening
    try { await page.bringToFront(); } catch {}
    return { ok: true };
  } catch (err) {
    console.error('[browser] cdpNavigate error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function bringBrowserToFront() {
  try {
    await getCurrentPage();
    if (page) await page.bringToFront();
  } catch {}
}

const KEY_ALIASES = {
  'return': 'Enter', 'esc': 'Escape', 'del': 'Delete', 'ins': 'Insert',
  'cmd': 'Meta', 'command': 'Meta', 'ctrl': 'Control', 'option': 'Alt',
  'space': ' ', 'spacebar': ' ',
};

async function cdpPressKey(key) {
  try {
    await getCurrentPage();
    if (!page) return { ok: false, error: 'No page available' };
    const normalized = KEY_ALIASES[key.toLowerCase()] || key;
    await page.keyboard.press(normalized);
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
  getLastCDPFailReason,
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
  // Tab management
  getTabUrls,
  listTabs,
  switchToTab,
  // Browser actions
  cdpClick,
  cdpClickText,
  cdpType,
  cdpNavigate,
  cdpPressKey,
  cdpScroll,
  bringBrowserToFront,
  getChromePath,
  cdpWaitForLoad,
  // Registry
  APP_DEBUG_PORTS,
};
