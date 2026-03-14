// src/agent.js — 4-tool agent: browser_action, native_action, take_screenshot, request_confirmation
// Enhanced with grid overlay for accurate click targeting
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const Memory = require('./memory');
const { overlayGrid, resolveCell } = require('./grid-overlay');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4096;
const MAX_ITERATIONS = 15;
const MAX_HISTORY = 20;

// Loop detection thresholds (hash-based, from OpenClaw)
const LOOP_HISTORY_SIZE = 15;
const LOOP_WARNING_THRESHOLD = 4;
const LOOP_HALT_THRESHOLD = 7;

// ---------------------------------------------------------------------------
// Tool definitions — exactly 4 tools
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'browser_action',
    description: 'Control browser via CDP. ALWAYS use this first for anything on a website or Electron app with CDP connected.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['navigate', 'read_page', 'click_selector', 'click_text', 'type', 'scroll', 'press_key'] },
        url: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        value: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down'] },
        key: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'native_action',
    description: 'Control native desktop apps (not browser) via accessibility + mouse/keyboard. IMPORTANT: Always call focus_window FIRST before type/key/click to ensure keystrokes go to the right app. For click: prefer using cell (grid label like "F4") from the last screenshot over raw x/y. read_screen gives you a list of interactive elements with exact coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read_screen', 'click', 'type', 'key', 'scroll', 'run_command', 'focus_window'] },
        target: { type: 'string' },
        value: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        cell: { type: 'string', description: 'Grid cell label from screenshot (e.g. "F4", "B2"). Preferred over x/y.' },
        command: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot with grid overlay. Returns the image with labeled grid cells (A1-L8) so you can identify exact click targets. Use this when you need to see the screen to decide where to click. Prefer using the grid cell labels for clicking (e.g. cell="F4") over guessing raw pixel coordinates.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'request_confirmation',
    description: 'ALWAYS call this before send/submit/delete/post. Shows preview, waits for user.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        details: { type: 'string' },
        risks: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'details'],
    },
  },
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a voice-first AI copilot controlling a computer alongside a tired user.

VOICE: Keep spoken replies to 1-2 sentences. Casual and warm. Never bullet lists.

SPEED IS EVERYTHING — RETURN ALL ACTIONS IN ONE RESPONSE:
- You MUST return ALL tool calls for a task in a SINGLE response. Every extra round-trip wastes 3-5 seconds.
- GOOD: focus_window + key + type + key = 4 tool calls, 1 response, ~5 seconds total.
- BAD: focus_window (wait) → key (wait) → type (wait) → key = 4 responses, 20+ seconds.
- For known tasks, you already know the steps. Do them ALL at once:
  - "type hello in notepad" → focus_window(notepad) + type(hello). Done. 1 response.
  - "text Mixo on Discord" → focus_window(discord) + key(ctrl+k) + type(Mixo) + key(enter) + type(message) + key(enter). All in 1 response.
  - "open Google Docs and type something" → navigate(docs.new) in response 1, then read_page + click + type in response 2. Max 2 responses.

FOCUS MANAGEMENT — CRITICAL:
- The overlay is always visible but NEVER has keyboard focus.
- Before ANY type/key/click action on a native app, call focus_window FIRST in the same response.
- focus_window takes a title pattern (regex) to find and focus the target window.
- Example patterns: "Notepad", "Discord", "Spotify", "Visual Studio Code"
- Without focus_window, keystrokes go to the WRONG window.

CLICK TARGETING — 3-TIER SYSTEM (never guess coordinates):
Tier 1 — ELEMENT NAMES (best): read_screen returns UI elements with exact coordinates from Windows UIAutomation.
  - Use target="button name" to click elements by name — pixel-perfect accuracy.
  - Always try read_screen FIRST for native apps.
Tier 2 — GRID CELLS (good): take_screenshot returns an image with a labeled grid (A1 through L8, 12 cols × 8 rows).
  - Use cell="F4" in native_action click — maps to the center of that grid cell.
  - Sub-cell: append -TL, -TR, -BL, -BR (e.g. cell="F4-TL" for top-left quarter).
  - Use this when read_screen finds no elements (Electron/custom UI apps).
Tier 3 — RAW COORDINATES (last resort): Only use x/y if tiers 1 and 2 fail.
  - NEVER guess coordinates from a screenshot image. ALWAYS derive them from read_screen elements or grid cells.

ACTION VERIFICATION — CRITICAL (do not hallucinate):
- After type/key/click, the result tells you the active window title. CHECK IT.
- If the result says "WARNING: Window focus may have changed" — the text likely went to the WRONG window. Take a screenshot to verify.
- NEVER claim you typed or clicked successfully without evidence. The tool result only confirms the ACTION was sent, NOT that it landed correctly.
- After typing into an app, take_screenshot to VERIFY the text actually appeared. Do NOT assume success.
- If clicking didn't change anything (same window title, no expected result), DON'T retry the same click.
- Instead: try a DIFFERENT approach — keyboard shortcut, different element, or ask the user.
- If you've tried 2+ times with no progress, take_screenshot to see what actually happened.

BROWSER (browser_action):
- Use for ANYTHING in a browser. It's instant via CDP — no screenshots needed.
- Chrome is auto-connected via CDP. If not connected, it will auto-launch.
- After navigate: read_page in the SAME response or next one.
- read_page gives you the full DOM — use element IDs, selectors, or text to target clicks/types.
- click_selector and click_text are PRECISE — they use CSS selectors, not coordinates.

ELECTRON APPS (Discord, Spotify, Slack, VS Code, Figma, Notion, WhatsApp, Obsidian, Teams):
- Use native_action with keyboard shortcuts. CDP is NOT available for these.
- KEYBOARD SHORTCUTS are fast and reliable for Electron apps:
  - Discord: Ctrl+K opens quick switcher, type channel/user name, Enter to select, then type message, then Enter TO SEND.
  - Spotify: Ctrl+K for search. Space to play/pause.
  - Slack: Ctrl+K for quick switcher, type channel name, Enter.
- ALWAYS press Enter after typing a message to SEND it. Typing without Enter just leaves text in the box.
- Full sequence for "send X in Discord #general": focus_window(Discord) → key(ctrl+k) → type(general) → key(enter) → type(X) → key(enter).

NATIVE APPS (native_action):
- For non-browser, non-Electron apps (Notepad, File Explorer, Excel, etc.)
- ALWAYS call focus_window before type/key/click actions.
- Use read_screen to see available UI elements with exact positions BEFORE clicking.
- read_screen uses Windows UIAutomation (buttons, text fields, menus with bounding rects).
- run_command to open apps.

SCREENSHOT (take_screenshot):
- Returns a grid-labeled screenshot. Use the grid labels (A1-L8) to identify click targets.
- After getting a screenshot, use cell="A3" in native_action click, not raw pixel guesses.
- Grid cells are ~160x135 pixels each. For precise targeting, use sub-cell (-TL, -TR, -BL, -BR).

CONFIRMATIONS (request_confirmation):
- ALWAYS before send/submit/delete/purchase. Never skip.

If stuck after a few tries, TELL THE USER what's happening. Don't silently retry the same thing.`;

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

class Agent {
  /**
   * @param {Object} opts
   * @param {Object} opts.browser       - browser.js module (CDP control)
   * @param {Object} opts.computer      - computer.js module (native control)
   * @param {Function} opts.screenshotFn - async () => { ok, data, mediaType, error }
   * @param {Function} opts.onProgress   - ({ type: 'status'|'text', text }) => void
   * @param {Function} opts.onConfirmationRequest - async ({ summary, details, risks }) => { confirmed: bool, reason? }
   */
  constructor({ browser, computer, screenshotFn, blurOverlayFn, onProgress, onConfirmationRequest }) {
    this.client = new Anthropic();
    this.browser = browser;
    this.computer = computer;
    this.screenshotFn = screenshotFn;
    this.blurOverlayFn = blurOverlayFn || (() => { });
    this.onProgress = onProgress || (() => { });
    this.onConfirmationRequest = onConfirmationRequest || (async () => ({ confirmed: false, reason: 'No confirmation handler' }));
    this.history = [];
    this.toolCallHistory = []; // for loop detection
    this.memory = new Memory();
    this._currentActions = []; // track actions for memory recording
    this._activeElectronApp = null; // currently CDP-connected Electron app
    this._lastGridMap = null; // grid cell map from last screenshot
  }

  // =========================================================================
  // Loop detection (hash-based, warn at 4, halt at 7)
  // =========================================================================

  _hashToolCall(name, input) {
    const stable = this._stableStringify(input);
    const digest = crypto.createHash('sha256').update(stable).digest('hex').slice(0, 12);
    return `${name}:${digest}`;
  }

  _stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => this._stableStringify(v)).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${this._stableStringify(value[k])}`).join(',')}}`;
  }

  _recordToolCall(name, input) {
    this.toolCallHistory.push({
      hash: this._hashToolCall(name, input),
      name,
      ts: Date.now(),
    });
    if (this.toolCallHistory.length > LOOP_HISTORY_SIZE) {
      this.toolCallHistory.shift();
    }
  }

  _detectLoop(name, input) {
    const hash = this._hashToolCall(name, input);
    const count = this.toolCallHistory.filter((h) => h.hash === hash).length;

    if (count >= LOOP_HALT_THRESHOLD) {
      return {
        stuck: true,
        level: 'critical',
        count,
        message: `STOP: You have called ${name} with identical arguments ${count} times. You are stuck in a loop. Stop retrying and tell the user what went wrong.`,
      };
    }

    if (count >= LOOP_WARNING_THRESHOLD) {
      return {
        stuck: true,
        level: 'warning',
        count,
        message: `WARNING: You have called ${name} ${count} times with the same arguments. If this is not making progress, try a different approach or tell the user.`,
      };
    }

    return { stuck: false };
  }

  _resetLoopDetection() {
    this.toolCallHistory = [];
  }

  // =========================================================================
  // Context gathering
  // =========================================================================

  /**
   * Build context to attach to the user message.
   * Priority: Chrome CDP > Electron app CDP > native UI elements > window list
   * Screenshots are ONLY taken when Claude explicitly calls take_screenshot.
   */
  async _gatherContext() {
    // 1. Try Chrome browser context (CDP — instant structured data)
    try {
      if (this.browser && typeof this.browser.isConnected === 'function' && this.browser.isConnected()) {
        const pageCtx = await this.browser.getPageContext();
        if (pageCtx) {
          return {
            type: 'browser',
            text: `[Browser] URL: ${pageCtx.url}\nTitle: ${pageCtx.title}\nElements (${pageCtx.elements.length}): ${JSON.stringify(pageCtx.elements.slice(0, 80))}`,
          };
        }
      }
    } catch (err) {
      console.error('[agent] browser context error:', err.message);
    }

    // 2. Try Electron app CDP — detect focused app, try connectToApp
    try {
      if (this.browser && typeof this.browser.detectCurrentApp === 'function') {
        const detected = await this.browser.detectCurrentApp();
        if (detected.type === 'cdp' && detected.connection) {
          this._activeElectronApp = detected.appName;
          const appCtx = await this.browser.getAppPageContext(detected.appName);
          if (appCtx) {
            return {
              type: 'electron-cdp',
              text: `[Electron CDP: ${detected.appName}] URL: ${appCtx.url}\nTitle: ${appCtx.title}\nElements (${appCtx.elements.length}): ${JSON.stringify(appCtx.elements.slice(0, 80))}\n\nThis is an Electron app connected via CDP — browser_action tools work here.`,
            };
          }
        }
      }
    } catch (err) {
      console.error('[agent] electron CDP context error:', err.message);
    }

    // 3. Try native UI elements (UIAutomation — works for real native apps)
    try {
      if (this.computer && typeof this.computer.getUIElements === 'function') {
        const uiInfo = await this.computer.getUIElements();
        if (uiInfo && uiInfo.elements && uiInfo.elements.length > 2) {
          const rows = uiInfo.elements.map((e) =>
            `  [${e.type}] "${e.name}" at (${e.x}, ${e.y}) ${e.w}x${e.h}`
          );
          return {
            type: 'native',
            text: `[Native app] Window: ${uiInfo.window}\nElements (${uiInfo.elements.length}):\n${rows.join('\n')}`,
          };
        }
      }
    } catch (err) {
      console.error('[agent] native context error:', err.message);
    }

    // 4. Get window list as TEXT context (no screenshot — forces commands + shortcuts)
    try {
      if (this.computer && typeof this.computer.listWindows === 'function') {
        const windows = await this.computer.listWindows();
        if (windows && windows.length > 0) {
          const list = windows.map((w) => `  [${w.ProcessName}] ${w.MainWindowTitle}`).join('\n');
          return {
            type: 'windows',
            text: `[No browser/native context. Open windows:]\n${list}\n\nUse native_action run_command to open/focus apps. Use keyboard shortcuts to navigate within apps. Call take_screenshot ONLY if you truly need to see the screen.`,
          };
        }
      }
    } catch (err) {
      console.error('[agent] window list error:', err.message);
    }

    return {
      type: 'none',
      text: '[No context available. Use native_action run_command to open apps, keyboard shortcuts to navigate. Call take_screenshot only if needed.]',
    };
  }

  // =========================================================================
  // Main entry point
  // =========================================================================

  async chat(text) {
    this.onProgress({ type: 'status', text: 'Reading screen...' });

    this._currentActions = [];
    const ctx = await this._gatherContext();

    // Get memory tips for any detected app
    let memoryTips = '';
    const detectedApp = this._detectAppFromText(text);
    if (detectedApp) {
      memoryTips = this.memory.getTipsForApp(detectedApp);
    }

    const content = [{ type: 'text', text }];

    if (ctx.type === 'screenshot' && ctx.image) {
      content.push(ctx.image);
    } else if (ctx.text) {
      const contextWithMemory = memoryTips
        ? `${ctx.text}\n\n${memoryTips}`
        : ctx.text;
      content.push({ type: 'text', text: contextWithMemory });
    }

    const historyLenBefore = this.history.length;
    this.history.push({ role: 'user', content });
    this._trimHistory();
    this._resetLoopDetection();

    this.onProgress({ type: 'status', text: 'Thinking...' });

    try {
      return await this._runLoop();
    } catch (err) {
      this.history.length = historyLenBefore;
      console.error('[agent] chat error:', err);

      if (err.status === 400 && err.message && err.message.includes('tool_use')) {
        this.history = [];
        return { text: "Hit a glitch — cleared my memory. Try again?" };
      }

      return { text: "Something went wrong, but I'm still here. Try again?" };
    }
  }

  // =========================================================================
  // Tool loop
  // =========================================================================

  async _runLoop() {
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await this._callAPI();
      this.history.push({ role: 'assistant', content: response.content });

      const textParts = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text);

      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      if (toolUses.length === 0) {
        this._saveToMemory();
        return { text: textParts.join('\n') || 'Done.' };
      }

      if (textParts.length > 0 && textParts.join('').trim()) {
        this.onProgress({ type: 'text', text: textParts.join('\n') });
      }

      const toolResults = [];
      let halted = false;

      for (let i = 0; i < toolUses.length; i++) {
        const tu = toolUses[i];

        // Inter-action delay: apps need time to process previous actions
        if (i > 0 && (tu.name === 'native_action' || toolUses[i - 1].name === 'native_action')) {
          // Extra delay after focus_window — Windows needs time to fully activate the target
          const prevAction = toolUses[i - 1]?.input?.action;
          const delay = prevAction === 'focus_window' ? 350 : 200;
          await new Promise((r) => setTimeout(r, delay));
        }

        this.onProgress({ type: 'status', text: this._toolLabel(tu) });

        const loopCheck = this._detectLoop(tu.name, tu.input);

        if (loopCheck.stuck && loopCheck.level === 'critical') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: [{ type: 'text', text: loopCheck.message }],
            is_error: true,
          });
          halted = true;
          break;
        }

        this._recordToolCall(tu.name, tu.input);

        const result = await this._executeTool(tu.name, tu.input);
        this._currentActions.push({ tool: tu.name, input: tu.input });

        if (loopCheck.stuck && loopCheck.level === 'warning') {
          result.unshift({ type: 'text', text: loopCheck.message });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result,
        });
      }

      // Fill in skipped tools after a halt
      if (halted) {
        for (let i = toolResults.length; i < toolUses.length; i++) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUses[i].id,
            content: [{ type: 'text', text: 'Skipped — loop detected.' }],
            is_error: true,
          });
        }
      }

      this.history.push({ role: 'user', content: toolResults });
      this.onProgress({ type: 'status', text: 'Thinking...' });

      if (halted) {
        const finalResponse = await this._callAPI();
        this.history.push({ role: 'assistant', content: finalResponse.content });
        const finalText = finalResponse.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        return { text: finalText || "I got stuck in a loop. Let me know what to try differently." };
      }
    }

    return { text: "I've hit my action limit for this turn. Want me to keep going?" };
  }

  // =========================================================================
  // Tool execution
  // =========================================================================

  async _executeTool(name, input) {
    try {
      switch (name) {
        case 'browser_action':
          return await this._execBrowserAction(input);
        case 'native_action':
          return await this._execNativeAction(input);
        case 'take_screenshot':
          return await this._execScreenshot();
        case 'request_confirmation':
          return await this._execConfirmation(input);
        default:
          return [{ type: 'text', text: `Unknown tool: ${name}` }];
      }
    } catch (err) {
      return [{ type: 'text', text: `Error executing ${name}: ${err.message}` }];
    }
  }

  // --- browser_action ---

  async _execBrowserAction(input) {
    const { action } = input;

    if (!this.browser) {
      return [{ type: 'text', text: 'Browser module not available.' }];
    }

    // Auto-connect if needed — auto-launch Chrome with CDP if necessary
    if (typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
      if (typeof this.browser.autoConnectOrLaunchChrome === 'function') {
        this.onProgress({ type: 'status', text: 'Connecting to Chrome...' });
        const result = await this.browser.autoConnectOrLaunchChrome();
        if (!result.connected) {
          // Try Electron app CDP if Chrome isn't available
          if (this._activeElectronApp) {
            const appCtx = await this.browser.getAppPageContext(this._activeElectronApp);
            if (!appCtx) {
              return [{ type: 'text', text: `No browser connection. ${result.message}` }];
            }
            // Route to Electron app page
          } else {
            return [{ type: 'text', text: result.message }];
          }
        }
      }
    }

    switch (action) {
      case 'navigate': {
        if (!input.url) return [{ type: 'text', text: 'navigate requires a url.' }];
        const res = await this.browser.cdpNavigate(input.url);
        if (!res.ok) return [{ type: 'text', text: `Navigation failed: ${res.error}` }];
        if (typeof this.browser.cdpWaitForLoad === 'function') {
          await this.browser.cdpWaitForLoad(4000);
        }
        const ctx = await this.browser.getPageContext();
        if (ctx) {
          const elemSummary = ctx.elements.slice(0, 60).map((e) => {
            const parts = [e.tag];
            if (e.text) parts.push(`"${e.text}"`);
            if (e.id) parts.push(`#${e.id}`);
            if (e.role) parts.push(`role=${e.role}`);
            return parts.join(' ');
          }).join('\n');
          return [{ type: 'text', text: `Navigated to ${input.url}\nURL: ${ctx.url}\nTitle: ${ctx.title}\nElements:\n${elemSummary}` }];
        }
        return [{ type: 'text', text: `Navigated to ${input.url}` }];
      }

      case 'read_page': {
        const ctx = await this.browser.getPageContext();
        if (!ctx) return [{ type: 'text', text: 'Could not read page — no active page found.' }];
        const elemSummary = ctx.elements.slice(0, 100).map((e) => {
          const parts = [e.tag];
          if (e.text) parts.push(`"${e.text}"`);
          if (e.id) parts.push(`#${e.id}`);
          if (e.role) parts.push(`role=${e.role}`);
          if (e.type) parts.push(`type=${e.type}`);
          if (e.href) parts.push(`href=${e.href}`);
          return parts.join(' ');
        }).join('\n');
        return [{ type: 'text', text: `URL: ${ctx.url}\nTitle: ${ctx.title}\nElements (${ctx.elements.length}):\n${elemSummary}` }];
      }

      case 'click_selector': {
        if (!input.selector) return [{ type: 'text', text: 'click_selector requires a selector.' }];
        const res = await this.browser.cdpClick(input.selector);
        if (!res.ok) return [{ type: 'text', text: `Click failed: ${res.error}` }];
        return [{ type: 'text', text: `Clicked ${input.selector}` }];
      }

      case 'click_text': {
        if (!input.text) return [{ type: 'text', text: 'click_text requires text.' }];
        const res = await this.browser.cdpClickText(input.text);
        if (!res.ok) return [{ type: 'text', text: `Click text failed: ${res.error}` }];
        return [{ type: 'text', text: `Clicked element with text "${input.text}"` }];
      }

      case 'type': {
        if (!input.selector) return [{ type: 'text', text: 'type requires a selector.' }];
        if (input.value === undefined && input.text === undefined) {
          return [{ type: 'text', text: 'type requires a value or text.' }];
        }
        const val = input.value !== undefined ? input.value : input.text;
        const res = await this.browser.cdpType(input.selector, val);
        if (!res.ok) return [{ type: 'text', text: `Type failed: ${res.error}` }];
        return [{ type: 'text', text: `Typed into ${input.selector}` }];
      }

      case 'scroll': {
        const dir = input.direction || 'down';
        const res = await this.browser.cdpScroll(dir);
        if (!res.ok) return [{ type: 'text', text: `Scroll failed: ${res.error}` }];
        return [{ type: 'text', text: `Scrolled ${dir}` }];
      }

      case 'press_key': {
        if (!input.key) return [{ type: 'text', text: 'press_key requires a key.' }];
        const res = await this.browser.cdpPressKey(input.key);
        if (!res.ok) return [{ type: 'text', text: `Key press failed: ${res.error}` }];
        return [{ type: 'text', text: `Pressed ${input.key}` }];
      }

      default:
        return [{ type: 'text', text: `Unknown browser_action: ${action}` }];
    }
  }

  // --- native_action ---

  async _execNativeAction(input) {
    const { action } = input;

    if (!this.computer) {
      return [{ type: 'text', text: 'Computer module not available.' }];
    }

    switch (action) {
      case 'read_screen': {
        const uiInfo = await this.computer.getUIElements();
        if (!uiInfo || !uiInfo.elements || uiInfo.elements.length === 0) {
          return [{ type: 'text', text: `Window: ${uiInfo ? uiInfo.window : 'unknown'}\nNo interactive elements found (source: ${uiInfo?.source || 'unknown'}).\nThis app may use custom rendering. Try take_screenshot for grid-based targeting, or use keyboard shortcuts.` }];
        }
        const source = uiInfo.source === 'uia' ? 'UIAutomation' : 'Win32 EnumChildWindows';
        const rows = uiInfo.elements.map((e) =>
          `  [${e.type}] "${e.name}" at (${e.x}, ${e.y}) ${e.w}x${e.h}${e.enabled === false ? ' [DISABLED]' : ''}`
        );
        return [{ type: 'text', text: `Window: ${uiInfo.window} (via ${source})\nInteractive elements (${uiInfo.elements.length}):\n${rows.join('\n')}\n\nUse target="element name" in click action to click by name (pixel-perfect). The (x,y) coordinates are element centers.` }];
      }

      case 'click': {
        // Capture pre-click state for verification
        const preClickTitle = this.computer.getForegroundWindowTitle();

        // Priority 1: Grid cell label (from screenshot overlay)
        if (input.cell && this._lastGridMap) {
          const resolved = resolveCell(this._lastGridMap, input.cell);
          if (resolved) {
            await this.computer.leftClick(resolved.x, resolved.y);
            await new Promise((r) => setTimeout(r, 100));
            const postTitle = this.computer.getForegroundWindowTitle();
            const changed = postTitle !== preClickTitle ? ` Window changed to: "${postTitle}"` : ` Window: "${postTitle}" (unchanged)`;
            return [{ type: 'text', text: `Clicked grid cell ${input.cell} at (${resolved.x}, ${resolved.y}).${changed}` }];
          }
          return [{ type: 'text', text: `Grid cell "${input.cell}" not found. Valid cells: A1-L8. Take a new screenshot to get fresh grid.` }];
        }

        // Priority 2: Target name (UIAutomation element lookup) — before raw coords
        if (input.target) {
          const uiInfo = await this.computer.getUIElements();
          const targetLower = input.target.toLowerCase();
          // Try exact match first, then substring match
          let match = (uiInfo.elements || []).find((e) =>
            e.name && e.name.toLowerCase() === targetLower
          );
          if (!match) {
            match = (uiInfo.elements || []).find((e) =>
              e.name && e.name.toLowerCase().includes(targetLower)
            );
          }
          if (match) {
            await this.computer.leftClick(match.x, match.y);
            await new Promise((r) => setTimeout(r, 100));
            const postTitle = this.computer.getForegroundWindowTitle();
            const changed = postTitle !== preClickTitle ? ` Window changed to: "${postTitle}"` : '';
            return [{ type: 'text', text: `Clicked "${match.name}" [${match.type}] at (${match.x}, ${match.y}).${changed}` }];
          }
          const hint = this._lastGridMap
            ? ' Take a screenshot and use grid cell labels for precise clicking.'
            : ' Try take_screenshot to see the screen and use grid cell labels.';
          return [{ type: 'text', text: `Could not find element matching "${input.target}".${hint} Available elements: ${(uiInfo.elements || []).slice(0, 10).map(e => `"${e.name}" (${e.type})`).join(', ') || 'none detected'}` }];
        }

        // Priority 3: Raw coordinates (last resort)
        if (input.x !== undefined && input.y !== undefined) {
          await this.computer.leftClick(input.x, input.y);
          await new Promise((r) => setTimeout(r, 100));
          const postTitle = this.computer.getForegroundWindowTitle();
          const changed = postTitle !== preClickTitle ? ` Window changed to: "${postTitle}"` : ` Window: "${postTitle}" (unchanged)`;
          return [{ type: 'text', text: `Clicked at (${input.x}, ${input.y}).${changed} NOTE: Raw coordinates are unreliable. Prefer target="name" or cell="F4" from grid.` }];
        }

        return [{ type: 'text', text: 'click requires cell (grid label), target (element name), or x/y coordinates.' }];
      }

      case 'type': {
        const val = input.value || input.target || '';
        if (!val) return [{ type: 'text', text: 'type requires a value.' }];
        const preTypeTitle = this.computer.getForegroundWindowTitle();
        await this.computer.type(val);
        const postTypeTitle = this.computer.getForegroundWindowTitle();
        const focusOk = preTypeTitle === postTypeTitle && postTypeTitle !== '';
        return [{ type: 'text', text: `Typed "${val.slice(0, 50)}${val.length > 50 ? '...' : ''}" — active window: "${postTypeTitle}"${focusOk ? '' : ' WARNING: Window focus may have changed during typing. Text might have gone to wrong window. Take a screenshot to verify.'}` }];
      }

      case 'key': {
        const keys = input.value || input.target || '';
        if (!keys) return [{ type: 'text', text: 'key requires a value (e.g. "ctrl+c", "enter").' }];
        const preKeyTitle = this.computer.getForegroundWindowTitle();
        await this.computer.key(keys);
        const postKeyTitle = this.computer.getForegroundWindowTitle();
        return [{ type: 'text', text: `Pressed ${keys} — active window: "${postKeyTitle}"${postKeyTitle !== preKeyTitle ? ' (window changed)' : ''}` }];
      }

      case 'scroll': {
        const x = input.x || 960;
        const y = input.y || 540;
        const dir = input.value || 'down';
        await this.computer.scroll(x, y, dir, 3);
        return [{ type: 'text', text: `Scrolled ${dir} at (${x}, ${y})` }];
      }

      case 'run_command': {
        const cmd = input.command || input.value || '';
        if (!cmd) return [{ type: 'text', text: 'run_command requires a command.' }];
        const result = await this.computer.runCommand(cmd);
        const parts = [];
        if (result.stdout) parts.push(`stdout: ${result.stdout}`);
        if (result.stderr) parts.push(`stderr: ${result.stderr}`);
        if (result.error) parts.push(`error: ${result.error}`);
        return [{ type: 'text', text: parts.join('\n') || (result.ok ? 'Command executed.' : 'Command failed.') }];
      }

      case 'focus_window': {
        const pattern = input.target || input.value || '';
        if (!pattern) return [{ type: 'text', text: 'focus_window requires a target window title pattern.' }];
        // Blur overlay first so it doesn't hold foreground
        this.blurOverlayFn();
        await new Promise((r) => setTimeout(r, 100));
        const result = await this.computer.focusWindow(pattern);
        if (result.ok) {
          // Extra wait for window to fully activate
          await new Promise((r) => setTimeout(r, 100));

          // Try CDP connection to the focused app
          let cdpNote = '';
          if (this.browser && typeof this.browser.detectCurrentApp === 'function') {
            try {
              const detected = await this.browser.detectCurrentApp();
              if (detected.type === 'cdp' && detected.connection) {
                this._activeElectronApp = detected.appName;
                cdpNote = ` [CDP connected to ${detected.appName} — use browser_action for DOM access]`;
              }
            } catch { /* CDP connection optional */ }
          }

          return [{ type: 'text', text: `Focused: ${result.title} (${result.process})${cdpNote}` }];
        }
        return [{ type: 'text', text: result.error }];
      }

      default:
        return [{ type: 'text', text: `Unknown native_action: ${action}` }];
    }
  }

  // --- take_screenshot ---

  async _execScreenshot() {
    const ss = await this.screenshotFn();
    if (ss && ss.ok) {
      try {
        // Overlay grid and store the map
        const gridResult = overlayGrid(Buffer.from(ss.data, 'base64'));
        this._lastGridMap = gridResult.gridMap;

        return [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: gridResult.mediaType,
              data: gridResult.annotatedBase64,
            },
          },
          {
            type: 'text',
            text: 'Screenshot with grid overlay. Grid cells: columns A-L (left to right), rows 1-8 (top to bottom). Use cell="F4" in native_action click to click the center of cell F4. For sub-cell precision, append -TL, -TR, -BL, -BR (e.g. cell="F4-TL" for top-left quarter).',
          },
        ];
      } catch (gridErr) {
        console.error('[agent] Grid overlay error, returning raw screenshot:', gridErr.message);
        // Fallback to raw screenshot without grid
        this._lastGridMap = null;
        return [
          { type: 'image', source: { type: 'base64', media_type: ss.mediaType || 'image/png', data: ss.data } },
          { type: 'text', text: 'Screenshot (grid overlay failed — use read_screen for element positions instead).' },
        ];
      }
    }
    return [{ type: 'text', text: 'Screenshot failed: ' + (ss ? ss.error : 'unknown') }];
  }

  // --- request_confirmation ---

  async _execConfirmation(input) {
    this.onProgress({ type: 'status', text: 'Waiting for your confirmation...' });
    const result = await this.onConfirmationRequest({
      summary: input.summary,
      details: input.details,
      risks: input.risks || [],
    });

    if (result && result.confirmed) {
      return [{ type: 'text', text: 'User confirmed. Proceed.' }];
    }

    const reason = (result && result.reason) ? ` Reason: ${result.reason}` : '';
    return [{ type: 'text', text: `User declined.${reason} Do NOT proceed with this action.` }];
  }

  // =========================================================================
  // API call
  // =========================================================================

  _callAPI() {
    this._validateHistory();

    return this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools,
      messages: this.history,
    });
  }

  _validateHistory() {
    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role === 'user' && Array.isArray(msg.content) &&
        msg.content.some((c) => c.type === 'tool_result')) {
        if (i === 0 || this.history[i - 1].role !== 'assistant') {
          console.error('[agent] Corrupted history detected — orphaned tool_result at index', i, '. Clearing history.');
          this.history = [];
          return;
        }
        const prevContent = this.history[i - 1].content || [];
        const toolUseIds = new Set(prevContent.filter((b) => b.type === 'tool_use').map((b) => b.id));
        const hasOrphan = msg.content.some((c) => c.type === 'tool_result' && !toolUseIds.has(c.tool_use_id));
        if (hasOrphan) {
          console.error('[agent] Corrupted history — mismatched tool_use_id at index', i, '. Clearing history.');
          this.history = [];
          return;
        }
      }
    }
  }

  // =========================================================================
  // History management
  // =========================================================================

  _trimHistory() {
    if (this.history.length <= MAX_HISTORY) return;

    const earliest = this.history.length - MAX_HISTORY;
    for (let i = earliest; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role === 'user' && Array.isArray(msg.content) &&
        !msg.content.some((c) => c.type === 'tool_result')) {
        this.history = this.history.slice(i);
        return;
      }
    }
    this.history = this.history.slice(-4);
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  _toolLabel(tu) {
    switch (tu.name) {
      case 'browser_action': {
        const a = tu.input.action || '?';
        if (a === 'navigate') return `Navigating to ${(tu.input.url || '').slice(0, 40)}...`;
        if (a === 'read_page') return 'Reading page...';
        if (a === 'click_selector') return `Clicking ${(tu.input.selector || '').slice(0, 30)}...`;
        if (a === 'click_text') return `Clicking "${(tu.input.text || '').slice(0, 30)}"...`;
        if (a === 'type') return `Typing into ${(tu.input.selector || '').slice(0, 30)}...`;
        if (a === 'scroll') return `Scrolling ${tu.input.direction || 'down'}...`;
        if (a === 'press_key') return `Pressing ${tu.input.key || '?'}...`;
        return `Browser: ${a}...`;
      }
      case 'native_action': {
        const a = tu.input.action || '?';
        if (a === 'read_screen') return 'Reading screen elements...';
        if (a === 'click') return `Clicking ${tu.input.target || `(${tu.input.x}, ${tu.input.y})`}...`;
        if (a === 'type') return `Typing "${(tu.input.value || '').slice(0, 30)}"...`;
        if (a === 'key') return `Pressing ${tu.input.value || '?'}...`;
        if (a === 'scroll') return `Scrolling ${tu.input.value || 'down'}...`;
        if (a === 'run_command') return `Running: ${(tu.input.command || '').slice(0, 40)}...`;
        if (a === 'focus_window') return `Focusing ${tu.input.target || tu.input.value || '?'}...`;
        return `Native: ${a}...`;
      }
      case 'take_screenshot':
        return 'Taking screenshot...';
      case 'request_confirmation':
        return 'Asking for confirmation...';
      default:
        return `${tu.name}...`;
    }
  }

  clearHistory() {
    this.history = [];
    this.toolCallHistory = [];
  }

  _detectAppFromText(text) {
    const lower = text.toLowerCase();
    const apps = ['discord', 'spotify', 'chrome', 'edge', 'notepad', 'excel', 'word',
      'gmail', 'whatsapp', 'slack', 'teams', 'vscode', 'cursor', 'figma', 'notion', 'obsidian'];
    return apps.find((app) => lower.includes(app)) || null;
  }

  _saveToMemory() {
    if (this._currentActions.length === 0) return;
    const firstUserMsg = this.history.find((m) => m.role === 'user');
    if (!firstUserMsg) return;
    const userText = firstUserMsg.content?.find?.((c) => c.type === 'text')?.text || '';
    if (!userText) return;
    const app = this._detectAppFromText(userText);
    try {
      this.memory.recordSuccess(userText, app, this._currentActions.slice(0, 10));
    } catch (err) {
      console.error('[agent] memory save error:', err.message);
    }
  }
}

module.exports = Agent;
