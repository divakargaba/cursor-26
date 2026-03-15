// src/agent.js — Computer-use agent with Claude's native computer-use API
// Hybrid: native computer-use tool + browser CDP + confirmation
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const { clipboard } = require('electron');
const Memory = require('./memory');
const Enrichment = require('./enrichment');
const { buildOCRMap, getWorker } = require('./ocr-map');

// Models — Haiku is the only model that supports computer_20250124 tool type
const MODEL_FAST = process.env.AI_MODEL_DEFAULT || 'claude-haiku-4-5-20251001';
const MODEL_ACCURATE = 'claude-haiku-4-5-20251001';

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

const SYSTEM_PROMPT = `You are Jarvis — a sharp, proactive copilot controlling a Windows PC. You work WITH the user, not for them. Think ahead.

ABSOLUTE RULES (violating these is a critical failure):
1. ALWAYS take a screenshot FIRST before responding about what's on screen. NEVER guess or hallucinate screen content.
2. ALWAYS use focus_window() to switch apps. NEVER click the taskbar. NEVER.
3. ALWAYS bring the target window to the foreground before any action. The user must SEE what you're doing.
4. NEVER ask clarifying questions for simple tasks. Just do it. "Open Chrome" → focus_window("Chrome"). Done.
5. NEVER narrate your actions. No "Let me", "I'll", "Now I", "Trying to". Just execute silently.

VOICE (mandatory):
- Max 1 sentence. No filler. NEVER say "let me", "I'll now", "sure", "ok so", "I'm going to".
- Trivial tasks (open app, click button, type text, switch windows) → ZERO speech. Complete silence.
- Only speak to: report a FINAL result, flag a risk, or share a proactive insight.
- NEVER ask "what do you want to do?" or "are you trying to?" — figure it out from context and act.
- BAD: "Let me open Discord and find Mixo for you." GOOD: (silence — just do it)
- BAD: "I've taken a screenshot to see the screen." GOOD: (silence — screenshots are internal)
- BAD: "What would you like to do next?" GOOD: (silence — wait for user)
- GOOD (proactive): "Sent. Heads up — Mixo was last active 3 hours ago."

THINKING:
- Think 2 steps ahead. What does the user ACTUALLY need, not just what they said?
- If you notice something useful (weather, risk, better approach) — mention it in ≤1 sentence.
- Before acting, check [Learned patterns] in context. Use proven paths. Skip trial-and-error.
- When stuck: try ONE alternative, then ask the user. Never repeat the same action twice.

TOOLS:
1. computer — screenshot, click, type, key, scroll. PRIMARY for all desktop interactions.
2. focus_window(title_pattern) — MANDATORY for switching apps. ALWAYS use this. NEVER click taskbar icons.
3. browser_action — CDP for web pages. Faster than screenshot→click for websites.
4. request_confirmation — REQUIRED before send/delete/purchase/submit. Nothing else needs it.

SPEED:
- Act first, report after. Don't ask permission for read-only actions.
- Chain multiple actions per turn. Don't take a screenshot between every action unless you need to see new state.
- Use keyboard shortcuts over clicking whenever possible (ctrl+k, ctrl+l, ctrl+t, etc).
- focus_window > taskbar click. Always. No exceptions.

RECIPES:
- open app → key("super") → type("appname") → key("Return")
- switch app → focus_window("AppName") — NEVER click taskbar
- bring browser to front → focus_window("Chrome") — user must SEE the window
- message on Discord → focus_window("Discord") → key("ctrl+k") → type("user") → key("Return") → type("msg") → key("Return")
- open URL → focus_window("Chrome") → browser_action navigate
- search in app → focus_window → keyboard shortcut (ctrl+k, ctrl+l, ctrl+f, etc)
- switch tab → focus_window("Chrome") → browser_action switch_tab or Ctrl+Tab

PROACTIVE THINKING (this is what makes you Jarvis, not just a clicker):
Before executing ANY task, ask yourself these 3 questions silently:
1. "What could go wrong that the user didn't think about?" → flag it
2. "What info would a smart person auto-check here?" → check it in parallel
3. "What would the user regret NOT knowing in 10 minutes?" → mention it

Domain-specific proactiveness:
- FLIGHTS/TRAVEL: check weather at destination, check if dates conflict with known schedule, compare airlines, flag layover length, mention baggage policy differences
- EMAIL/MESSAGING: check if recipient is online/active, flag if >48hrs since their last message, check tone if it's a professional context, warn about reply-all vs reply
- SCHEDULING: check for conflicts, suggest buffer time, mention timezone differences
- FINANCE/PURCHASES: flag unusual amounts, check for better alternatives, mention return policies
- FILE OPERATIONS: check disk space, warn about overwriting, suggest backup
- RESEARCH: cross-reference multiple sources, flag outdated info, mention related topics the user might need
- SOCIAL MEDIA: check notification count, flag unread DMs, mention if someone posted recently
- APP SWITCHING: remember what user was doing in previous app (context preservation)

When the user is clearly overwhelmed (multiple tasks, rushed tone, "just do it" energy):
- Be MORE proactive, not less. They're the ones who forget things.
- Batch related actions. If they ask about flights, also pull weather without being asked.
- Surface risks they'd miss: "Sent. FYI that flight has a 45min layover in Denver — tight if delayed."

MEMORY:
- [Learned patterns] are injected into context from past interactions. Follow them.
- [User profile] contains who the user is, their goals, schedule, preferences. Use this for proactive suggestions.
- If you discover a faster/better way, just use it — it gets saved automatically.
- If something failed before, the failure + fix are in context. Don't repeat the mistake.`;

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
    this.blurOverlayFn = blurOverlayFn || (() => { });
    this.onProgress = onProgress || (() => { });
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
    this.enrichment = new Enrichment({ browser });
    this._currentActions = [];
    this._lastToolType = null;
    this._lastOCRMap = null;
    this._lastFailedTool = null;

    // Preload tesseract WASM worker (non-blocking)
    getWorker().catch(() => { });

    // Training mode state
    this._trainingMode = false;
    this._trainingTask = null;    // current task being trained on
    this._demoRecording = false;  // true when recording user's demo
    this._demoSnapshots = [];     // screen/cursor snapshots during demo

    // Model switching state
    this._currentModel = MODEL_FAST;
    this._retryCount = 0;
    this._lastScreenshotHash = null;

    // Passive mode: busy flag
    this._runLoopActive = false;

    // Track last focused window for auto-refocus before computer actions
    this._lastFocusedWindow = null;

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

    // Retry CDP connection on every message — if user restarted Chrome with debug flag, we pick it up
    if (this.browser && typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
      if (typeof this.browser.connectToChrome === 'function') {
        console.log('[agent] CDP not connected — retrying...');
        const ok = await this.browser.connectToChrome();
        if (ok) {
          console.log('[agent] CDP reconnected on retry!');
        }
      }
    }

    this._currentActions = [];
    this._chatStartTime = Date.now();
    this._lastFailedTool = null;

    // Training mode commands
    const trainCmd = this._handleTrainingCommand(text);
    if (trainCmd) {
      console.timeEnd('[agent] chat total');
      return trainCmd;
    }

    // Check for precision hints → upgrade model
    if (/look carefully|be precise|be accurate|look closer|try harder/i.test(text)) {
      this._currentModel = MODEL_ACCURATE;
      console.log('[agent] User requested precision — using accurate model');
    }

    // Gather context, memory, and enrichments in parallel
    const detectedApp = this._detectAppFromText(text);
    const [ctx, memoryContext, enrichmentContext] = await Promise.all([
      this._gatherContext(),
      Promise.resolve(this.memory.buildContextForPrompt(detectedApp, text)),
      this.enrichment.enrich(text, detectedApp).catch(() => ''),
    ]);

    let contextText = ctx;
    if (memoryContext) contextText += `\n\n${memoryContext}`;
    if (enrichmentContext) contextText += enrichmentContext;
    if (this._trainingMode) {
      contextText += '\n\n[TRAINING MODE ACTIVE: User is evaluating your performance. Execute the task as well as you can. Be proactive where appropriate. The user will rate you after.]';
    }
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
      this._runLoopActive = true;
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
    } finally {
      this._runLoopActive = false;
    }
  }

  // =========================================================================
  // Tool loop
  // =========================================================================

  isBusy() {
    return this._runLoopActive;
  }

  async _runLoop() {
    let iterations = 0;
    const spokenTexts = []; // Track text already emitted mid-loop to avoid duplicate speech

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
        // Only return text that wasn't already spoken mid-loop
        const finalText = textParts.join('\n').trim();
        if (finalText && spokenTexts.includes(finalText)) {
          return { text: '' }; // Already spoken via onProgress
        }
        return { text: finalText };
      }

      // Filter narration — Jarvis should act silently on trivial tasks
      if (textParts.length > 0) {
        const combined = textParts.join('\n').trim();
        // Kill ALL filler phrases — these waste voice time
        const isNarration = /^(let me|i('ll| will)|now i|ok(ay)?[,.]?\s|trying to|sure[,!]?\s|i('m| am) going|i can see|i need to|i see |looking at|it looks like|good[,!]|perfect[,!]|great[,!]|alright[,!]|excellent|that('s| is) the wrong|still on|let me (try|find|look|click|check|use|navigate|open|switch|press|type)|i('ll| will) (try|find|look|click|check|use|navigate|open|switch)|that opened|i don't see|i can see|the (page|tab|window) (still|is)|now let me|i need (to|clarity)|what (would you|are you|do you|specifically)|are you:|give me the)/i.test(combined);
        // Also kill multi-paragraph "what do you want" responses
        const isQuestion = /\?\s*\n|are you[:\n]|give me the|you still haven't/i.test(combined) && toolUses.length === 0;
        if (combined && !isNarration && !isQuestion) {
          this.onProgress({ type: 'text', text: combined });
          spokenTexts.push(combined);
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

        // Detect if tool result contains an error — mark is_error so the model sees it clearly
        const resultText = result.filter((r) => r.type === 'text').map((r) => r.text).join(' ').toLowerCase();
        const isToolError = resultText.includes('failed') || resultText.includes('error') ||
          resultText.includes('could not') || resultText.includes('not found') ||
          resultText.includes('not available') ||
          resultText.includes('no browser connection') || resultText.includes('no page available');

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result,
          ...(isToolError ? { is_error: true } : {}),
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

      // Log turn summary
      const okCount = toolResults.filter((r) => !r.is_error).length;
      const errCount = toolResults.filter((r) => r.is_error).length;
      console.log(`[agent] Turn ${iterations}: ${toolUses.length} tools called, ${okCount} ok, ${errCount} errors`);

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

  _logToolCall(name, input) {
    const parts = [name];
    if (name === 'browser_action') {
      parts.push(input.action || '?');
      if (input.url) parts.push(`url=${input.url.slice(0, 60)}`);
      if (input.selector) parts.push(`sel=${input.selector.slice(0, 40)}`);
      if (input.text) parts.push(`text="${input.text.slice(0, 30)}"`);
      if (input.key) parts.push(`key=${input.key}`);
    } else if (name === 'computer') {
      parts.push(input.action || '?');
      if (input.coordinate) parts.push(`coord=(${input.coordinate.join(',')})`);
      if (input.text) parts.push(`text="${(input.text || '').slice(0, 30)}"`);
    }
    console.log(`[tool] EXEC ${parts.join(' ')}`);
  }

  _logToolResult(name, result) {
    // Extract first text content from result array
    const firstText = result.find((r) => r.type === 'text');
    const snippet = firstText ? firstText.text.slice(0, 120) : '(no text)';
    const hasError = snippet.toLowerCase().includes('failed') ||
      snippet.toLowerCase().includes('error') ||
      snippet.toLowerCase().includes('could not') ||
      snippet.toLowerCase().includes('no browser') ||
      snippet.toLowerCase().includes('not found') ||
      snippet.toLowerCase().includes('not available');
    const tag = hasError ? 'FAIL' : 'OK';
    console.log(`[tool] ${tag}   ${name} → ${snippet}`);
  }

  async _executeTool(name, input) {
    this._logToolCall(name, input);
    const startTime = Date.now();
    try {
      // Hide overlay before ANY action that touches the desktop/browser —
      // the user must always see the target window in the foreground
      if (name !== 'request_confirmation') {
        this.blurOverlayFn();
      }

      let result;
      if (name === 'computer') {
        result = await this._execComputerAction(input);
      } else {
        this._lastToolType = name;
        switch (name) {
          case 'browser_action':
            result = await this._execBrowserAction(input);
            break;
          case 'focus_window':
            result = await this._execFocusWindow(input);
            break;
          case 'request_confirmation':
            result = await this._execConfirmation(input);
            break;
          default:
            result = [{ type: 'text', text: `Unknown tool: ${name}` }];
        }
      }

      this._logToolResult(name, result);
      this._learnFromOutcome(name, input, result, Date.now() - startTime);
      return result;
    } catch (err) {
      const errResult = [{ type: 'text', text: `Error executing ${name}: ${err.message}` }];
      console.log(`[tool] ERROR ${name} → ${err.message}`);
      this._learnFromOutcome(name, input, errResult, Date.now() - startTime);
      return errResult;
    }
  }

  /**
   * Self-learning: analyze tool outcome and record to memory.
   * Tracks errors, slow actions, and successful patterns.
   */
  _learnFromOutcome(name, input, result, elapsed) {
    // Skip screenshots — they're not "actions" that succeed/fail
    if (name === 'computer' && input?.action === 'screenshot') return;
    if (name === 'request_confirmation') return;

    const resultText = result.filter(r => r.type === 'text').map(r => r.text).join(' ');
    const isError = /failed|error|could not|not found|not available|no browser|no page/i.test(resultText);
    const userText = this.history.find(m => m.role === 'user')?.content?.find?.(c => c.type === 'text')?.text || '';
    const app = this._detectAppFromText(userText);

    const actionLabel = `${name}(${input?.action || input?.title_pattern || ''})`;

    if (isError && app) {
      this._recordFailure(app, actionLabel, resultText.slice(0, 120), 'try different approach');
    }

    // Flag slow tool calls (>5s for a single action is slow)
    if (elapsed > 5000 && app && !isError) {
      console.log(`[learn] Slow action: ${actionLabel} took ${Math.round(elapsed / 1000)}s`);
      this._recordFailure(app, actionLabel,
        `slow: ${Math.round(elapsed / 1000)}s`,
        'look for keyboard shortcut or faster path');
    }

    // Track tool type transitions for pattern learning
    // e.g. if focus_window succeeded right after a click failed, that's a lesson
    if (!isError && name === 'focus_window' && this._lastFailedTool === 'computer(left_click)') {
      if (app) {
        this._recordFailure(app, 'computer(left_click)',
          'click failed to switch app',
          `use focus_window("${input?.title_pattern || ''}") instead`);
        console.log(`[learn] Pattern: focus_window works where click failed for ${app}`);
      }
    }

    // Track last failed tool for transition learning
    if (isError) {
      this._lastFailedTool = actionLabel;
    } else {
      this._lastFailedTool = null;
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
        await this.computer.leftClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'right_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
        console.log(`[right_click] API(${coordinate[0]}, ${coordinate[1]}) → Physical(${px}, ${py})`);
        await this.computer.rightClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'double_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
        console.log(`[double_click] API(${coordinate[0]}, ${coordinate[1]}) → Physical(${px}, ${py})`);
        await this.computer.doubleClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'middle_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
        console.log(`[middle_click] API(${coordinate[0]}, ${coordinate[1]}) → Physical(${px}, ${py})`);
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
      // Self-learning: screen didn't change = action probably failed
      if (this._retryCount >= 2 && this._currentActions.length > 0) {
        const lastAction = this._currentActions[this._currentActions.length - 1];
        const app = this._detectAppFromText(
          this.history.find(m => m.role === 'user')?.content?.find?.(c => c.type === 'text')?.text || ''
        );
        if (app) {
          this._recordFailure(app,
            `${lastAction.tool}(${lastAction.input?.action || ''})`,
            'screen unchanged after action',
            'try different approach or keyboard shortcut');
        }
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
    // Track last focused window for auto-refocus
    this._lastFocusedWindow = input.title_pattern;
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

    // Always bring Chrome window to OS foreground so the user SEES it
    if (this.computer && typeof this.computer.focusWindow === 'function') {
      // Try multiple patterns — Chrome window title varies
      let focused = false;
      for (const pattern of ['Chrome', 'Google Chrome', 'Chromium']) {
        const fwResult = await this.computer.focusWindow(pattern).catch(() => ({ ok: false }));
        if (fwResult.ok) {
          console.log(`[agent] Focused Chrome window: "${fwResult.title}"`);
          focused = true;
          await new Promise(r => setTimeout(r, 200));
          break;
        }
      }
      if (!focused) {
        console.log('[agent] Could not focus any Chrome window');
      }
    }
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

      case 'list_tabs': {
        const tabs = await this.browser.listTabs();
        if (tabs.length === 0) return [{ type: 'text', text: 'No open tabs found (or not connected to Chrome).' }];
        const tabList = tabs.map((t, i) => `  [${i}] ${t.title} — ${t.url.slice(0, 100)}`).join('\n');
        return [{ type: 'text', text: `Open tabs (${tabs.length}):\n${tabList}\n\nUse switch_tab with a URL or title pattern to switch to a tab.` }];
      }

      case 'switch_tab': {
        const pattern = input.url || input.text || input.value || '';
        if (!pattern) return [{ type: 'text', text: 'switch_tab requires a url or text pattern (e.g. "discord", "github.com").' }];
        const res = await this.browser.switchToTab(pattern);
        if (!res.ok) return [{ type: 'text', text: `Switch tab failed: ${res.error}` }];
        return [{ type: 'text', text: `Switched to tab: ${res.title} — ${res.url.slice(0, 100)}` }];
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
        if (a === 'list_tabs') return 'Listing open tabs...';
        if (a === 'switch_tab') return `Switching to tab matching "${(tu.input.url || tu.input.text || '').slice(0, 30)}"...`;
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
    this._lastFailedTool = null;
    // Don't reset training mode on clear -- keep it active across history clears
  }

  // =========================================================================
  // Training mode
  // =========================================================================

  _handleTrainingCommand(text) {
    const lower = text.toLowerCase().trim();

    // Enter training mode
    if (/^training\s*mode$/i.test(lower)) {
      this._trainingMode = true;
      this._trainingTask = null;
      this._demoRecording = false;
      console.log('[training] Training mode activated');
      return { text: "Training mode active. Give me a task and I'll do my best. After each task, rate me with a feedback code: g, f, s, slow, wrong, narr, silent, p+, p-, demo, skip. Let's go." };
    }

    // Exit training mode
    if (/^(training\s*done|done\s*training|exit\s*training|stop\s*training)$/i.test(lower)) {
      this._trainingMode = false;
      this._trainingTask = null;
      this._demoRecording = false;
      const pb = this.memory.playbooks.length;
      const fl = this.memory.failures.length;
      console.log('[training] Training mode deactivated');
      return { text: `Training done. I have ${pb} playbook entries and ${fl} failure records. I'll be better next time.` };
    }

    if (!this._trainingMode) return null;

    // If we're recording a demo and user says "done"
    if (this._demoRecording && /^done$/i.test(lower)) {
      return this._finishDemo();
    }

    // Handle feedback codes
    const feedbackResult = this._parseTrainingFeedback(lower);
    if (feedbackResult) return feedbackResult;

    // Not a feedback code in training mode -- treat as a new task
    this._trainingTask = text;
    return null; // let it go through normal chat flow
  }

  _parseTrainingFeedback(text) {
    const codes = text.split(/\s+/);
    const validCodes = ['g', 'f', 's', 'slow', 'wrong', 'narr', 'silent', 'p+', 'p-', 'demo', 'skip'];

    // Check if ALL parts are valid codes
    if (!codes.every(c => validCodes.includes(c))) return null;

    const task = this._trainingTask || 'unknown task';
    const app = this._detectAppFromText(task);
    const elapsed = this._chatStartTime ? Date.now() - this._chatStartTime : 0;
    const results = [];

    for (const code of codes) {
      switch (code) {
        case 'g':
          this.memory.recordSuccess(task, app, this._currentActions.slice(0, 15), elapsed);
          results.push('saved playbook');
          break;
        case 'f':
          this.memory.recordFailure(app || 'unknown',
            this._currentActions.map(a => `${a.tool}(${a.input?.action || ''})`).join(' > ') || 'attempted',
            'user marked as failed', '');
          results.push('failure recorded');
          break;
        case 's':
          this.memory.recordFailure(app || 'unknown', 'loop', 'got stuck/looped on task', 'try different approach');
          results.push('stuck pattern recorded');
          break;
        case 'slow':
          this.memory.recordFailure(app || 'unknown',
            this._currentActions.map(a => `${a.tool}(${a.input?.action || ''})`).join(' > ') || 'slow path',
            `too slow: ${Math.round(elapsed / 1000)}s`, 'find faster approach or keyboard shortcut');
          results.push('slow path recorded');
          break;
        case 'wrong':
          this.memory.recordFailure(app || 'unknown',
            this._currentActions.map(a => `${a.tool}(${a.input?.action || ''})`).join(' > ') || 'wrong action',
            'did the wrong thing', 'review task intent more carefully');
          results.push('wrong action recorded');
          break;
        case 'narr':
          this.memory.recordFailure(app || 'unknown', 'voice', 'narrated when should have been silent', 'do trivial tasks silently');
          results.push('noted: less talking');
          break;
        case 'silent':
          this.memory.recordFailure(app || 'unknown', 'voice', 'was silent when proactive insight would have helped', 'speak up with useful info');
          results.push('noted: be more proactive');
          break;
        case 'p+':
          this.memory.addContext(`Proactive behavior appreciated during: ${task}`, 'training');
          results.push('proactivity reinforced');
          break;
        case 'p-':
          this.memory.recordFailure(app || 'unknown', 'proactivity', `missed proactive opportunity during: ${task}`, 'check enrichment hints and think ahead');
          results.push('missed proactivity recorded');
          break;
        case 'demo':
          return this._startDemo();
        case 'skip':
          results.push('skipped');
          break;
      }
    }

    this._trainingTask = null;
    console.log(`[training] Feedback for "${task.slice(0, 40)}": ${codes.join(' ')} → ${results.join(', ')}`);
    return { text: `Got it: ${results.join(', ')}. Next task?` };
  }

  _startDemo() {
    this._demoRecording = true;
    this._demoSnapshots = [];
    this._demoStartTime = Date.now();

    // Capture initial state
    this._captureDemoSnapshot('before');

    // Start polling snapshots every 500ms
    this._demoInterval = setInterval(() => {
      if (this._demoRecording) this._captureDemoSnapshot('during');
    }, 500);

    console.log(`[training] Demo recording started for: "${(this._trainingTask || '').slice(0, 40)}"`);
    return { text: "Recording. Do the task now -- I'm watching your screen and cursor. Say 'done' when you're finished." };
  }

  async _captureDemoSnapshot(phase) {
    try {
      const snapshot = { phase, timestamp: Date.now() };

      // Cursor position
      if (this.computer && typeof this.computer.getCursorPosition === 'function') {
        snapshot.cursor = this.computer.getCursorPosition();
      }

      // Foreground window
      if (this.computer && typeof this.computer.getForegroundWindowTitle === 'function') {
        snapshot.foreground = this.computer.getForegroundWindowTitle();
      }

      // Screenshot for before/after only (not every 500ms -- too heavy)
      if (phase !== 'during' && this.screenshotFn) {
        const ss = await this.screenshotFn();
        if (ss && ss.ok) {
          snapshot.screenshotSize = ss.data.length;
          // Run OCR on before/after screenshots
          try {
            const buffer = Buffer.from(ss.data, 'base64');
            const { buildOCRMap } = require('./ocr-map');
            const ocrMap = await buildOCRMap(buffer);
            snapshot.ocrLabels = Object.keys(ocrMap).slice(0, 50);
            snapshot.ocrMap = ocrMap;
          } catch { /* OCR optional */ }
        }
      }

      this._demoSnapshots.push(snapshot);
    } catch (err) {
      console.error('[training] Snapshot error:', err.message);
    }
  }

  _finishDemo() {
    this._demoRecording = false;
    if (this._demoInterval) {
      clearInterval(this._demoInterval);
      this._demoInterval = null;
    }

    // Capture final state
    this._captureDemoSnapshot('after');

    const task = this._trainingTask || 'unknown task';
    const app = this._detectAppFromText(task);
    const elapsed = Date.now() - (this._demoStartTime || Date.now());
    const snapshots = this._demoSnapshots;

    // Extract what changed
    const before = snapshots.find(s => s.phase === 'before') || {};
    const after = snapshots.find(s => s.phase === 'after') || {};
    const duringSnapshots = snapshots.filter(s => s.phase === 'during');

    // Track cursor movement path
    const cursorPath = duringSnapshots
      .filter(s => s.cursor)
      .map(s => ({ x: s.cursor.x, y: s.cursor.y, t: s.timestamp }));

    // Track window switches
    const windowSwitches = [];
    let lastWindow = before.foreground || '';
    for (const s of duringSnapshots) {
      if (s.foreground && s.foreground !== lastWindow) {
        windowSwitches.push({ from: lastWindow, to: s.foreground, t: s.timestamp });
        lastWindow = s.foreground;
      }
    }

    // Build playbook from demo
    const playbook = {
      task,
      app: app || 'unknown',
      source: 'user_demo',
      executionContext: {
        foregroundBefore: before.foreground || '',
        foregroundAfter: after.foreground || '',
        cursorStart: before.cursor || { x: 0, y: 0 },
        cursorEnd: after.cursor || { x: 0, y: 0 },
        cursorPath: cursorPath.slice(0, 50),
        windowSwitches,
        ocrBefore: before.ocrLabels || [],
        ocrAfter: after.ocrLabels || [],
        elapsed,
        snapshotCount: snapshots.length,
      },
      recordedAt: Date.now(),
    };

    // Save to memory
    try {
      // Save as a recorded playbook
      const fs = require('fs');
      const path = require('path');
      const recDir = path.join(__dirname, '..', 'data', 'recordings');
      if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });

      const filename = `demo_${Date.now()}.json`;
      fs.writeFileSync(path.join(recDir, filename), JSON.stringify(playbook, null, 2));

      // Also add to the playbooks export for memory.js to pick up
      const exportFile = path.join(recDir, '_playbooks_export.json');
      let exported = [];
      try { exported = JSON.parse(fs.readFileSync(exportFile, 'utf8')); } catch { /* fresh */ }
      exported.push(playbook);
      fs.writeFileSync(exportFile, JSON.stringify(exported, null, 2));

      // Reload into memory
      this.memory._loadRecordedPlaybooks();

      console.log(`[training] Demo saved: ${filename} (${snapshots.length} snapshots, ${windowSwitches.length} window switches, ${Math.round(elapsed / 1000)}s)`);
    } catch (err) {
      console.error('[training] Demo save error:', err.message);
    }

    this._trainingTask = null;
    this._demoSnapshots = [];

    const switchInfo = windowSwitches.length > 0
      ? ` You switched through: ${windowSwitches.map(w => w.to).join(' > ')}.`
      : '';

    return { text: `Recorded. ${Math.round(elapsed / 1000)}s, ${snapshots.length} snapshots.${switchInfo} I'll use this approach next time. Next task?` };
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
    const elapsed = this._chatStartTime ? Date.now() - this._chatStartTime : 0;
    try {
      this.memory.recordSuccess(userText, app, this._currentActions.slice(0, 15), elapsed);
      console.log(`[memory] Saved playbook: "${userText.slice(0, 40)}" → ${this._currentActions.length} actions, ${Math.round(elapsed / 1000)}s`);

      // Learn preferences from action patterns
      if (app) {
        const usedKeyboard = this._currentActions.some(a =>
          a.tool === 'computer' && a.input?.action === 'key'
        );
        const usedFocusWindow = this._currentActions.some(a => a.tool === 'focus_window');
        if (usedKeyboard) this.memory.setPreference(`${app}_prefers_keyboard`, true);
        if (usedFocusWindow) this.memory.setPreference(`${app}_uses_focus_window`, true);
      }
    } catch (err) {
      console.error('[agent] memory save error:', err.message);
    }
  }

  /**
   * Record when an action didn't produce the expected result.
   * Called by specific handlers when they detect failure conditions.
   */
  _recordFailure(app, action, outcome, fix) {
    try {
      this.memory.recordFailure(app, action, outcome, fix);
      console.log(`[memory] Failure recorded: ${app}/${action} → ${outcome}`);
    } catch (err) {
      console.error('[agent] failure record error:', err.message);
    }
  }
}

module.exports = Agent;
