# Switch from Playwright to Chrome DevTools MCP

## What Chrome DevTools MCP Provides
An MCP server you spawn as a subprocess. It manages Chrome+Puppeteer internally. You send JSON-RPC calls over stdio, it executes browser actions and returns results. No Playwright needed.

**26 tools:** click, fill, type_text, press_key, navigate_page, take_screenshot, take_snapshot, evaluate_script, list_pages, new_page, etc.

## Architecture Change

```
BEFORE:  agent.js → browser.js → Playwright → Chrome CDP
AFTER:   agent.js → mcp-browser.js → stdio JSON-RPC → chrome-devtools-mcp → Puppeteer → Chrome
```

## Step 1: Install chrome-devtools-mcp

```bash
npm install chrome-devtools-mcp
```

Or we'll spawn it via `npx` — no install needed:
```js
const mcpProcess = spawn('npx', ['-y', 'chrome-devtools-mcp@latest'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PROGRAMFILES: 'C:\\Program Files' }
});
```

## Step 2: Create `src/mcp-browser.js` — MCP Client

This is a thin wrapper that spawns the MCP server and sends/receives JSON-RPC messages.

```js
// src/mcp-browser.js — Chrome DevTools MCP client
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

let mcpProcess = null;
let requestId = 0;
let pendingRequests = new Map(); // id → { resolve, reject }
let initialized = false;

// Spawn the MCP server
async function start(options = {}) {
  const args = ['-y', 'chrome-devtools-mcp@latest'];
  
  // Options
  if (options.browserUrl) args.push(`--browser-url=${options.browserUrl}`);
  if (options.headless) args.push('--headless');
  if (options.executablePath) args.push(`--executable-path=${options.executablePath}`);
  if (options.noUsageStatistics) args.push('--no-usage-statistics');
  // --slim for lightweight mode (fewer tools, faster)
  // args.push('--slim');
  
  mcpProcess = spawn('npx', args, {
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
    } catch {}
  });
  
  mcpProcess.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text) console.log('[mcp-browser stderr]', text);
  });
  
  mcpProcess.on('exit', (code) => {
    console.log(`[mcp-browser] MCP server exited with code ${code}`);
    mcpProcess = null;
    initialized = false;
  });
  
  // Initialize MCP protocol
  await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ai-assistant', version: '0.1.0' },
  });
  
  // Send initialized notification
  sendNotification('notifications/initialized', {});
  initialized = true;
  console.log('[mcp-browser] MCP server initialized');
  return true;
}

function sendRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess) return reject(new Error('MCP server not running'));
    const id = ++requestId;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    pendingRequests.set(id, { resolve, reject });
    mcpProcess.stdin.write(msg + '\n');
    // Timeout after 15s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }
    }, 15000);
  });
}

function sendNotification(method, params = {}) {
  if (!mcpProcess) return;
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  mcpProcess.stdin.write(msg + '\n');
}

// Call an MCP tool
async function callTool(name, args = {}) {
  const result = await sendRequest('tools/call', { name, arguments: args });
  return result;
}

function isConnected() {
  return mcpProcess !== null && initialized;
}

async function stop() {
  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
    initialized = false;
  }
}

// ================================================
// HIGH-LEVEL WRAPPERS (matching current browser.js API)
// ================================================

async function navigate(url) {
  try {
    const result = await callTool('navigate_page', { url });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function clickElement(selector) {
  try {
    await callTool('click', { selector });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function clickText(text) {
  // MCP click supports text-based selectors
  try {
    await callTool('click', { selector: `text/${text}` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function typeText(text) {
  try {
    await callTool('type_text', { text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fill(selector, value) {
  try {
    await callTool('fill', { selector, value });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pressKey(key) {
  try {
    await callTool('press_key', { key });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function takeSnapshot() {
  // Returns an accessibility tree snapshot (structured text, NOT an image)
  // This is the low-token-cost way to "read" the page
  try {
    const result = await callTool('take_snapshot');
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

async function takeScreenshot() {
  try {
    const result = await callTool('take_screenshot');
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

async function evaluateScript(expression) {
  try {
    const result = await callTool('evaluate_script', { expression });
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

async function listPages() {
  try {
    return await callTool('list_pages');
  } catch (err) {
    return { error: err.message };
  }
}

async function bringToFront() {
  // MCP doesn't have a dedicated bringToFront.
  // Use evaluate_script to call window.focus() or use select_page
  try {
    await callTool('evaluate_script', { expression: 'window.focus()' });
  } catch {}
}

module.exports = {
  start,
  stop,
  isConnected,
  callTool,
  // High-level wrappers
  navigate,
  clickElement,
  clickText,
  typeText,
  fill,
  pressKey,
  takeSnapshot,
  takeScreenshot,
  evaluateScript,
  listPages,
  bringToFront,
};
```

## Step 3: Update [electron/main.js](file:///c:/Users/omara/ai-assistant/electron/main.js) — Replace browser startup

```diff
-const browser = require('../src/browser');
+const mcpBrowser = require('../src/mcp-browser');

// In startup:
-    cdpResult = await browser.autoConnectOrLaunchChrome();
+    try {
+      const chromePath = findChromePath(); // reuse existing function
+      await mcpBrowser.start({
+        executablePath: chromePath,
+        noUsageStatistics: true,
+      });
+      console.log('[startup] Chrome DevTools MCP connected');
+    } catch (err) {
+      console.error('[startup] MCP browser start failed:', err.message);
+    }

// Pass to agent:
     agent = new Agent({
-      browser,
+      browser: mcpBrowser,
       computer,
       screenshotFn: captureScreen,
       ...
     });
```

## Step 4: Update [agent.js](file:///c:/Users/omara/ai-assistant/src/agent.js) — [_execBrowserAction](file:///c:/Users/omara/ai-assistant/src/agent.js#546-653) tool remapping

The agent's `browser_action` tool stays the same from Claude's perspective. But internally we remap to MCP calls:

| Current action | MCP tool | Notes |
|---|---|---|
| `navigate` | `navigate_page({ url })` | |
| `read_page` | `take_snapshot()` | Returns accessibility tree, NOT DOM |
| `click_selector` | `click({ selector })` | |
| `click_text` | `click({ selector: "text/..." })` | MCP supports text selectors natively |
| [type](file:///c:/Users/omara/ai-assistant/src/computer.js#282-300) | `fill({ selector, value })` or `type_text({ text })` | `fill` for form fields, `type_text` for keyboard input |
| `press_key` | `press_key({ key })` | Uses standard key names |
| [scroll](file:///c:/Users/omara/ai-assistant/src/computer.js#271-277) | Not directly available — use `evaluate_script` | |

Update [_execBrowserAction](file:///c:/Users/omara/ai-assistant/src/agent.js#546-653):
```js
async _execBrowserAction(input) {
  const { action } = input;
  if (!this.browser || !this.browser.isConnected()) {
    return [{ type: 'text', text: 'Browser not connected. Restarting...' }];
  }
  
  switch (action) {
    case 'navigate': {
      const res = await this.browser.navigate(input.url);
      if (!res.ok) return [{ type: 'text', text: `Navigation failed: ${res.error}` }];
      // Auto-read page after navigate
      const snapshot = await this.browser.takeSnapshot();
      return [{ type: 'text', text: `Navigated to ${input.url}\n\n${formatSnapshot(snapshot)}` }];
    }
    case 'read_page': {
      const snapshot = await this.browser.takeSnapshot();
      return [{ type: 'text', text: formatSnapshot(snapshot) }];
    }
    case 'click_selector': {
      const res = await this.browser.clickElement(input.selector);
      return [{ type: 'text', text: res.ok ? `Clicked ${input.selector}` : `Click failed: ${res.error}` }];
    }
    case 'click_text': {
      const res = await this.browser.clickText(input.text);
      return [{ type: 'text', text: res.ok ? `Clicked "${input.text}"` : `Click failed: ${res.error}` }];
    }
    case 'type': {
      if (input.selector) {
        const res = await this.browser.fill(input.selector, input.value || input.text);
        return [{ type: 'text', text: res.ok ? 'Typed text' : `Type failed: ${res.error}` }];
      }
      const res = await this.browser.typeText(input.value || input.text);
      return [{ type: 'text', text: res.ok ? 'Typed text' : `Type failed: ${res.error}` }];
    }
    case 'press_key': {
      const res = await this.browser.pressKey(input.key);
      return [{ type: 'text', text: res.ok ? `Pressed ${input.key}` : `Key failed: ${res.error}` }];
    }
    // ... etc
  }
}
```

## Step 5: Remove Playwright dependency

```bash
npm uninstall playwright playwright-core
```

Update [package.json](file:///c:/Users/omara/ai-assistant/package.json) to remove Playwright. The old [browser.js](file:///c:/Users/omara/ai-assistant/src/browser.js) can be kept as `browser.legacy.js` for reference but shouldn't be imported.

## Step 6: Update old browser.js references

All imports of `./browser` need to point to `./mcp-browser` instead. Check:
- [electron/main.js](file:///c:/Users/omara/ai-assistant/electron/main.js)
- [src/agent.js](file:///c:/Users/omara/ai-assistant/src/agent.js) (constructor only — the browser module is passed in)

## Key Advantages After Switch
1. **No more hidden element bugs** — MCP click uses Puppeteer's smart element targeting
2. **No more `--remote-debugging-port` headaches** — MCP server manages Chrome lifecycle
3. **`take_snapshot`** returns an accessibility tree (text), not DOM HTML — way fewer tokens
4. **`fill` vs `type_text`** distinction — fill for form fields, type for keyboard
5. **Built-in key name handling** — no more "Return" vs "Enter" confusion
6. **Chrome auto-launches** — MCP server spawns Chrome if not running

## Testing After Switch
1. `npm start` → verify `[mcp-browser] MCP server initialized` in logs
2. Say "go to google.com" → Chrome should open and navigate
3. Say "search for weather" → should type in search box and press Enter
4. Say "go to discord.com and message KingD" → navigate + find chat + type + send
5. Check console for `[mcp-browser stderr]` errors
