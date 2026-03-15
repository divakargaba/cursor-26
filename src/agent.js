// src/agent.js — Computer-use agent with Claude's native computer-use API
// Hybrid: native computer-use tool + browser CDP + confirmation
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const Memory = require('./memory');
const { buildOCRMap, getWorker } = require('./ocr-map');

// Models — dynamic switching (Haiku fast default, Sonnet accurate on retry)
const MODEL_FAST = process.env.AI_MODEL_DEFAULT || 'claude-haiku-4-5-20251001';
const MODEL_ACCURATE = 'claude-sonnet-4-6-20250514';

const MAX_TOKENS = 4096;
const MAX_ITERATIONS = 12;
const MAX_HISTORY = 20;

// Loop detection thresholds
const LOOP_HISTORY_SIZE = 15;
const LOOP_WARNING_THRESHOLD = 4;
const LOOP_HALT_THRESHOLD = 7;

// Claude computer-use key names → our VK format
const KEY_NORMALIZE = {
  'Return': 'enter', 'BackSpace': 'backspace', 'Tab': 'tab',
  'Escape': 'escape', 'space': 'space', 'Delete': 'delete',
  'Home': 'home', 'End': 'end', 'Page_Up': 'pageup', 'Page_Down': 'pagedown',
  'Up': 'up', 'Down': 'down', 'Left': 'left', 'Right': 'right',
  'Super_L': 'win', 'Super_R': 'win', 'Super': 'win',
  'Control_L': 'ctrl', 'Control_R': 'ctrl', 'Control': 'ctrl',
  'Alt_L': 'alt', 'Alt_R': 'alt',
  'Shift_L': 'shift', 'Shift_R': 'shift',
  'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4', 'F5': 'f5', 'F6': 'f6',
  'F7': 'f7', 'F8': 'f8', 'F9': 'f9', 'F10': 'f10', 'F11': 'f11', 'F12': 'f12',
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You control a Windows PC via screenshots and mouse/keyboard. Short voice replies (1-2 sentences).

TOOLS:
1. computer — screenshot, click, type, key, scroll. Your PRIMARY tool for all desktop interactions.
2. focus_window — focus a window by title (Win32 API). Use INSTEAD of clicking the taskbar.
3. browser_action — CDP for web pages (faster than clicking for websites). Auto-connects to Chrome.
4. request_confirmation — ALWAYS before send/delete/purchase/submit.

RULES:
1. Take a screenshot first if you need to see the screen.
2. Screenshots include OCR text labels with coordinates (e.g. "Discord"@(450,560) 95%). Cross-reference these with what you see to verify click targets — especially for similar-looking icons.
3. Click targets by coordinates from screenshots — you're trained for pixel-accurate clicking. Use OCR coordinates when visual identification is ambiguous.
4. Use browser_action for web interactions when CDP is connected (faster than screenshot→click cycle).
5. request_confirmation before any destructive or externally-visible action.
6. If stuck after 3 tries, tell the user. Don't loop.
7. Complete tasks efficiently — minimum screenshots, maximum action per turn.

RECIPES:
- "type X in Notepad" → screenshot → find Notepad → click it → type text
- "open Discord" → key("super") → type("Discord") → key("Return")
- "click the X button" → screenshot → left_click at the button's coordinates
- "open URL" → browser_action navigate (faster than screenshot clicking)
- "switch to Discord" → focus_window("Discord") (NOT taskbar clicking)
- "message USER on Discord" → focus_window("Discord") → key("ctrl+k") → type("USER") → key("Return") → type("message") → key("Return")

Keep voice replies short. No narration — just actions.`;

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

class Agent {
  /**
   * @param {Object} opts
   * @param {Object} opts.browser        - browser.js module (CDP control)
   * @param {Object} opts.computer       - computer.js module (native control)
   * @param {Function} opts.screenshotFn  - async () => { ok, data, mediaType }  (downscaled)
   * @param {Function} opts.blurOverlayFn - () => void
   * @param {Function} opts.onProgress    - ({ type, text }) => void
   * @param {Function} opts.onConfirmationRequest - async (preview) => { confirmed, reason? }
   * @param {Object} opts.displayConfig   - { physicalWidth, physicalHeight, displayWidth, displayHeight, scaleX, scaleY }
   */
  constructor({ browser, computer, screenshotFn, blurOverlayFn, onProgress, onConfirmationRequest, displayConfig }) {
    this.client = new Anthropic();
    this.browser = browser;
    this.computer = computer;
    this.screenshotFn = screenshotFn;
    this.blurOverlayFn = blurOverlayFn || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onConfirmationRequest = onConfirmationRequest || (async () => ({ confirmed: false, reason: 'No confirmation handler' }));

    // Display config for coordinate scaling
    this.displayConfig = displayConfig || {
      physicalWidth: 1920, physicalHeight: 1080,
      displayWidth: 1024, displayHeight: 576,
      scaleX: 1.875, scaleY: 1.875,
    };

    this.history = [];
    this.toolCallHistory = [];
    this.memory = new Memory();
    this._currentActions = [];
    this._lastToolType = null;
    this._lastOCRMap = null;

    // Preload tesseract WASM worker (non-blocking)
    getWorker().catch(() => {});

    // Model switching state
    this._currentModel = MODEL_FAST;
    this._retryCount = 0;
    this._lastScreenshotHash = null;

    console.log(`[computer-use] Display: ${this.displayConfig.displayWidth}x${this.displayConfig.displayHeight} (scaled from ${this.displayConfig.physicalWidth}x${this.displayConfig.physicalHeight}, factor ${this.displayConfig.scaleX.toFixed(1)}x)`);
  }

  // =========================================================================
  // Tool definitions — hybrid: native computer-use + custom tools
  // =========================================================================

  _getTools() {
    return [
      // Claude's native computer-use tool (trained for pixel-accurate interaction)
      {
        type: 'computer_20250124',
        name: 'computer',
        display_width_px: this.displayConfig.displayWidth,
        display_height_px: this.displayConfig.displayHeight,
      },
      // CDP browser control (faster than screenshot-based clicking for web)
      {
        name: 'browser_action',
        description: 'Control browser via CDP. Use for web page interactions — faster than screenshot clicking. Auto-connects to Chrome.',
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
      // Focus a window by title (uses Win32 API — faster/more reliable than taskbar clicking)
      {
        name: 'focus_window',
        description: 'Focus a desktop window by title pattern (regex). Use instead of clicking the taskbar. E.g. "Discord", "Chrome", "Notepad".',
        input_schema: {
          type: 'object',
          properties: {
            title_pattern: { type: 'string', description: 'Regex pattern to match window title (case-insensitive)' },
          },
          required: ['title_pattern'],
        },
      },
      // Safety confirmation
      {
        name: 'request_confirmation',
        description: 'ALWAYS call before send/submit/delete/post. Shows preview, waits for user.',
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
    this.toolCallHistory.push({ hash: this._hashToolCall(name, input), name, ts: Date.now() });
    if (this.toolCallHistory.length > LOOP_HISTORY_SIZE) this.toolCallHistory.shift();
  }

  _detectLoop(name, input) {
    const hash = this._hashToolCall(name, input);
    const count = this.toolCallHistory.filter((h) => h.hash === hash).length;

    if (count >= LOOP_HALT_THRESHOLD) {
      return {
        stuck: true, level: 'critical', count,
        message: `STOP: You have called ${name} with identical arguments ${count} times. You are stuck in a loop. Stop retrying and tell the user what went wrong.`,
      };
    }
    if (count >= LOOP_WARNING_THRESHOLD) {
      return {
        stuck: true, level: 'warning', count,
        message: `WARNING: You have called ${name} ${count} times with the same arguments. Try a different approach or tell the user.`,
      };
    }
    return { stuck: false };
  }

  _resetLoopDetection() { this.toolCallHistory = []; }

  // =========================================================================
  // Context gathering (simplified — Claude uses screenshots for visual context)
  // =========================================================================

  async _gatherContext() {
    // Provide quick text context: browser status + window list
    try {
      if (this.browser && typeof this.browser.isConnected === 'function' && this.browser.isConnected()) {
        const pageCtx = await this.browser.getPageContext();
        if (pageCtx) {
          const elems = pageCtx.elements.slice(0, 15).map(e =>
            `${e.tag}${e.id ? '#' + e.id : ''} "${(e.text || '').slice(0, 30)}"`
          ).join('\n');
          return `[Browser connected] ${pageCtx.url} "${pageCtx.title}"\n${elems}\n\nUse browser_action for web interactions (faster than screenshots).`;
        }
      }
    } catch (err) {
      console.error('[agent] browser context error:', err.message);
    }

    try {
      if (this.computer && typeof this.computer.listWindows === 'function') {
        const windows = await this.computer.listWindows();
        if (windows && windows.length > 0) {
          const list = windows.slice(0, 10).map(w => `  ${w.ProcessName}: ${w.MainWindowTitle}`).join('\n');
          return `[Open windows]\n${list}\n\nUse computer tool to interact with the desktop. Take a screenshot to see the screen.`;
        }
      }
    } catch (err) {
      console.error('[agent] window list error:', err.message);
    }

    return '[Desktop ready. Use computer tool to take a screenshot and interact.]';
  }

  // =========================================================================
  // Main entry point
  // =========================================================================

  async chat(text) {
    const _chatStart = Date.now();
    console.time('[agent] chat total');
    this.onProgress({ type: 'status', text: 'Reading context...' });

    this._currentActions = [];

    // Check for precision hints → upgrade model
    if (/look carefully|be precise|be accurate|look closer|try harder/i.test(text)) {
      this._currentModel = MODEL_ACCURATE;
      console.log('[agent] User requested precision — using accurate model');
    }

    const ctx = await this._gatherContext();

    // Get memory tips
    let memoryTips = '';
    const detectedApp = this._detectAppFromText(text);
    if (detectedApp) {
      memoryTips = this.memory.getTipsForApp(detectedApp);
    }

    const contextText = memoryTips ? `${ctx}\n\n${memoryTips}` : ctx;
    const content = [
      { type: 'text', text },
      { type: 'text', text: contextText },
    ];

    const historyLenBefore = this.history.length;
    this.history.push({ role: 'user', content });
    this._trimHistory();
    this._resetLoopDetection();
    this._retryCount = 0;

    this.onProgress({ type: 'status', text: 'Thinking...' });

    try {
      const result = await this._runLoop();
      console.timeEnd('[agent] chat total');
      return result;
    } catch (err) {
      console.timeEnd('[agent] chat total');
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

    while (true) {
      iterations++;
      console.log(`[agent] --- Iteration ${iterations} (model: ${this._currentModel}) ---`);
      console.time(`[agent] iteration-${iterations}`);

      console.time(`[agent] API call #${iterations}`);
      const response = await this._callAPI();
      console.timeEnd(`[agent] API call #${iterations}`);
      this.history.push({ role: 'assistant', content: response.content });

      const textParts = response.content.filter((b) => b.type === 'text').map((b) => b.text);
      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      // No tool calls → done
      if (toolUses.length === 0) {
        this._saveToMemory();
        return { text: textParts.join('\n') || 'Done.' };
      }

      // Forward non-narration text to user
      if (textParts.length > 0) {
        const combined = textParts.join('\n').trim();
        if (combined && !combined.match(/^(let me|i('ll| will)|now i|ok(ay)?[,.]?\s*(let|i)|trying to|sure[,!]?\s*(let|i))/i)) {
          this.onProgress({ type: 'text', text: combined });
        }
      }

      // Execute all tool calls
      const toolResults = [];
      let halted = false;

      for (let i = 0; i < toolUses.length; i++) {
        const tu = toolUses[i];

        // Inter-action delay
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 50));
        }

        this.onProgress({ type: 'status', text: this._toolLabel(tu) });

        // Loop detection
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

        const toolTimer = `[agent] tool:${tu.name}:${tu.input?.action || ''}`;
        console.time(toolTimer);
        const result = await this._executeTool(tu.name, tu.input);
        console.timeEnd(toolTimer);
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
      console.timeEnd(`[agent] iteration-${iterations}`);
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
      if (name === 'computer') {
        return await this._execComputerAction(input);
      }

      // Auto-blur when switching from browser to computer actions
      if (name !== 'browser_action' && this._lastToolType === 'browser_action') {
        this.blurOverlayFn();
        await new Promise((r) => setTimeout(r, 200));
      }
      this._lastToolType = name;

      switch (name) {
        case 'browser_action':
          return await this._execBrowserAction(input);
        case 'focus_window':
          return await this._execFocusWindow(input);
        case 'request_confirmation':
          return await this._execConfirmation(input);
        default:
          return [{ type: 'text', text: `Unknown tool: ${name}` }];
      }
    } catch (err) {
      return [{ type: 'text', text: `Error executing ${name}: ${err.message}` }];
    }
  }

  // =========================================================================
  // Computer tool (Claude's native computer-use)
  // =========================================================================

  async _execComputerAction(input) {
    const { action, coordinate, text, start_coordinate, delta_x, delta_y } = input;

    switch (action) {
      case 'screenshot': {
        return await this._captureScreenshot();
      }

      case 'left_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
        console.log(`[click] API(${coordinate[0]}, ${coordinate[1]}) → Physical(${px}, ${py})`);
        this.blurOverlayFn();
        await this.computer.leftClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'right_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
        console.log(`[right_click] API(${coordinate[0]}, ${coordinate[1]}) → Physical(${px}, ${py})`);
        this.blurOverlayFn();
        await this.computer.rightClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'double_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
        console.log(`[double_click] API(${coordinate[0]}, ${coordinate[1]}) → Physical(${px}, ${py})`);
        this.blurOverlayFn();
        await this.computer.doubleClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'middle_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
        console.log(`[middle_click] API(${coordinate[0]}, ${coordinate[1]}) → Physical(${px}, ${py})`);
        this.blurOverlayFn();
        await this.computer.middleClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'type': {
        console.log(`[type] "${(text || '').slice(0, 50)}${(text || '').length > 50 ? '...' : ''}"`);
        await this.computer.type(text);
        await new Promise((r) => setTimeout(r, 50));
        return await this._captureScreenshot(false);
      }

      case 'key': {
        const normalized = this._normalizeKey(text);
        console.log(`[key] "${text}" → "${normalized}"`);
        await this.computer.key(normalized);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'scroll': {
        const [px, py] = coordinate ? this._scaleToPhysical(coordinate) : [
          Math.round(this.displayConfig.physicalWidth / 2),
          Math.round(this.displayConfig.physicalHeight / 2),
        ];
        const dir = (delta_y || 0) < 0 ? 'up' : 'down';
        const amount = Math.max(1, Math.abs(delta_y || 3));
        console.log(`[scroll] ${dir} ${amount} at Physical(${px}, ${py})`);
        await this.computer.scroll(px, py, dir, amount);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'mouse_move': {
        const [px, py] = this._scaleToPhysical(coordinate);
        console.log(`[mouse_move] API(${coordinate[0]}, ${coordinate[1]}) → Physical(${px}, ${py})`);
        await this.computer.mouseMove(px, py);
        // No auto-screenshot for mouse_move
        return [{ type: 'text', text: `Moved mouse to (${coordinate[0]}, ${coordinate[1]})` }];
      }

      case 'left_click_drag': {
        const [sx, sy] = this._scaleToPhysical(start_coordinate);
        const [ex, ey] = this._scaleToPhysical(coordinate);
        console.log(`[drag] Physical(${sx}, ${sy}) → Physical(${ex}, ${ey})`);
        this.blurOverlayFn();
        await this.computer.leftClickDrag(sx, sy, ex, ey);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      default:
        return [{ type: 'text', text: `Unknown computer action: ${action}` }];
    }
  }

  // =========================================================================
  // Screenshot capture (downscaled by screenshotFn)
  // =========================================================================

  async _captureScreenshot(withOCR = true) {
    const ss = await this.screenshotFn();
    if (!ss || !ss.ok) {
      return [{ type: 'text', text: `Screenshot failed: ${ss?.error || 'unknown'}` }];
    }

    // Track screenshot hash for model upgrading on stale screens
    const hash = crypto.createHash('md5').update(ss.data.slice(0, 5000)).digest('hex');
    if (this._lastScreenshotHash === hash) {
      this._retryCount++;
      if (this._retryCount >= 3 && this._currentModel !== MODEL_ACCURATE) {
        console.log('[agent] Screen unchanged after actions — upgrading to accurate model');
        this._currentModel = MODEL_ACCURATE;
      }
    } else {
      this._retryCount = 0;
    }
    this._lastScreenshotHash = hash;

    const imageBlock = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: ss.mediaType || 'image/jpeg',
        data: ss.data,
      },
    };

    // Run OCR on the same downscaled image Claude sees (coords already in display space)
    // Skip OCR on action auto-screenshots (withOCR=false) to avoid 200-500ms+ per action
    if (withOCR) {
      try {
        const buffer = Buffer.from(ss.data, 'base64');
        const ocrMap = await buildOCRMap(buffer);
        this._lastOCRMap = ocrMap;

        const entries = Object.values(ocrMap)
          .filter((e) => e.confidence > 60)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 30);

        if (entries.length > 0) {
          const labels = entries.map((e) =>
            `"${e.raw}"@(${e.centerX},${e.centerY}) ${Math.round(e.confidence)}%`
          ).join(', ');
          return [imageBlock, { type: 'text', text: `[OCR: ${labels}]` }];
        }
      } catch (err) {
        console.error('[agent] OCR failed (non-fatal):', err.message);
      }
    }

    return [imageBlock];
  }

  // =========================================================================
  // Coordinate scaling
  // =========================================================================

  /** Convert API coordinates (display space) → physical screen coordinates */
  _scaleToPhysical(coordinate) {
    if (!coordinate || coordinate.length < 2) return [0, 0];
    const px = Math.round(coordinate[0] * this.displayConfig.scaleX);
    const py = Math.round(coordinate[1] * this.displayConfig.scaleY);
    return [px, py];
  }

  /** Normalize Claude computer-use key names to our VK format */
  _normalizeKey(keyText) {
    if (!keyText) return '';
    return keyText.split('+').map((part) => {
      const trimmed = part.trim();
      return KEY_NORMALIZE[trimmed] || trimmed.toLowerCase();
    }).join('+');
  }

  // =========================================================================
  // focus_window (Win32 API — faster than taskbar clicking)
  // =========================================================================

  async _execFocusWindow(input) {
    if (!this.computer || typeof this.computer.focusWindow !== 'function') {
      return [{ type: 'text', text: 'Focus window not available (no computer module).' }];
    }
    const result = await this.computer.focusWindow(input.title_pattern);
    if (!result.ok) {
      return [{ type: 'text', text: `Could not focus window: ${result.error}` }];
    }
    await new Promise((r) => setTimeout(r, 300));
    const screenshot = await this._captureScreenshot(false);
    screenshot.unshift({ type: 'text', text: `Focused: ${result.process} — "${result.title}"` });
    return screenshot;
  }

  // =========================================================================
  // browser_action (CDP — kept for speed on web pages)
  // =========================================================================

  async _execBrowserAction(input) {
    const { action } = input;

    if (!this.browser) {
      return [{ type: 'text', text: 'Browser module not available.' }];
    }

    // Auto-connect if needed
    if (typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
      if (typeof this.browser.autoConnectOrLaunchChrome === 'function') {
        this.onProgress({ type: 'status', text: 'Connecting to Chrome...' });
        const result = await this.browser.autoConnectOrLaunchChrome();
        if (!result.connected) {
          return [{ type: 'text', text: result.message }];
        }
      }
    }

    // Always bring browser to front so the user can see what's happening
    if (typeof this.browser.bringBrowserToFront === 'function') {
      await this.browser.bringBrowserToFront();
    }

    switch (action) {
      case 'navigate': {
        if (!input.url) return [{ type: 'text', text: 'navigate requires a url.' }];
        const res = await this.browser.cdpNavigate(input.url);
        if (!res.ok) return [{ type: 'text', text: `Navigation failed: ${res.error}` }];
        if (typeof this.browser.cdpWaitForLoad === 'function') {
          await this.browser.cdpWaitForLoad(1500);
        }
        const ctx = await this.browser.getPageContext();
        if (ctx) {
          const elemSummary = ctx.elements.slice(0, 20).map((e) =>
            `${e.tag}${e.id ? '#' + e.id : ''} "${(e.text || '').slice(0, 30)}"`
          ).join('\n');
          return [{ type: 'text', text: `Navigated to ${input.url}\n"${ctx.title}"\n${elemSummary}` }];
        }
        return [{ type: 'text', text: `Navigated to ${input.url}` }];
      }

      case 'read_page': {
        const ctx = await this.browser.getPageContext();
        if (!ctx) return [{ type: 'text', text: 'Could not read page.' }];
        const elemSummary = ctx.elements.slice(0, 30).map((e) => {
          const parts = [e.tag];
          if (e.text) parts.push(`"${(e.text || '').slice(0, 40)}"`);
          if (e.id) parts.push(`#${e.id}`);
          if (e.type) parts.push(`type=${e.type}`);
          return parts.join(' ');
        }).join('\n');
        return [{ type: 'text', text: `${ctx.url} "${ctx.title}"\n${elemSummary}` }];
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

  // =========================================================================
  // request_confirmation
  // =========================================================================

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
  // API call (beta — computer-use)
  // =========================================================================

  _callAPI() {
    this._validateHistory();

    return this.client.beta.messages.create({
      model: this._currentModel,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: this._getTools(),
      messages: this.history,
      betas: ['computer-use-2025-01-24'],
    });
  }

  _validateHistory() {
    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role === 'user' && Array.isArray(msg.content) &&
        msg.content.some((c) => c.type === 'tool_result')) {
        if (i === 0 || this.history[i - 1].role !== 'assistant') {
          console.error('[agent] Corrupted history — orphaned tool_result at index', i, '. Clearing.');
          this.history = [];
          return;
        }
        const prevContent = this.history[i - 1].content || [];
        const toolUseIds = new Set(prevContent.filter((b) => b.type === 'tool_use').map((b) => b.id));
        const hasOrphan = msg.content.some((c) => c.type === 'tool_result' && !toolUseIds.has(c.tool_use_id));
        if (hasOrphan) {
          console.error('[agent] Corrupted history — mismatched tool_use_id at index', i, '. Clearing.');
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
      case 'computer': {
        const a = tu.input?.action || '?';
        if (a === 'screenshot') return 'Taking screenshot...';
        if (a === 'left_click') return `Clicking (${tu.input.coordinate?.join(', ')})...`;
        if (a === 'right_click') return `Right-clicking (${tu.input.coordinate?.join(', ')})...`;
        if (a === 'double_click') return `Double-clicking (${tu.input.coordinate?.join(', ')})...`;
        if (a === 'type') return `Typing "${(tu.input.text || '').slice(0, 30)}"...`;
        if (a === 'key') return `Pressing ${tu.input.text || '?'}...`;
        if (a === 'scroll') return 'Scrolling...';
        if (a === 'mouse_move') return 'Moving mouse...';
        if (a === 'left_click_drag') return 'Dragging...';
        return `Computer: ${a}...`;
      }
      case 'browser_action': {
        const a = tu.input?.action || '?';
        if (a === 'navigate') return `Navigating to ${(tu.input.url || '').slice(0, 40)}...`;
        if (a === 'read_page') return 'Reading page...';
        if (a === 'click_selector') return `Clicking ${(tu.input.selector || '').slice(0, 30)}...`;
        if (a === 'click_text') return `Clicking "${(tu.input.text || '').slice(0, 30)}"...`;
        if (a === 'type') return `Typing into ${(tu.input.selector || '').slice(0, 30)}...`;
        if (a === 'scroll') return `Scrolling ${tu.input.direction || 'down'}...`;
        if (a === 'press_key') return `Pressing ${tu.input.key || '?'}...`;
        return `Browser: ${a}...`;
      }
      case 'focus_window':
        return `Focusing ${(tu.input?.title_pattern || '').slice(0, 30)}...`;
      case 'request_confirmation':
        return 'Asking for confirmation...';
      default:
        return `${tu.name}...`;
    }
  }

  clearHistory() {
    this.history = [];
    this.toolCallHistory = [];
    this._currentModel = MODEL_FAST;
    this._retryCount = 0;
    this._lastScreenshotHash = null;
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
