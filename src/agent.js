// src/agent.js — Computer-use agent with Claude's native computer-use API
// Hybrid: native computer-use tool + browser CDP + confirmation
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const { clipboard } = require('electron');
const Memory = require('./memory');
const { buildOCRMap, getWorker } = require('./ocr-map');

// Models — Sonnet for the main agent brain, Haiku only for suggestions
const MODEL_DEFAULT = process.env.AI_MODEL_DEFAULT || 'claude-sonnet-4-20250514';
const MODEL_FAST = 'claude-haiku-4-5-20251001';

const MAX_TOKENS = 8192;
const MAX_ITERATIONS = 12;
const MAX_HISTORY = 12;

// Loop detection thresholds — tight to prevent wasted iterations
const LOOP_HISTORY_SIZE = 10;
const LOOP_WARNING_THRESHOLD = 2;
const LOOP_HALT_THRESHOLD = 4;

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

const SYSTEM_PROMPT = `You are a desktop AI assistant that helps users complete tasks on their computer. You can see the user's screen context (what app they're using, what's on the page, what elements are available) and take actions through browser control and native desktop control.

## Core Principles

1. SIMPLEST PATH FIRST. Always choose the most direct route to accomplish a task. If you can see a "Send" button, click it. Don't navigate through menus, use keyboard shortcuts, or take indirect paths when the direct one is available.

2. PREFER BROWSER ACTIONS OVER SCREENSHOTS. When browser context gives you element selectors, use browser_action tools (click_selector, click_text, type). Only use computer tool screenshots when:
   - You're controlling a native desktop app (not a browser)
   - The browser context doesn't show the element you need
   - You need to verify what happened after an action

3. UNDERSTAND BEFORE ACTING. Read the context carefully. Know what app the user is in, what content is on screen, and what elements are available BEFORE deciding what to do. Don't guess — use the information provided.

4. ASK WHEN AMBIGUOUS. If the user's request could mean multiple things, ask ONE short clarifying question before acting. Don't guess and execute the wrong thing.

5. STEP BUDGET. Simple tasks (send a message, click a button, open a URL, type text) should take 1-3 tool calls MAX. If you've used 3 tool calls on a simple task and it's not done, STOP and tell the user what's going wrong. Medium tasks (fill a form, compose an email) should take 3-6 tool calls. Complex tasks (research, multi-step workflows) can take up to 8.

6. NEVER DO THESE:
   - Don't take a screenshot to read page content when browser context already provides it
   - Don't navigate away from the current page unless the user asked to go somewhere else
   - Don't use keyboard shortcuts when a visible button does the same thing
   - Don't type text character-by-character when you can paste it
   - Don't scroll around looking for elements when the context already lists them
   - Don't repeat a failed action more than once — try a different approach or ask the user

## App-Specific Shortcuts

### Discord / Slack / Chat Apps (in Chrome)
- Switch to the tab first: browser_action switch_tab "discord"
- To send a message: click the message input (usually [data-slate-editor] or [aria-label*="Message"]), type, press Enter
- DON'T use textarea selector (matches search bar). Use [data-slate-editor="true"] for Discord.
- Channel/DM content is in the page context — read messages from there

### Gmail / Email
- To compose: click "Compose", fill To/Subject/Body, click "Send"
- To reply: click "Reply", type in reply box, click "Send"
- Reading emails: the email content is in the page context — don't screenshot to read it

### General Browsing
- To navigate: use browser_action navigate with the URL
- To click: use click_text with the link/button text, or click_selector with CSS
- To fill forms: use type with the input selector
- To switch tabs: use switch_tab with a URL/title pattern

## macOS Shortcuts
- command+space (Spotlight), command+tab (app switch), command+c/v (copy/paste)
- command+t (new tab), command+l (address bar), command+w (close tab)
- command+k (quick switcher in Discord/Slack)

## Response Format
- Be concise. Don't narrate every action. Just do it.
- Report results in 1-2 sentences. Don't explain your reasoning unless asked.
- For trivial tasks (open app, click button): execute silently, no speech needed.
- Only speak to: report a result, flag a risk, ask a question, or share a proactive insight.

## Planning
Before your first tool call on any task, state your plan in 1-2 sentences. Example:
"I'll switch to the Gmail tab, click Compose, fill in the To/Subject/Body fields, then confirm before sending."

This is not optional for tasks with more than 1 step. For single-step tasks (click one button, navigate to one URL), you can skip the plan and just act.

The step budget is a soft guideline, not a hard limit:
- Simple tasks (click, type, navigate): aim for 1-3 tool calls
- Medium tasks (compose email, fill form): aim for 3-6 tool calls
- Complex tasks (research, multi-app workflows): use as many as needed, up to 12
Don't give up on a task just because you've used several tool calls. If you're making progress, keep going.

## Recovery From Failures
When a tool call fails or returns an error:
1. READ the error message carefully. Don't retry the exact same call.
2. Try ONE alternative approach:
   - If click_selector failed -> try click_text with the visible label text
   - If click_text failed -> try read_page to refresh the element list, then click_selector with an updated selector
   - If type failed -> check if the right element is focused, click it first, then type
   - If navigate failed -> check the URL format, try with/without https://
3. If the alternative also fails -> tell the user what's blocking you and ask for guidance. Don't keep guessing.

NEVER repeat a failed tool call with the exact same parameters. If it didn't work once, it won't work again.

## Verification After Critical Actions
After completing a critical action (sending a message, submitting a form, deleting something, saving a file), do ONE verification step:
- Use read_page to check the current state of the page
- Confirm the action actually took effect (e.g., the compose window closed after sending, the message appears in the chat, the form shows a success state)
- If verification shows the action didn't work, tell the user honestly: "I tried to send the message but it doesn't look like it went through. The compose window is still open. Want me to try again?"

Don't skip verification on important actions. A quick read_page after clicking Send is worth it.`;

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
   * @param {Function} opts.showOverlayFn - () => void
   * @param {Function} opts.onProgress    - ({ type, text }) => void
   * @param {Function} opts.onConfirmationRequest - async (preview) => { confirmed, reason? }
   * @param {Object} opts.displayConfig   - { physicalWidth, physicalHeight, displayWidth, displayHeight, scaleX, scaleY }
   */
  constructor({ browser, computer, screenshotFn, blurOverlayFn, showOverlayFn, onProgress, onConfirmationRequest, displayConfig }) {
    this.client = new Anthropic();
    this.browser = browser;
    this.computer = computer;
    this.screenshotFn = screenshotFn;
    this.blurOverlayFn = blurOverlayFn || (() => { });
    this.showOverlayFn = showOverlayFn || (() => { });
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
    this._currentActions = [];
    this._lastToolType = null;
    this._lastOCRMap = null;
    this._lastContext = null; // cached context for validation

    // Preload tesseract WASM worker (non-blocking)
    getWorker().catch(() => { });

    // Model switching state
    this._currentModel = MODEL_DEFAULT;
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
        description: 'Control browser via CDP. PREFERRED for all web page interactions — much faster and more reliable than screenshot clicking. Use switch_tab to target the right tab before interacting. Use read_page to see what is on the page.',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['navigate', 'read_page', 'click_selector', 'click_text', 'type', 'scroll', 'press_key', 'list_tabs', 'switch_tab'] },
            url: { type: 'string', description: 'URL for navigate, or pattern for switch_tab (e.g. "discord", "spotify")' },
            selector: { type: 'string' },
            text: { type: 'string', description: 'Text for click_text, or pattern for switch_tab' },
            value: { type: 'string' },
            direction: { type: 'string', enum: ['up', 'down'] },
            key: { type: 'string' },
          },
          required: ['action'],
        },
      },
      // Focus a window by title
      {
        name: 'focus_window',
        description: 'Focus a desktop window by title pattern (regex). Use for native apps not in the browser.',
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
  // Loop detection (hash-based, warn at 2, halt at 4)
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
        message: `WARNING: You have called ${name} ${count} times with the same arguments. Try a DIFFERENT approach or tell the user what's failing.`,
      };
    }
    return { stuck: false };
  }

  _resetLoopDetection() { this.toolCallHistory = []; }

  // =========================================================================
  // Context gathering — rich structured context for smarter decisions
  // =========================================================================

  async _gatherContext() {
    const parts = [];
    const ctx = { browserConnected: false, elements: [], mainContent: null, focusedElement: null };

    try {
      if (this.browser && typeof this.browser.isConnected === 'function' && this.browser.isConnected()) {
        ctx.browserConnected = true;

        // Get all open tabs (sync, no hanging)
        const tabs = typeof this.browser.getTabUrls === 'function' ? this.browser.getTabUrls() : [];
        if (tabs.length > 0) {
          const tabList = tabs.map(t => `  - ${t.url}`).join('\n');
          parts.push(`[Chrome CDP connected — ${tabs.length} tabs]\n${tabList}`);
        } else {
          parts.push('[Chrome CDP connected]');
        }

        // Get rich page context (with timeout)
        try {
          const pageCtx = await Promise.race([
            this.browser.getPageContext(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
          ]);
          if (pageCtx) {
            ctx.elements = pageCtx.elements || [];
            ctx.mainContent = pageCtx.mainContent || null;
            ctx.focusedElement = pageCtx.focusedElement || null;

            // Build structured context string
            parts.push(`\nAPP: ${pageCtx.metadata?.domain || 'unknown'} (${pageCtx.url})`);
            parts.push(`PAGE: ${pageCtx.title}`);

            if (pageCtx.selectedText) {
              parts.push(`SELECTED TEXT: ${pageCtx.selectedText}`);
            }

            if (pageCtx.mainContent) {
              parts.push(`\nMAIN CONTENT:\n${pageCtx.mainContent.slice(0, 1500)}`);
            }

            if (pageCtx.inputs && pageCtx.inputs.length > 0) {
              const inputSummary = pageCtx.inputs.slice(0, 15).map(inp => {
                const label = inp.label || inp.placeholder || inp.name || inp.id || inp.type || 'input';
                const val = inp.value ? ` value="${inp.value.slice(0, 50)}"` : '';
                const focus = inp.focused ? ' [FOCUSED]' : '';
                return `  ${inp.tag}[${label}]${val}${focus}`;
              }).join('\n');
              parts.push(`\nINPUT FIELDS:\n${inputSummary}`);
            }

            if (pageCtx.elements && pageCtx.elements.length > 0) {
              const elemSummary = pageCtx.elements.slice(0, 30).map((e, i) => {
                const parts2 = [`[${i + 1}]`, e.tag];
                if (e.text) parts2.push(`"${(e.text || '').slice(0, 40)}"`);
                if (e.id) parts2.push(`#${e.id}`);
                if (e.type) parts2.push(`type=${e.type}`);
                if (e.href) parts2.push(`→${e.href.slice(0, 50)}`);
                return '  ' + parts2.join(' ');
              }).join('\n');
              parts.push(`\nINTERACTIVE ELEMENTS:\n${elemSummary}`);
            }
          }
        } catch (err) {
          if (err.message !== 'timeout') {
            console.error('[agent] browser page context error:', err.message);
          }
        }

        // Inject recent failure warnings for this app
        const detectedApp = this._detectApp({ url: pageCtx?.url, title: pageCtx?.title });
        if (detectedApp) {
          const recentFailures = this.memory?.getRecentFailures(detectedApp, 3);
          if (recentFailures?.length > 0) {
            const failLines = recentFailures.map(f =>
              `- ${f.action}: "${f.outcome}" -> Fix: ${f.fix}`
            ).join('\n');
            parts.push(`\n[Known Issues]\n${failLines}`);
          }
        }

        // Add context hints
        parts.push(this._getContextHints(ctx));
        this._lastContext = ctx;
        return parts.join('\n');
      }
    } catch (err) {
      console.error('[agent] browser context error:', err.message);
    }

    try {
      if (this.computer && typeof this.computer.listWindows === 'function') {
        const windows = await this.computer.listWindows();
        if (windows && windows.length > 0) {
          const list = windows.slice(0, 10).map(w => `  ${w.ProcessName}: ${w.MainWindowTitle}`).join('\n');
          ctx.browserConnected = false;
          this._lastContext = ctx;
          return `[Open windows]\n${list}\n\nThis is a native desktop app. Use computer tool to take a screenshot and interact.`;
        }
      }
    } catch (err) {
      console.error('[agent] window list error:', err.message);
    }

    this._lastContext = ctx;
    return '[Desktop ready. Use computer tool to take a screenshot and interact.]';
  }

  // =========================================================================
  // Context hints — tell Claude exactly which tools to use
  // =========================================================================

  _getContextHints(ctx) {
    const hints = [];

    if (ctx.browserConnected && ctx.elements && ctx.elements.length > 0) {
      hints.push('Browser context is available with element details. USE browser_action tools (click_selector, click_text, type) for all browser interactions. Do NOT use computer tool screenshot to read page content — it is already provided above.');
    }

    if (ctx.browserConnected && (!ctx.elements || ctx.elements.length === 0)) {
      hints.push('Browser is connected but no elements were found. The page may still be loading. Try browser_action read_page, or use computer tool screenshot to see the screen.');
    }

    if (!ctx.browserConnected) {
      hints.push('No browser connection. This is a native desktop app. Use computer tool for screenshots and interaction.');
    }

    if (ctx.focusedElement) {
      hints.push(`Currently focused element: ${ctx.focusedElement}. You can type directly without clicking first.`);
    }

    if (ctx.mainContent) {
      hints.push('Page content is provided above. Read it directly — do NOT take a screenshot to read text that is already in the context.');
    }

    return hints.length > 0 ? '\n\n## Context Hints\n' + hints.join('\n') : '';
  }

  // =========================================================================
  // Pre-action validation — catch obviously wrong tool choices
  // =========================================================================

  _validateToolCall(name, input) {
    const ctx = this._lastContext || {};

    // Don't take screenshots when browser context has content
    if (name === 'computer' && input.action === 'screenshot' && ctx.browserConnected && ctx.mainContent) {
      return { valid: false, reason: 'Browser content is already available in context. Use browser_action read_page if you need updated content, or read the context provided. Do not screenshot to read text.' };
    }

    // Don't use computer click/type when in a browser — use browser_action
    if (name === 'computer' && ctx.browserConnected && ctx.elements && ctx.elements.length > 0) {
      if (input.action === 'left_click' || input.action === 'type') {
        return { valid: false, reason: 'Use browser_action (click_selector, click_text, type) instead of computer tool when controlling a browser page. It is faster and more reliable.' };
      }
    }

    return { valid: true };
  }

  // =========================================================================
  // Tool error handling — record failures + suggest fixes
  // =========================================================================

  _handleToolResult(toolName, toolInput, result, context) {
    const resultText = result.filter(r => r.type === 'text').map(r => r.text).join(' ').toLowerCase();
    const isError = resultText.includes('failed') ||
      resultText.includes('error') ||
      resultText.includes('not found') ||
      resultText.includes('unable to') ||
      resultText.includes('timeout') ||
      resultText.includes('no element') ||
      resultText.includes('could not') ||
      resultText.includes('not available') ||
      resultText.includes('no page available') ||
      resultText.includes('no browser connection');

    if (isError) {
      const app = this._detectApp(context);
      const action = `${toolName}:${toolInput.action || toolInput.command || 'unknown'}`;
      const errorSnippet = resultText.slice(0, 200);
      const suggestedFix = this._getSuggestedFix(toolName, toolInput, errorSnippet);

      if (this.memory) {
        this.memory.recordFailure(app || 'unknown', action, errorSnippet, suggestedFix);
        console.log(`[memory] Failure: ${action} → ${errorSnippet.slice(0, 80)}`);
      }

      return { isError: true, suggestedFix };
    }

    return { isError: false };
  }

  _getSuggestedFix(toolName, toolInput, error) {
    if (toolName === 'browser_action') {
      if (toolInput.action === 'click_selector' && error.includes('not found')) {
        return 'Try click_text with the visible label text, or read_page to refresh elements';
      }
      if (toolInput.action === 'click_text' && error.includes('not found')) {
        return 'Try read_page to get updated elements, then use click_selector with a CSS selector';
      }
      if (toolInput.action === 'type' && error.includes('not found')) {
        return 'Click the target input field first, then type';
      }
      if (error.includes('timeout')) {
        return 'Page may still be loading. Wait briefly then try again, or check if a popup/modal is blocking';
      }
    }
    if (toolName === 'computer') {
      if (error.includes('not found')) {
        return 'Try take_screenshot to see current state, then click by grid cell';
      }
    }
    return 'Try a different approach or ask the user for guidance';
  }

  // =========================================================================
  // Recovery hints — injected after failed tool calls
  // =========================================================================

  _getRecoveryHint(toolName, toolInput, result, context) {
    if (toolName === 'browser_action' && context.browserConnected) {
      if (toolInput.action === 'click_selector' || toolInput.action === 'click_text') {
        const elemPreview = context.elements?.slice(0, 5).map(e => e.text || e.tag).join(', ') || 'none loaded';
        return `That click failed. Try read_page to refresh the element list — the page may have changed. Then try clicking with a different method (click_text if you used click_selector, or vice versa). Recent elements: ${elemPreview}`;
      }
      if (toolInput.action === 'type') {
        return 'Typing failed. The target element may not be focused. Try clicking the input field first with click_selector or click_text, then type.';
      }
    }

    if (toolName === 'computer' && context.browserConnected) {
      return 'Native action failed, but browser context is available. Try using browser_action instead — it is more reliable for web pages.';
    }

    if (toolName === 'computer' && toolInput.action === 'screenshot' && context.browserConnected && context.mainContent) {
      return 'You have browser context with page content and elements. Use browser_action tools instead of screenshot-based interaction.';
    }

    return 'Last action failed. Try a different approach. If stuck after 2 attempts, tell the user what is blocking you.';
  }

  // =========================================================================
  // App detection — URL > title > user text
  // =========================================================================

  _detectApp(context) {
    // Priority 1: URL-based detection (most reliable)
    const url = context?.url || context?.pageUrl || '';
    const urlMappings = {
      'mail.google.com': 'gmail', 'gmail.com': 'gmail',
      'outlook.live.com': 'outlook', 'outlook.office.com': 'outlook',
      'discord.com': 'discord', 'app.slack.com': 'slack',
      'docs.google.com': 'google-docs', 'sheets.google.com': 'google-sheets',
      'github.com': 'github', 'linkedin.com': 'linkedin',
      'twitter.com': 'twitter', 'x.com': 'twitter',
      'youtube.com': 'youtube', 'notion.so': 'notion',
      'reddit.com': 'reddit', 'calendar.google.com': 'google-calendar',
      'figma.com': 'figma',
    };
    for (const [domain, app] of Object.entries(urlMappings)) {
      if (url.includes(domain)) return app;
    }

    // Priority 2: Window title based detection
    const title = (context?.windowTitle || context?.title || '').toLowerCase();
    const titleMappings = {
      'discord': 'discord', 'slack': 'slack', 'code': 'vscode',
      'cursor': 'cursor', 'terminal': 'terminal', 'finder': 'finder',
      'explorer': 'explorer', 'spotify': 'spotify',
    };
    for (const [keyword, app] of Object.entries(titleMappings)) {
      if (title.includes(keyword)) return app;
    }

    // Priority 3: User message keyword detection
    const text = (context?.userMessage || '').toLowerCase();
    const textMappings = {
      'email': 'gmail', 'mail': 'gmail', 'inbox': 'gmail',
      'chat': 'discord', 'dm': 'discord', 'message': 'discord',
      'code': 'vscode', 'editor': 'vscode', 'ide': 'vscode',
      'browser': 'chrome', 'web': 'chrome',
      'calendar': 'google-calendar', 'schedule': 'google-calendar',
      'doc': 'google-docs', 'document': 'google-docs',
      'sheet': 'google-sheets', 'spreadsheet': 'google-sheets',
    };
    for (const [keyword, app] of Object.entries(textMappings)) {
      if (text.includes(keyword)) return app;
    }

    return null;
  }

  // =========================================================================
  // Auto-verification — check if the task actually completed
  // =========================================================================

  async _verifyCompletion(task, lastActions, context) {
    // Only verify if the task involved critical actions
    const criticalActions = ['click_text', 'click_selector', 'type', 'press_key', 'navigate'];
    const hadCriticalAction = lastActions.some(a => criticalActions.includes(a.action));
    if (!hadCriticalAction) return null;

    // Quick read_page to get current state
    let currentState = null;
    try {
      if (context.browserConnected && this.browser) {
        currentState = await Promise.race([
          this.browser.getPageContext(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ]);
      }
    } catch {
      return null;
    }
    if (!currentState) return null;

    try {
      const verificationResponse = await this.client.messages.create({
        model: MODEL_FAST,
        max_tokens: 200,
        system: 'You verify whether a task was completed. Given the original task and the current screen state, respond with ONLY a JSON object: {"complete": true/false, "reason": "short explanation"}',
        messages: [{
          role: 'user',
          content: `Original task: "${task}"\n\nCurrent screen state:\nURL: ${currentState.url}\nTitle: ${currentState.title}\nContent: ${currentState.mainContent?.slice(0, 500) || 'N/A'}\nVisible elements: ${currentState.elements?.slice(0, 10).map(e => e.text || e.tag).join(', ')}`,
        }],
      });

      const text = verificationResponse.content[0].text.replace(/```json|```/g, '').trim();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Main entry point
  // =========================================================================

  async chat(text) {
    const _chatStart = Date.now();
    console.time('[agent] chat total');
    this.onProgress({ type: 'status', text: 'Reading context...' });

    // Retry CDP connection on every message
    if (this.browser && typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
      if (typeof this.browser.connectToChrome === 'function') {
        console.log('[agent] CDP not connected — retrying...');
        const ok = await this.browser.connectToChrome();
        if (ok) console.log('[agent] CDP reconnected on retry!');
      }
    }

    this._currentActions = [];
    this._chatStartTime = Date.now();

    const ctx = await this._gatherContext();

    // Get full memory context
    const detectedApp = this._detectAppFromText(text);
    const memoryContext = this.memory.buildContextForPrompt(detectedApp, text);

    const contextText = memoryContext ? `${ctx}\n\n${memoryContext}` : ctx;
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
      this.showOverlayFn();
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

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      console.log(`[agent] --- Iteration ${iterations}/${MAX_ITERATIONS} (model: ${this._currentModel}) ---`);
      console.time(`[agent] iteration-${iterations}`);

      console.time(`[agent] API call #${iterations}`);
      const response = await this._callAPI();
      console.timeEnd(`[agent] API call #${iterations}`);
      this.history.push({ role: 'assistant', content: response.content });

      const textParts = response.content.filter((b) => b.type === 'text').map((b) => b.text);
      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      // No tool calls → done — verify completion for critical tasks
      if (toolUses.length === 0) {
        this._saveToMemory();
        const finalText = textParts.join('\n') || 'Done.';

        // Auto-verify if we took critical actions
        if (this._currentActions.length > 0) {
          try {
            const originalMsg = this.history.find(m => m.role === 'user');
            const originalText = originalMsg?.content?.find?.(c => c.type === 'text')?.text || '';
            const ctx = this._lastContext || {};
            const verification = await this._verifyCompletion(originalText, this._currentActions, ctx);
            if (verification && !verification.complete) {
              const followUp = `${finalText}\n\n(Note: verification suggests this may not have fully worked: ${verification.reason}. Want me to try again?)`;
              return { text: followUp };
            }
          } catch (err) {
            console.error('[agent] verification error (non-fatal):', err.message);
          }
        }

        return { text: finalText };
      }

      // Filter narration — only kill pure filler
      if (textParts.length > 0) {
        const combined = textParts.join('\n').trim();
        const isShortFiller = combined.length < 80 &&
          /^(let me|i('ll| will)|now i|ok(ay)?[,.]?\s|trying to|sure[,!]?\s|i('m| am) going to)/i.test(combined);
        if (combined && !isShortFiller) {
          this.onProgress({ type: 'text', text: combined });
        }
      }

      // Execute all tool calls
      const toolResults = [];
      const recoveryHints = [];
      let halted = false;

      for (let i = 0; i < toolUses.length; i++) {
        const tu = toolUses[i];

        if (i > 0) await new Promise((r) => setTimeout(r, 50));

        this.onProgress({ type: 'status', text: this._toolLabel(tu) });

        // Pre-action validation
        const validation = this._validateToolCall(tu.name, tu.input);
        if (!validation.valid) {
          console.log(`[tool] REJECTED ${tu.name}:${tu.input?.action || ''} — ${validation.reason}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: [{ type: 'text', text: `[SYSTEM: Tool call rejected. ${validation.reason}]` }],
            is_error: true,
          });
          continue;
        }

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
        this._currentActions.push({ tool: tu.name, input: tu.input, action: tu.input?.action });

        if (loopCheck.stuck && loopCheck.level === 'warning') {
          result.unshift({ type: 'text', text: loopCheck.message });
        }

        // Detect + record tool errors, get recovery hints
        const errorInfo = this._handleToolResult(tu.name, tu.input, result, this._lastContext || {});

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result,
          ...(errorInfo.isError ? { is_error: true } : {}),
        });

        // Inject recovery hint after failures (Change 4)
        if (errorInfo.isError) {
          const hint = this._getRecoveryHint(tu.name, tu.input, result, this._lastContext || {});
          recoveryHints.push(hint);
        }
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

      const okCount = toolResults.filter((r) => !r.is_error).length;
      const errCount = toolResults.filter((r) => r.is_error).length;
      console.log(`[agent] Turn ${iterations}: ${toolUses.length} tools called, ${okCount} ok, ${errCount} errors`);

      this.history.push({ role: 'user', content: toolResults });

      // Inject recovery hints after failed tool calls (Change 4)
      if (recoveryHints.length > 0 && !halted) {
        this.history.push({
          role: 'user',
          content: [{ type: 'text', text: `[CONTEXT: ${recoveryHints.join(' ')}]` }],
        });
      }

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
    try {
      // Hide overlay before ANY action that touches the desktop/browser
      if (name !== 'request_confirmation') {
        this.blurOverlayFn();
      }

      if (name === 'computer') {
        return await this._execComputerAction(input);
      }

      this._lastToolType = name;

      let result;
      switch (name) {
        case 'browser_action':
          return await this._execBrowserAction(input);
        case 'focus_window':
          return await this._execFocusWindow(input);
        case 'request_confirmation':
          result = await this._execConfirmation(input);
          break;
        default:
          result = [{ type: 'text', text: `Unknown tool: ${name}` }];
      }
      this._logToolResult(name, result);
      return result;
    } catch (err) {
      const errResult = [{ type: 'text', text: `Error executing ${name}: ${err.message}` }];
      console.log(`[tool] ERROR ${name} → ${err.message}`);
      return errResult;
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
        await this.computer.rightClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'double_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
        await this.computer.doubleClick(px, py);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'middle_click': {
        const [px, py] = this._scaleToPhysical(coordinate);
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
        await this.computer.scroll(px, py, dir, amount);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      case 'mouse_move': {
        const [px, py] = this._scaleToPhysical(coordinate);
        await this.computer.mouseMove(px, py);
        return [{ type: 'text', text: `Moved mouse to (${coordinate[0]}, ${coordinate[1]})` }];
      }

      case 'left_click_drag': {
        const [sx, sy] = this._scaleToPhysical(start_coordinate);
        const [ex, ey] = this._scaleToPhysical(coordinate);
        await this.computer.leftClickDrag(sx, sy, ex, ey);
        await new Promise((r) => setTimeout(r, 100));
        return await this._captureScreenshot(false);
      }

      default:
        return [{ type: 'text', text: `Unknown computer action: ${action}` }];
    }
  }

  // =========================================================================
  // Screenshot capture
  // =========================================================================

  async _captureScreenshot(withOCR = true) {
    const ss = await this.screenshotFn();
    if (!ss || !ss.ok) {
      return [{ type: 'text', text: `Screenshot failed: ${ss?.error || 'unknown'}` }];
    }

    const hash = crypto.createHash('md5').update(ss.data.slice(0, 5000)).digest('hex');
    if (this._lastScreenshotHash === hash) {
      this._retryCount++;
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

  _scaleToPhysical(coordinate) {
    if (!coordinate || coordinate.length < 2) return [0, 0];
    const px = Math.round(coordinate[0] * this.displayConfig.scaleX);
    const py = Math.round(coordinate[1] * this.displayConfig.scaleY);
    return [px, py];
  }

  _normalizeKey(keyText) {
    if (!keyText) return '';
    return keyText.split('+').map((part) => {
      const trimmed = part.trim();
      return KEY_NORMALIZE[trimmed] || trimmed.toLowerCase();
    }).join('+');
  }

  // =========================================================================
  // focus_window
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
  // browser_action (CDP)
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

    // Bring browser to front
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

        const parts = [`${ctx.url} "${ctx.title}"`];

        if (ctx.mainContent) {
          parts.push(`\nCONTENT:\n${ctx.mainContent.slice(0, 1500)}`);
        }

        if (ctx.inputs && ctx.inputs.length > 0) {
          const inputSummary = ctx.inputs.slice(0, 10).map(inp => {
            const label = inp.label || inp.placeholder || inp.name || inp.id || 'input';
            const val = inp.value ? ` = "${inp.value.slice(0, 50)}"` : '';
            return `  ${inp.tag}[${label}]${val}`;
          }).join('\n');
          parts.push(`\nINPUTS:\n${inputSummary}`);
        }

        const elemSummary = ctx.elements.slice(0, 30).map((e) => {
          const p = [e.tag];
          if (e.text) p.push(`"${(e.text || '').slice(0, 40)}"`);
          if (e.id) p.push(`#${e.id}`);
          if (e.type) p.push(`type=${e.type}`);
          return p.join(' ');
        }).join('\n');
        parts.push(`\nELEMENTS:\n${elemSummary}`);

        return [{ type: 'text', text: parts.join('\n') }];
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
        if (tabs.length === 0) return [{ type: 'text', text: 'No open tabs found.' }];
        const tabList = tabs.map((t, i) => `  [${i}] ${t.title} — ${t.url.slice(0, 100)}`).join('\n');
        return [{ type: 'text', text: `Open tabs (${tabs.length}):\n${tabList}\n\nUse switch_tab to switch.` }];
      }

      case 'switch_tab': {
        const pattern = input.url || input.text || input.value || '';
        if (!pattern) return [{ type: 'text', text: 'switch_tab requires a url or text pattern.' }];
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
  // API call
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

    // ALWAYS keep the first user message (the original goal/task)
    const firstUserMsg = this.history.find(m => m.role === 'user');

    // Keep the most recent messages
    const recentMessages = this.history.slice(-(MAX_HISTORY - 1));

    // If the first user message is already in recent messages, just return recent
    if (recentMessages.includes(firstUserMsg)) {
      this.history = recentMessages;
      return;
    }

    // Otherwise prepend the first user message so the agent never forgets the goal
    this.history = [firstUserMsg, ...recentMessages];
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
        if (a === 'switch_tab') return `Switching tab...`;
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
    this._currentModel = MODEL_DEFAULT;
    this._retryCount = 0;
    this._lastScreenshotHash = null;
    this._lastContext = null;
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
    } catch (err) {
      console.error('[agent] memory save error:', err.message);
    }
  }

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
