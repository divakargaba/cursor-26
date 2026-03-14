# AI Assistant — Build Todo

## Phase 1 — Shell (get something running) ✓
- [x] Init repo, package.json, .env.example
- [x] electron/main.js — BrowserWindow, alwaysOnTop, globalShortcut Ctrl+Shift+Space
- [x] electron/preload.js — contextBridge with sendMessage, executeAction, hide, resize
- [x] electron/overlay.html — dark glassmorphism chat UI, mic button, text input, message bubbles, action preview card
- [x] npm start works, overlay appears in bottom-right corner on hotkey

## Phase 2 — Voice ✓
- [x] src/voice.js — Web Speech API class, start/stop, interim results, onResult callback
- [x] Wire voice.js into overlay.html — mic button toggles listening, interim text shows in input box
- [x] Whisper fallback in voice.js — if Web Speech fails or user is on non-Chrome, record via MediaRecorder, POST blob to Whisper API, return transcript
- [x] Voice works end to end: speak → transcript in box → sends to Claude

## Phase 3 — Claude agent ✓
- [x] src/claude-agent.js — Anthropic SDK, conversation history array (last 10 turns), system prompt from CLAUDE.md
- [x] Tool definitions for: gmail_draft, supabase_query, supabase_mutate, flight_search, excel_read, excel_write, take_screenshot
- [x] chat(text, context) method — appends to history, calls API with tools, returns { text, actionPreview? }
- [x] executeConfirmedAction(actionId) — looks up pending action, calls correct integration, returns result
- [x] IPC wired: main.js handles send-message and execute-action, calls agent

## Phase 4 — Chrome extension
- [ ] extension/manifest.json — MV3, content_scripts on all_urls, host_permissions
- [ ] extension/content.js — on page load and on DOM mutation: detect appType (gmail/supabase/generic), scrape relevant data, send to background
- [ ] extension/background.js — maintain WebSocket to ws://localhost:3847, forward DOM data
- [ ] src/ws-server.js — ws package, listen on 3847, emit dom-update events to main process
- [ ] Test: open Gmail in Chrome, DOM context shows in overlay header pill

## Phase 5 — Integrations
- [ ] src/integrations/gmail.js — Claude API call with GMAIL_MCP_URL as mcp_server, draft/send/list/read
- [ ] src/integrations/supabase.js — fetch() against SUPABASE_URL REST API, read and mutate with anon key
- [ ] src/integrations/flights.js — SerpAPI google_flights, parse top 3 results, flag risky itineraries
- [ ] src/integrations/excel.js — xlsx package, read active file path from DOM context, read/write sheets

## Phase 6 — Memory
- [ ] src/memory.js — better-sqlite3, tables: preferences (key/value), patterns (app, pattern, count), signatures (email sig)
- [ ] On every confirmed action success: update memory with what user confirmed/edited
- [ ] Agent reads memory at start of each chat() call, appends to system context

## Phase 3.5 — Tray App Migration (overlay focus fix) ✓
- [x] Replace alwaysOnTop overlay BrowserWindow with menubar tray panel
- [x] Panel is not alwaysOnTop — no focus stealing from target apps
- [x] Orb state indicator (idle/listening/thinking/speaking) with animations
- [x] Auto-close panel after 8s when unfocused (unless pinned or confirmation pending)
- [x] Ctrl+Shift+Space hotkey activates voice (not toggle window)
- [x] Pin button to keep panel open
- [x] Text input field added to panel
- [x] Delete old overlay.html

## Phase 3.6 — macOS Platform Support ✓
Platform abstraction introduced so the app runs on both Windows and macOS.

### Architecture
- `src/computer.js` — Platform dispatcher: detects `process.platform`, requires the right module
- `src/computer.windows.js` — Original Windows implementation (koffi/Win32 DLLs), unchanged
- `src/computer.macos.js` — New macOS implementation (AppleScript + cliclick)
- `src/browser.js` — Now platform-aware for Chrome detection, launch, and window title reading

### macOS — What works
- [x] Mouse: leftClick, rightClick, doubleClick, mouseMove, leftClickDrag (via cliclick)
- [x] Scroll: coarse scroll via AppleScript Page Up/Down key codes
- [x] Keyboard: type(text) via clipboard+Cmd+V paste, key(combo) via AppleScript keystroke/key code
- [x] Clipboard: pbcopy/pbpaste (preserves and restores)
- [x] Window management: focusWindow(pattern) and listWindows() via AppleScript System Events
- [x] getForegroundWindowTitle() via AppleScript
- [x] Chrome CDP: autoConnectOrLaunchChrome() uses `open -na "Google Chrome" --args`, `pgrep` for detection
- [x] Hotkey hint in panel.html shows ⌃⇧Space on Mac, Ctrl+Shift+Space on Windows
- [x] Agent read_screen gives clear macOS-specific guidance when UI elements are unavailable

### macOS — What's stubbed / limited
- [ ] getUIElements() returns empty array with source: 'macos-stub' — no AX API yet
- [ ] Electron app CDP launch (Discord, Spotify, etc.) — only VS Code supported on macOS
- [ ] Right-click and middle-click without cliclick are limited/unsupported
- [ ] Scroll is coarse (Page Up/Down), not smooth pixel scrolling
- [ ] mouseMove without cliclick is a no-op

### External dependencies (macOS)
- **cliclick** (recommended): `brew install cliclick` — provides precise mouse control
  - Without it: left-click works via AppleScript, but right-click/drag/move are unsupported
  - Referenced in: `src/computer.macos.js` (detected at load time)

### Follow-up items
- [ ] Implement macOS Accessibility API (AXUIElement) bindings for getUIElements()
- [ ] Add more Electron app launch commands for macOS (Discord, Slack, Spotify .app paths)
- [ ] Use Quartz CGEvent for smooth scrolling instead of Page Up/Down key codes
- [ ] Investigate node-mac-permissions for accessibility permission prompts

## Phase 7 — Polish
- [ ] tasks/lessons.md gets written after each correction
- [ ] Error states in UI (no mic permission, API key missing, extension not installed)
- [ ] Escape key hides overlay
- [ ] Overlay draggable by header
- [ ] Clear chat button in header
