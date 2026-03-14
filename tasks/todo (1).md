# AI Assistant — Build Todo

## Phase 1 — Electron shell
- [ ] package.json with all deps from CLAUDE.md
- [ ] .env.example with ANTHROPIC_API_KEY only
- [ ] electron/main.js — BrowserWindow overlay bottom-right, alwaysOnTop, Cmd+Shift+Space toggle, tray icon, IPC handlers for sendMessage / confirmAction / cancelAction / hide
- [ ] electron/preload.js — contextBridge exposing those IPC calls
- [ ] electron/overlay.html — dark glassmorphism floating UI, mic button (push-to-talk), text input fallback, message bubbles (user right / AI left), action preview card with confirm+cancel buttons, TTS on every AI message
- [ ] Test: npm start, overlay appears bottom-right, hotkey toggles it

## Phase 2 — Voice input (Whisper local)
- [ ] src/voice.js — whisper-node wrapper, transcribe(filePath) async function
- [ ] overlay.html mic button: mousedown → MediaRecorder starts recording, mouseup → stop → save webm to temp file → IPC to main → voice.transcribe() → return text → auto-send to agent
- [ ] First-run model download: show "downloading voice model..." spinner in overlay, speak "downloading my voice model, one sec"
- [ ] Test: hold mic, speak, release, confirm transcript appears and is sent

## Phase 3 — Voice output (TTS)
- [ ] speak(text) function in overlay.html using SpeechSynthesis as shown in CLAUDE.md
- [ ] Called automatically after every AI response
- [ ] Cancel utterance when mic button pressed (onMicStart)
- [ ] Voice selection: prefer Samantha on macOS, any en-US non-Compact otherwise
- [ ] voiceschanged event listener so voices are ready
- [ ] Test: type a message, confirm AI response is spoken aloud

## Phase 4 — Browser control via CDP
- [ ] src/browser.js — full implementation from CLAUDE.md: connectToChrome, getPageContext, cdpClick, cdpClickText, cdpType, cdpNavigate, cdpPressKey, cdpScroll, getCurrentPage
- [ ] main.js: on startup try connectToChrome(), log whether it worked
- [ ] Test: open Chrome with --remote-debugging-port=9222, open Gmail, call getPageContext(), confirm it returns structured element list with email subjects visible

## Phase 5 — Native app control
- [ ] src/screen.js — getAccessibilityTree() via osascript JXA as in CLAUDE.md
- [ ] src/executor.js — nut-js executeAction() handling: click, double_click, right_click, type, key, scroll, drag with 300ms delay after each
- [ ] parseKeys() helper: "cmd+a" → [Key.LeftCmd, Key.A], "Return" → Key.Return, etc.
- [ ] Accessibility permission check on startup — if missing, speak instruction and open System Preferences
- [ ] Test: call getAccessibilityTree() while Finder is open, confirm readable structure returned

## Phase 6 — Claude agent loop
- [ ] src/agent.js — Anthropic SDK, 4 tools as defined in CLAUDE.md (browser_action, native_action, take_screenshot, request_confirmation)
- [ ] runAgentLoop(userText): build context (try CDP first, fall back to accessibility, fall back to screenshot), send to Claude with tools, handle tool_use blocks in loop, return when stop_reason is end_turn
- [ ] browser_action handler: routes to correct browser.js function
- [ ] native_action handler: routes to screen.js + executor.js
- [ ] request_confirmation handler: pushes to action-queue, returns preview to renderer via IPC, PAUSES loop until user confirms or cancels
- [ ] src/action-queue.js: Map<uuid, {action, resolve, reject}>, confirmAction(id) resolves and loop continues, cancelAction(id) rejects
- [ ] Loop iteration limit: 15 max, then stop and tell user via spoken message
- [ ] Wire into main.js IPC: send-message → runAgentLoop, confirm-action → action-queue.confirm, cancel-action → action-queue.cancel
- [ ] Test: say "go to google.com" → confirm Chrome navigates there

## Phase 7 — Memory
- [ ] src/memory.js — better-sqlite3, tables: preferences (key/value), app_patterns (app, pattern, confidence)
- [ ] init() creates tables, get/set, getPatterns(app), recordPattern(app, summary)
- [ ] agent.js: on each call load patterns for current focused app, prepend to system context as "What I know about you: ..."
- [ ] After confirmed action: recordPattern(app, one-line summary of what was done)

## Phase 8 — Polish + end-to-end test
- [ ] Escape key hides overlay
- [ ] Header draggable (-webkit-app-region: drag), buttons no-drag
- [ ] Clear chat button
- [ ] Error states with spoken message: no API key ("I need my API key, add it to the .env file"), no accessibility permission, Chrome not in debug mode ("launch Chrome with the debug flag so I can control it")
- [ ] Full test: voice → flights task → Claude searches Google Flights via CDP → finds options → speaks summary → shows action card → user confirms → done
