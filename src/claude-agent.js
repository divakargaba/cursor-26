// src/claude-agent.js — Computer-use agent with loop detection (ported from OpenClaw)
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_ACTIONS = 12;
const MAX_HISTORY = 20;

// Loop detection thresholds (from OpenClaw's tool-loop-detection.ts)
const LOOP_HISTORY_SIZE = 15;
const LOOP_WARNING_THRESHOLD = 4;
const LOOP_HALT_THRESHOLD = 7;

class ClaudeAgent {
  constructor({ screenshotFn, computer, screenWidth, screenHeight }) {
    this.client = new Anthropic();
    this.history = [];
    this.computer = computer;
    this.screenshotFn = screenshotFn;
    this.screenWidth = screenWidth || 1920;
    this.screenHeight = screenHeight || 1080;
    this.toolCallHistory = []; // for loop detection
  }

  // --- Loop detection (ported from OpenClaw) ---

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

  // --- System prompt & tools ---

  _buildSystemPrompt() {
    return `You are a voice-first AI copilot that controls the user's Windows computer.

Screen: ${this.screenWidth}x${this.screenHeight}px. Coordinates = pixel position in screenshot (1:1).

You have smart tools — USE THEM:
- run_command: ALWAYS use this to open apps (e.g. "notepad.exe", "start chrome https://docs.google.com"). NEVER click through Start menu or taskbar to open things.
- get_ui_elements: Returns interactive elements (buttons, text fields) in the focused window with their CENTER coordinates. Use this BEFORE clicking blindly.
- type_text: Types into the currently focused field. Click the field first if needed.
- list_windows: See what's already open.

Strategy for tasks:
1. Use run_command to open apps directly
2. Use get_ui_elements to find exact element positions
3. Click/type using the coordinates from get_ui_elements
4. Take a screenshot to verify the result

Rules:
- Short replies (2-4 sentences). Voice-first.
- A screenshot is ALREADY attached — jump straight to actions.
- Auto-screenshot comes after your last action each round.
- Chain multiple actions in ONE response. Minimize round-trips.
- If something doesn't work, try a DIFFERENT approach. Never repeat the same action.
- BEFORE send/submit/delete/purchase: STOP and ask the user.
- ALWAYS respond with text when done. Tell the user what happened.
- If stuck, say so immediately.`;
  }

  _getTools() {
    return [
      {
        name: 'screenshot',
        description: 'Take a screenshot of the entire screen. A screenshot is already included with the user message, so only call this to re-check the screen after actions or waiting.',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'left_click',
        description: 'Left-click at the given screen coordinates. Use for clicking buttons, links, text fields, etc.',
        input_schema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X pixel coordinate' },
            y: { type: 'number', description: 'Y pixel coordinate' },
          },
          required: ['x', 'y'],
        },
      },
      {
        name: 'right_click',
        description: 'Right-click at the given screen coordinates. Use for context menus.',
        input_schema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X pixel coordinate' },
            y: { type: 'number', description: 'Y pixel coordinate' },
          },
          required: ['x', 'y'],
        },
      },
      {
        name: 'double_click',
        description: 'Double-click at the given screen coordinates. Use for opening files, selecting words, etc.',
        input_schema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X pixel coordinate' },
            y: { type: 'number', description: 'Y pixel coordinate' },
          },
          required: ['x', 'y'],
        },
      },
      {
        name: 'type_text',
        description: 'Type text into the currently focused input field. Click the field first if needed.',
        input_schema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text to type' },
          },
          required: ['text'],
        },
      },
      {
        name: 'press_key',
        description: 'Press a keyboard shortcut or key. Use modifier+key format: "ctrl+c", "ctrl+v", "alt+tab", "ctrl+shift+s", "enter", "tab", "escape", "backspace", "delete", "up", "down", "left", "right", "f5", "space", etc.',
        input_schema: {
          type: 'object',
          properties: {
            keys: { type: 'string', description: 'Key or shortcut to press (e.g. "ctrl+c", "enter", "alt+f4")' },
          },
          required: ['keys'],
        },
      },
      {
        name: 'scroll',
        description: 'Scroll the mouse wheel at the given coordinates.',
        input_schema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X pixel coordinate to scroll at' },
            y: { type: 'number', description: 'Y pixel coordinate to scroll at' },
            direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
            amount: { type: 'number', description: 'Number of scroll clicks (default 3)' },
          },
          required: ['x', 'y', 'direction'],
        },
      },
      {
        name: 'mouse_move',
        description: 'Move the mouse cursor to the given coordinates without clicking.',
        input_schema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X pixel coordinate' },
            y: { type: 'number', description: 'Y pixel coordinate' },
          },
          required: ['x', 'y'],
        },
      },
      {
        name: 'drag',
        description: 'Click and drag from one point to another.',
        input_schema: {
          type: 'object',
          properties: {
            start_x: { type: 'number', description: 'Start X coordinate' },
            start_y: { type: 'number', description: 'Start Y coordinate' },
            end_x: { type: 'number', description: 'End X coordinate' },
            end_y: { type: 'number', description: 'End Y coordinate' },
          },
          required: ['start_x', 'start_y', 'end_x', 'end_y'],
        },
      },
      {
        name: 'run_command',
        description: 'Run a shell command. Use this to open apps (notepad.exe, calc.exe, start chrome, start msedge https://url), run scripts, or execute system commands. ALWAYS prefer this over clicking UI to launch applications.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to run' },
          },
          required: ['command'],
        },
      },
      {
        name: 'list_windows',
        description: 'List all visible windows with their titles and process names. Use to check what apps are already open.',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_ui_elements',
        description: 'Get interactive elements (buttons, text fields, menus, tabs, etc.) from the currently focused window using Windows UI Automation. Returns element names, types, and CENTER coordinates. Use this to find exact click targets instead of guessing from screenshots.',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ];
  }

  // --- Main loop ---

  async chat(text, onProgress) {
    this._onProgress = onProgress || (() => {});
    this._onProgress({ type: 'status', text: 'Taking screenshot...' });

    const screenshot = await this.screenshotFn();

    const content = [{ type: 'text', text }];
    if (screenshot.ok) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: screenshot.mediaType || 'image/png', data: screenshot.data },
      });
    }

    const historyLenBefore = this.history.length;
    this.history.push({ role: 'user', content });
    this._trimHistory();
    this._resetLoopDetection();

    this._onProgress({ type: 'status', text: 'Thinking...' });

    try {
      return await this._runLoop();
    } catch (err) {
      this.history.length = historyLenBefore;
      throw err;
    }
  }

  async _runLoop() {
    let actions = 0;

    while (actions < MAX_ACTIONS) {
      const response = await this._callAPI();
      this.history.push({ role: 'assistant', content: response.content });

      const textParts = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text);

      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      // No tools — return text
      if (toolUses.length === 0) {
        return { text: textParts.join('\n') || 'Done.', actionPreview: null };
      }

      // Send any intermediate text to the UI immediately
      if (textParts.length > 0 && textParts.join('').trim()) {
        this._onProgress({ type: 'text', text: textParts.join('\n') });
      }

      // Execute each tool with loop detection
      const toolResults = [];
      let halted = false;

      for (let i = 0; i < toolUses.length; i++) {
        const tu = toolUses[i];
        const isLast = i === toolUses.length - 1;
        actions++;

        // Show what we're doing
        const actionLabel = tu.name === 'screenshot' ? 'Looking at screen...'
          : tu.name === 'left_click' ? `Clicking (${Math.round(tu.input.x || 0)}, ${Math.round(tu.input.y || 0)})...`
          : tu.name === 'type_text' ? `Typing "${(tu.input.text || '').slice(0, 30)}"...`
          : tu.name === 'press_key' ? `Pressing ${tu.input.keys}...`
          : tu.name === 'scroll' ? `Scrolling ${tu.input.direction}...`
          : tu.name === 'run_command' ? `Running: ${(tu.input.command || '').slice(0, 40)}...`
          : tu.name === 'list_windows' ? 'Checking open windows...'
          : tu.name === 'get_ui_elements' ? 'Reading UI elements...'
          : `${tu.name}...`;
        this._onProgress({ type: 'status', text: actionLabel });

        // Check for loops BEFORE executing (like OpenClaw does)
        const loopCheck = this._detectLoop(tu.name, tu.input);

        if (loopCheck.stuck && loopCheck.level === 'critical') {
          // Circuit breaker — don't execute, inject stop message
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: [{ type: 'text', text: loopCheck.message }],
            is_error: true,
          });
          halted = true;
          break;
        }

        // Record the call
        this._recordToolCall(tu.name, tu.input);

        // Execute the tool
        const result = await this._executeTool(tu.name, tu.input, isLast);

        // If warning level, prepend the warning to the result
        if (loopCheck.stuck && loopCheck.level === 'warning') {
          result.unshift({ type: 'text', text: loopCheck.message });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result,
        });
      }

      // Push remaining tool_results for any tools we didn't execute (after halt)
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
      this._onProgress({ type: 'status', text: 'Thinking...' });

      // If Claude said end_turn or we halted, stop
      if (response.stop_reason === 'end_turn' || halted) {
        // One more API call so Claude can respond to the halt/results
        if (halted) {
          const finalResponse = await this._callAPI();
          this.history.push({ role: 'assistant', content: finalResponse.content });
          const finalText = finalResponse.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          return { text: finalText || "I got stuck in a loop. Let me know what to try differently.", actionPreview: null };
        }
        return { text: textParts.join('\n') || 'Done.', actionPreview: null };
      }
    }

    return {
      text: "Hit the action limit. Let me know if you'd like me to keep going.",
      actionPreview: null,
    };
  }

  async _executeTool(name, input, autoScreenshot = true) {
    try {
      switch (name) {
        case 'screenshot': {
          const ss = await this.screenshotFn();
          if (ss.ok) {
            return [
              { type: 'image', source: { type: 'base64', media_type: ss.mediaType || 'image/png', data: ss.data } },
            ];
          }
          return [{ type: 'text', text: 'Screenshot failed: ' + (ss.error || 'unknown') }];
        }

        case 'left_click':
          await this.computer.leftClick(input.x, input.y);
          break;

        case 'right_click':
          await this.computer.rightClick(input.x, input.y);
          break;

        case 'double_click':
          await this.computer.doubleClick(input.x, input.y);
          break;

        case 'type_text':
          await this.computer.type(input.text);
          break;

        case 'press_key':
          await this.computer.key(input.keys);
          break;

        case 'scroll':
          await this.computer.scroll(input.x, input.y, input.direction, input.amount || 3);
          break;

        case 'mouse_move':
          await this.computer.mouseMove(input.x, input.y);
          break;

        case 'drag':
          await this.computer.leftClickDrag(input.start_x, input.start_y, input.end_x, input.end_y);
          break;

        case 'run_command': {
          const cmdResult = await this.computer.runCommand(input.command);
          const parts = [];
          if (cmdResult.stdout) parts.push(`stdout: ${cmdResult.stdout}`);
          if (cmdResult.stderr) parts.push(`stderr: ${cmdResult.stderr}`);
          if (cmdResult.error) parts.push(`error: ${cmdResult.error}`);
          return [{ type: 'text', text: parts.join('\n') || (cmdResult.ok ? 'Command executed.' : 'Command failed.') }];
        }

        case 'list_windows': {
          const windows = await this.computer.listWindows();
          const summary = windows.map((w) => `[${w.ProcessName}] ${w.MainWindowTitle}`).join('\n');
          return [{ type: 'text', text: summary || 'No visible windows found.' }];
        }

        case 'get_ui_elements': {
          const uiInfo = await this.computer.getUIElements();
          const header = `Window: ${uiInfo.window}\nElements (${(uiInfo.elements || []).length}):`;
          const rows = (uiInfo.elements || []).map((e) =>
            `  [${e.type}] "${e.name}" at (${e.x}, ${e.y}) ${e.w}x${e.h}`
          );
          return [{ type: 'text', text: header + '\n' + rows.join('\n') }];
        }

        default:
          return [{ type: 'text', text: `Unknown tool: ${name}` }];
      }

      // Only screenshot after the LAST tool in a batch
      if (autoScreenshot) {
        await new Promise((r) => setTimeout(r, 80));
        const ss = await this.screenshotFn();
        if (ss.ok) {
          return [
            { type: 'image', source: { type: 'base64', media_type: ss.mediaType || 'image/png', data: ss.data } },
          ];
        }
      }
      return [{ type: 'text', text: 'OK' }];
    } catch (err) {
      return [{ type: 'text', text: `Error: ${err.message}` }];
    }
  }

  _callAPI() {
    return this.client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: this._buildSystemPrompt(),
      tools: this._getTools(),
      messages: this.history,
    });
  }

  _trimHistory() {
    if (this.history.length <= MAX_HISTORY) return;

    // Find a clean cut point — must start with a regular user message,
    // NOT a user message containing tool_results (which needs a preceding assistant tool_use)
    const earliest = this.history.length - MAX_HISTORY;
    for (let i = earliest; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role === 'user' && Array.isArray(msg.content) &&
          !msg.content.some((c) => c.type === 'tool_result')) {
        this.history = this.history.slice(i);
        return;
      }
    }
    // No clean cut found — drop everything except last 4 messages
    this.history = this.history.slice(-4);
  }

  clearHistory() {
    this.history = [];
    this.toolCallHistory = [];
  }
}

module.exports = ClaudeAgent;
