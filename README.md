# How to build AI Assistant with Claude Code

## Prerequisites
- Claude Code installed (`npm install -g @anthropic/claude-code` or via https://claude.ai/code)
- Node.js 18+
- Chrome browser
- API keys: Anthropic (required), SerpAPI (free tier fine)

---

## Step 1 — Set up the repo and open Claude Code

```bash
mkdir ai-assistant && cd ai-assistant
# Copy CLAUDE.md, tasks/todo.md, tasks/lessons.md into this folder
# (the three files you were given)
claude  # opens Claude Code in this directory
```

Claude Code will read CLAUDE.md automatically on startup.

---

## Step 2 — First prompt (Phase 1 — Shell)

Paste this exactly:

```
Read CLAUDE.md and tasks/todo.md. 

Enter plan mode. Build Phase 1 only — the Electron shell. I want:
- package.json with the exact deps from CLAUDE.md
- .env.example with all required vars
- electron/main.js — overlay window bottom-right, alwaysOnTop, globalShortcut Cmd+Shift+Space to toggle
- electron/preload.js — contextBridge exactly as specified in CLAUDE.md IPC pattern
- electron/overlay.html — dark glassmorphism UI, mic button, text input, message bubbles, action preview card component

When done, run `npm install && npm start` and confirm the overlay appears and hotkey works.
Mark Phase 1 items complete in tasks/todo.md.
```

---

## Step 3 — Voice (Phase 2)

```
Build Phase 2 — voice pipeline.

src/voice.js needs:
- VoicePipeline class
- Primary: Web Speech API (webkitSpeechRecognition), start(), stop(), onResult callback, onInterim callback for live transcript
- Fallback: if Web Speech unavailable, record with MediaRecorder as audio/webm, POST to Whisper API endpoint https://api.openai.com/v1/audio/transcriptions with model whisper-1 (use OPENAI_API_KEY env var, add to .env.example)
- Wire into overlay.html: mic button click → voice.start(), button turns red + pulses, interim text shows in input box greyed out, final transcript replaces it, auto-submits after 1.5s silence

Test it: open the overlay, click mic, speak, confirm transcript appears.
Mark Phase 2 done in tasks/todo.md.
```

---

## Step 4 — Claude agent (Phase 3)

```
Build Phase 3 — Claude agent.

src/claude-agent.js:
- Use @anthropic-ai/sdk
- System prompt exactly as written in CLAUDE.md under "Claude system prompt to use"
- Maintain messages array, max 10 turns (slice oldest when over)
- Define tools: gmail_draft, supabase_select, supabase_mutate, flight_search, excel_read, excel_write, capture_screenshot
- chat(userText, domContext, screenshotBase64) method:
  - Appends user message
  - Calls claude-sonnet-4-20250514 with tools
  - If tool_use block returned: store as pending action with uuid, return { text, actionPreview: { action_id, type, summary, payload, risks } }
  - If just text: return { text }
- executeConfirmedAction(actionId): looks up pending action map, calls the right integration file, returns result string
- Wire into electron/main.js IPC handlers send-message and execute-action

Test with: "what flights are there from Calgary to Cairo next week" — confirm it returns an action preview, not a direct answer.
Mark Phase 3 done.
```

---

## Step 5 — Chrome extension (Phase 4)

```
Build Phase 4 — Chrome extension.

extension/manifest.json:
- Manifest V3
- content_scripts matches ["<all_urls>"] 
- background service worker
- permissions: activeTab, scripting, storage

extension/content.js:
- On DOMContentLoaded and on MutationObserver (debounced 500ms):
  - Detect appType: if url includes mail.google.com → "gmail", supabase.com → "supabase", else "generic"
  - Gmail: scrape open thread subject + last 3 messages text + to/from + any open draft
  - Supabase: scrape active table name + first 5 visible row values
  - Generic: scrape visible text, form inputs, button labels (max 2000 chars)
  - Send to background: chrome.runtime.sendMessage({ type: "dom-update", url, title, appType, data })

extension/background.js:
- Connect WebSocket to ws://localhost:3847 on startup
- Reconnect every 3s if disconnected
- On message from content.js: forward over WS as JSON

src/ws-server.js:
- ws package, createWebSocketServer(port) function
- Emits "dom-update" event on the returned EventEmitter when message received from extension

Wire into electron/main.js — store latest domContext, send "dom-context-updated" to renderer with { url, title, appType }.

To test: in Chrome go to chrome://extensions, enable dev mode, load unpacked → select the extension/ folder. Open Gmail. The overlay header pill should show "gmail".
Mark Phase 4 done.
```

---

## Step 6 — Integrations (Phase 5)

```
Build Phase 5 — all four integrations.

src/integrations/gmail.js:
- Uses Anthropic API with mcp_servers: [{ type: "url", url: process.env.GMAIL_MCP_URL, name: "gmail" }]
- Functions: listUnread(), getThread(id), createDraft({ to, subject, body, cc }), sendDraft(draftId)
- createDraft never sends — returns draft object for preview

src/integrations/supabase.js:
- Direct REST calls to process.env.SUPABASE_URL using process.env.SUPABASE_ANON_KEY in Authorization header
- Functions: select(table, filters), insert(table, row), update(table, filters, changes), deleteRow(table, filters)
- deleteRow and update: first run a select to get affected row count, return that in preview before executing

src/integrations/flights.js:
- SerpAPI: GET https://serpapi.com/search?engine=google_flights&departure_id=X&arrival_id=Y&outbound_date=Z&api_key=KEY
- searchFlights({ from, to, date, flexDays: 2 }) — searches date and +-flexDays
- Returns top 3 results with: price, airline, duration, stops, layovers[]
- Flags any: layover < 90min, self-transfer (boolean field in SerpAPI response), overnight layover

src/integrations/excel.js:
- xlsx npm package
- readFile(path) → returns { sheets: [{name, headers, rows}] }
- writeCell(path, sheet, row, col, value) — reads file first, modifies in memory, writes back
- path comes from domContext.data.excel.filePath (content.js should detect if Excel Online is open)

Wire all four into claude-agent.js executeConfirmedAction switch statement.
Mark Phase 5 done.
```

---

## Step 7 — Memory (Phase 6)

```
Build Phase 6 — memory layer.

src/memory.js using better-sqlite3:

Tables:
CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)
CREATE TABLE patterns (app TEXT, pattern TEXT, confidence INTEGER, updated_at INTEGER)  
CREATE TABLE signatures (label TEXT, content TEXT, is_default INTEGER)

Methods:
- init() — create tables if not exist
- get(key) / set(key, value)
- getPatterns(app) — returns patterns for that app sorted by confidence
- recordPattern(app, pattern) — upserts, increments confidence
- getDefaultSignature() / setSignature(label, content, isDefault)

In claude-agent.js chat():
- On every call: const mem = await memory.getPatterns(domContext?.appType) — append to system message as "User patterns: ..."
- After executeConfirmedAction succeeds: call memory.recordPattern(appType, summary of what was confirmed)

Mark Phase 6 done.
```

---

## Step 8 — Final wiring and test

```
We are at Phase 7. Do the polish items:
- Escape key sends IPC hide-overlay
- Header is draggable (-webkit-app-region: drag), buttons are no-drag
- Clear chat button calls agent.clearHistory() and sends clear-chat IPC to renderer
- If ANTHROPIC_API_KEY is missing: show error state in overlay "Add ANTHROPIC_API_KEY to .env"
- If extension not detected after 5s: show yellow pill "extension not connected — install it"
- If mic permission denied: show error "mic blocked — click the lock icon in Chrome address bar"

Then do a full end-to-end test:
1. npm start → overlay appears
2. Cmd+Shift+Space → toggles
3. Click mic → speak "check if I have any emails from Jennifer today" → confirm it queries Gmail and returns a conversational answer
4. Type "find me flights from Calgary to Cairo next week cheapest option" → confirm action preview card appears with 3 flight options and any flagged risks
5. Say "do it" → confirm it executes

Write a summary of what works and what needs more work in tasks/todo.md.
```

---

## Running multiple agents in parallel (advanced — do this after Phase 3 works)

Once the core shell + agent is working, spin up parallel worktrees to build integrations simultaneously:

```bash
# Terminal 1 — main shell (already running)
claude

# Terminal 2 — Gmail integration only
git worktree add .worktrees/gmail main
cd .worktrees/gmail
claude
# First prompt: "Read CLAUDE.md. Build src/integrations/gmail.js only. 
#  Use the Gmail MCP pattern. Write tests in tests/gmail.test.js. 
#  Do not touch any other file."

# Terminal 3 — Supabase + flights integrations
git worktree add .worktrees/integrations main  
cd .worktrees/integrations
claude
# First prompt: "Read CLAUDE.md. Build src/integrations/supabase.js 
#  and src/integrations/flights.js only. Write tests for both."
```

Then merge worktrees back to main when each is done.

---

## Troubleshooting

**Overlay doesn't appear**: Check `npm start` output for "Failed to register global hotkey" — another app may have Cmd+Shift+Space. Change the hotkey in electron/main.js.

**Extension not connecting**: Make sure the Electron app is running first (WS server needs to be up before extension tries to connect). Check chrome://extensions for errors.

**Voice not working**: Web Speech API only works in Chrome and requires HTTPS or localhost. In Electron's BrowserWindow it should work — if not, check that `webSecurity` is not disabled (it shouldn't be).

**Claude not responding**: Check .env has ANTHROPIC_API_KEY. Check DevTools console in overlay (main.js opens DevTools in dev mode).

**SerpAPI flights empty**: Free tier has 100 searches/month. Use https://serpapi.com/playground to test your query params first.
