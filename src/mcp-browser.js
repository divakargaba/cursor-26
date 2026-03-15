// src/mcp-browser.js — Chrome DevTools MCP client
// Feature-flagged alternative to browser.js (Playwright)
// Spawns chrome-devtools-mcp as stdio subprocess, communicates via JSON-RPC
// Exports same API surface as browser.js for drop-in replacement

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

let mcpProcess = null;
let requestId = 0;
let pendingRequests = new Map();
let initialized = false;

// ---------------------------------------------------------------------------
// MCP server lifecycle
// ---------------------------------------------------------------------------

async function start(options = {}) {
  if (mcpProcess && initialized) return true;

  // Prefer local node_modules binary over npx (avoids PATH issues in Electron)
  const localBin = path.join(__dirname, '..', 'node_modules', '.bin', 'chrome-devtools-mcp');
  let cmd, args;

  try {
    require('fs').accessSync(localBin);
    cmd = localBin;
    args = [];
  } catch {
    cmd = 'npx';
    args = ['-y', 'chrome-devtools-mcp@latest'];
  }

  if (options.browserUrl) args.push(`--browser-url=${options.browserUrl}`);
  else if (options.executablePath) args.push(`--executable-path=${options.executablePath}`);
  if (options.noUsageStatistics) args.push('--no-usage-statistics');

  mcpProcess = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      PROGRAMFILES: process.env.PROGRAMFILES || 'C:\\Program Files',
    },
  });

  // Read stdout line by line (JSON-RPC responses)
  const rl = readline.createInterface({ input: mcpProcess.stdout });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve, reject } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch { /* non-JSON stderr bleed or partial line */ }
  });

  mcpProcess.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text) console.log('[mcp-browser stderr]', text);
  });

  mcpProcess.on('exit', (code) => {
    console.log(`[mcp-browser] MCP server exited with code ${code}`);
    mcpProcess = null;
    initialized = false;
    pendingRequests.clear();
  });

  // Initialize MCP protocol
  await _sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ai-assistant', version: '0.1.0' },
  });

  _sendNotification('notifications/initialized', {});
  initialized = true;
  console.log('[mcp-browser] MCP server initialized');
  return true;
}

function stop() {
  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
    initialized = false;
    pendingRequests.clear();
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

function _sendRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess) return reject(new Error('MCP server not running'));
    const id = ++requestId;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    pendingRequests.set(id, { resolve, reject });
    mcpProcess.stdin.write(msg + '\n');
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }
    }, 15000);
  });
}

function _sendNotification(method, params = {}) {
  if (!mcpProcess) return;
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  mcpProcess.stdin.write(msg + '\n');
}

async function _callTool(name, args = {}) {
  return await _sendRequest('tools/call', { name, arguments: args });
}

// ---------------------------------------------------------------------------
// Compatibility shim — matches browser.js export names
// ---------------------------------------------------------------------------

function isConnected() {
  return mcpProcess !== null && initialized;
}

async function autoConnectOrLaunchChrome(options = {}) {
  // Try connecting to existing Chrome first (reuses user's authenticated session)
  try {
    await start({ ...options, browserUrl: 'http://localhost:9222' });
    console.log('[mcp-browser] Connected to existing Chrome on port 9222');
    return { connected: true, message: 'MCP connected to existing Chrome' };
  } catch (err) {
    console.log('[mcp-browser] No existing Chrome on 9222, launching new instance:', err.message);
    stop();
  }
  // Fall back to launching a new Chrome instance
  try {
    await start(options);
    return { connected: true, message: 'MCP browser server started (new Chrome)' };
  } catch (err) {
    return { connected: false, message: `MCP start failed: ${err.message}` };
  }
}

async function cdpNavigate(url) {
  try {
    await _callTool('navigate_page', { url });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cdpClick(selector) {
  try {
    await _callTool('click', { selector });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cdpClickText(text) {
  try {
    await _callTool('click', { selector: `text/${text}` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cdpType(selector, value) {
  try {
    await _callTool('fill', { selector, value });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cdpPressKey(key) {
  try {
    await _callTool('press_key', { key });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cdpScroll(direction) {
  try {
    const delta = direction === 'up' ? -400 : 400;
    await _callTool('evaluate_script', { expression: `window.scrollBy(0, ${delta})` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cdpWaitForLoad(_ms) {
  // MCP handles load internally after navigate_page
  return { ok: true };
}

async function getPageContext() {
  try {
    const result = await _callTool('take_snapshot');
    // Parse snapshot into compatible format
    // take_snapshot returns accessibility tree text — extract what we can
    const content = result?.content?.[0]?.text || '';
    if (!content) return null;

    // Return a simplified context compatible with agent.js expectations
    return {
      url: '(via MCP)',
      title: '(snapshot)',
      elements: content.split('\n').slice(0, 30).map((line) => ({
        tag: 'span',
        text: line.trim().slice(0, 150),
        id: null,
        role: null,
        type: null,
      })).filter((e) => e.text.length > 0),
    };
  } catch (err) {
    console.error('[mcp-browser] getPageContext error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exports — same surface as browser.js
// ---------------------------------------------------------------------------

module.exports = {
  // Lifecycle
  start,
  stop,
  autoConnectOrLaunchChrome,
  isConnected,
  // Browser actions (browser.js-compatible names)
  cdpNavigate,
  cdpClick,
  cdpClickText,
  cdpType,
  cdpPressKey,
  cdpScroll,
  cdpWaitForLoad,
  getPageContext,
  // Not supported in MCP mode (Chrome-only features)
  connectToChrome: async () => false,
  connectToApp: async () => null,
  launchAndConnect: async () => null,
  detectCurrentApp: async () => ({ type: 'none', appName: null, title: '' }),
  getAppPageContext: async () => null,
  getCurrentPage: async () => null,
  bringBrowserToFront: async () => {
    // In MCP mode, bring Chrome to front via CDP
    try { await _callTool('evaluate_script', { expression: 'window.focus()' }); } catch {}
  },
  getChromePath: () => 'chrome',
  isCDPAlive: async () => isConnected(),
  APP_DEBUG_PORTS: {},
};
