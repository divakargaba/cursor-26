# AI Assistant — How to build this with Claude Code

## What OpenClaw actually does (and why it matters)
OpenClaw is NOT a computer control tool — it's a messaging-app agent (Telegram, WhatsApp, Discord).
But the KEY thing they do for browser control is what we're stealing: Chrome DevTools Protocol (CDP).
CDP lets Playwright connect directly to Chrome and control it like a human — click elements, read DOM, navigate, type — all in ~10ms with no images or vision needed at all.
That's why screenshot-based tools feel slow — CDP is the fix.

## Full architecture
```
User speaks
  → whisper.cpp (local, free, ~300ms)
    → Claude agent (with tools)
      → browser_action: Playwright CDP → Chrome directly (Tier 1, always try first)
      → native_action: JXA accessibility tree + nut-js mouse/keyboard (Tier 2, native apps)
      → take_screenshot: Claude vision (Tier 3, last resort only)
        → executor fires actions on real OS
          → AI speaks response back (Web Speech SpeechSynthesis, free, built-in)
```

## Prerequisites
- Claude Code installed
- Node.js 18+
- macOS (accessibility + CDP instructions are macOS — Windows works too, adjust JXA → PowerShell)
- Anthropic API key

---

## Setup

```bash
mkdir ai-assistant && cd ai-assistant
mkdir tasks

# Place files:
# CLAUDE.md     → ai-assistant/CLAUDE.md
# todo.md       → ai-assistant/tasks/todo.md
# lessons.md    → ai-assistant/tasks/lessons.md

echo "ANTHROPIC_API_KEY=your-key-here" > .env

# Launch Chrome with debug port (do this once, keep it running)
open -a "Google Chrome" --args --remote-debugging-port=9222

claude
```

---

## First prompt — paste this exactly

```
Read CLAUDE.md and tasks/todo.md.

First clone these reference repos to study the patterns:
git clone https://github.com/anthropics/anthropic-quickstarts reference/computer-use
git clone https://github.com/openclaw/openclaw reference/openclaw

In reference/computer-use: study the computer_use action loop — how tool_use blocks are processed, how screenshots are fed back as tool_result, how the loop knows when to stop.
In reference/openclaw: study how they do browser control — look for CDP/Playwright usage, how they route tasks to tools, how the skill system works.

Then delete reference/ and enter plan mode.
Build Phase 1 only as defined in tasks/todo.md: Electron shell with overlay, hotkey, tray.
Run npm install && npm start, confirm the overlay appears and Cmd+Shift+Space toggles it.
Mark Phase 1 done in tasks/todo.md.
```

---

## Phase 2 prompt

```
Phase 1 done. Build Phase 2 and 3 together — voice in and voice out.

src/voice.js: whisper-node wrapper as in CLAUDE.md. Handle first-run model download gracefully.
overlay.html mic button: push-to-talk with MediaRecorder → temp webm file → IPC to main → transcribe → auto-send.
TTS: speak() function using SpeechSynthesis exactly as in CLAUDE.md. Called on every AI response. Cancel when mic pressed.
Voice selection: prefer Samantha on macOS, fallback to first en-US non-Compact voice.

Test: hold mic, say "hello", release. Confirm the word "hello" appears as the message AND Claude responds AND the response is spoken aloud.
Mark Phase 2 and 3 done.
```

---

## Phase 3 prompt (CDP browser control)

```
Build Phase 4 — CDP browser control.

src/browser.js: full implementation from CLAUDE.md. connectToChrome, getPageContext, all the cdp action functions.

Chrome should already be running with --remote-debugging-port=9222.

After building: write a test script test-browser.js that:
1. Calls connectToChrome()
2. Calls getPageContext()
3. Logs the result

Run it: node test-browser.js
Confirm it returns a structured list of elements from whatever page is open in Chrome.
Mark Phase 4 done.
```

---

## Phase 4 prompt (native app control)

```
Build Phase 5 — native app control via accessibility + nut-js.

src/screen.js: getAccessibilityTree() via osascript JXA as in CLAUDE.md.
src/executor.js: executeAction() with nut-js handling all action types, 300ms delay, parseKeys() helper.
Accessibility permission check on startup in main.js — if not granted speak the instruction and open System Preferences.

Test: write test-screen.js that calls getAccessibilityTree() while Finder is open and logs the result.
Run it: node test-screen.js
Mark Phase 5 done.
```

---

## Phase 5 prompt (the agent — most important)

```
Build Phase 6 — the Claude agent loop. This is the core.

src/agent.js:
- 4 tools exactly as defined in CLAUDE.md: browser_action, native_action, take_screenshot, request_confirmation
- runAgentLoop(userText): 
  1. Build screen context: try CDP getPageContext first, if null try getAccessibilityTree, if null take screenshot
  2. Send to claude-opus-4-5 or claude-sonnet-4-20250514 with tools and system prompt from CLAUDE.md
  3. Loop: process tool_use blocks → execute → continue
  4. request_confirmation pauses the loop — push to action-queue, send IPC preview to renderer, await user confirm/cancel
  5. Stop at 15 iterations max, speak "I'm stuck, what should I do?" to user
  6. On end_turn: return final text to renderer, renderer calls speak()

src/action-queue.js: Promise-based pending action map as described.

Wire into main.js IPC.

Test: with Chrome open on google.com, type "what's on screen" — confirm Claude reads the page and speaks a summary.
Then test: "search for flights from Calgary to Cairo" — confirm Claude navigates Google Flights and speaks about what it finds.
Mark Phase 6 done.
```

---

## Phase 6 prompt (memory + polish)

```
Build Phase 7 (memory) and Phase 8 (polish) from tasks/todo.md.

Memory: better-sqlite3 as specified. Hook into agent so it loads patterns per app and records after confirmed actions.

Polish: Escape to hide, draggable header, clear chat, all error states with spoken messages as specified.

Then full end-to-end test:
1. Open Chrome with debug port, open Gmail
2. Activate overlay (Cmd+Shift+Space)
3. Hold mic, say "do I have any new emails"
4. Confirm: Claude reads Gmail via CDP and speaks a summary of the inbox
5. Say "reply to the first one just say thanks got it"
6. Confirm: Claude drafts a reply, speaks what it wrote, shows action card
7. Say "send it"
8. Confirm: Claude clicks Send

Write results in tasks/todo.md.
```

---

## Parallel worktrees (after Phase 4 works)

```bash
# Terminal 1 — main thread building agent
claude

# Terminal 2 — harden CDP browser control in isolation
git worktree add .worktrees/browser main
cd .worktrees/browser
claude
# Prompt: "Read CLAUDE.md. Work only on src/browser.js.
# Handle these edge cases: Chrome not running (graceful null), tab switches mid-task (getCurrentPage before every action), iframes (try page.frameLocator), popups/new tabs (listen for page events on context).
# Test all cases."

# Terminal 3 — tune voice pipeline
git worktree add .worktrees/voice main
cd .worktrees/voice  
claude
# Prompt: "Read CLAUDE.md. Work only on src/voice.js and the mic button in overlay.html.
# Add: silence detection so it auto-stops after 2s of silence instead of needing button release.
# Add: noise threshold so it doesn't transcribe if audio level is below threshold.
# Test both."
```

---

## macOS permissions (tell user on first run, Claude handles this in startup sequence)

1. Accessibility — System Preferences → Privacy & Security → Accessibility → add your app
2. Screen Recording — System Preferences → Privacy & Security → Screen Recording → add your app  
3. Microphone — auto-prompted by macOS on first voice use

---

## Troubleshooting

CDP returns null → Chrome not running with --remote-debugging-port=9222. Run: `open -a "Google Chrome" --args --remote-debugging-port=9222`

nut-js actions do nothing → Accessibility permission not granted. Check System Preferences.

Screenshot black → Screen Recording permission not granted.

whisper-node crashes → Run `npm rebuild` in project root. May need: `npm install -g node-gyp` first.

Voice not speaking → SpeechSynthesis voices not loaded yet. Make sure speak() is called after voiceschanged fires.

Agent loop never ends → Hit 15-iteration limit or Claude is confused. Check tasks/lessons.md and add a rule to CLAUDE.md for that case.

Hotkey not working → Another app owns Cmd+Shift+Space. Change to Cmd+Shift+A in electron/main.js.
