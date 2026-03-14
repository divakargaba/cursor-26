# AI Assistant — Root Agent Instructions

## What you are building
A voice-first AI copilot that floats over the user's screen as an Electron overlay.
The user speaks (or types), Claude understands context, and executes tasks WITH the user watching.
NOT autonomous — always preview before any write/send/delete action.

## Core philosophy
- User directs. AI executes the tedious parts.
- Short responses only (2-4 sentences). This is voice-first.
- Ask ONE clarifying question max, but start working at the same time.
- Always flag risks the user didn't ask about (tight layover, self-transfer, etc).
- Read actions = run immediately. Write/send/delete = always preview first, wait for "do it" / "send it" / "yes".

## Architecture (build in this exact order)
```
1. Electron tray app    → panel window (not alwaysOnTop), global hotkey Ctrl+Shift+Space
2. Voice pipeline       → Web Speech API primary, Whisper API fallback
3. Claude agent         → conversation brain, tool router, context manager
4. Chrome extension     → DOM reader, sends structured data over local WebSocket port 3847
5. Integrations         → Gmail MCP, Supabase REST, SerpAPI flights, Excel file parser
6. Memory layer         → SQLite, stores user preferences/patterns per app
7. Action executor      → preview card UI, confirm → fire
```

## Repo structure to create
```
ai-assistant/
├── CLAUDE.md                   ← this file
├── package.json
├── .env.example
├── tasks/
│   ├── todo.md                 ← update as you build
│   └── lessons.md              ← update after every correction
├── electron/
│   ├── main.js                 ← app lifecycle, menubar tray, hotkey, IPC, screenshot capture
│   ├── preload.js              ← contextBridge IPC surface only
│   └── panel.html              ← tray panel UI (orb + chat + input, not alwaysOnTop)
├── src/
│   ├── claude-agent.js         ← Anthropic SDK, multi-turn history, tool routing
│   ├── voice.js                ← Web Speech API + Whisper fallback
│   ├── ws-server.js            ← local WebSocket server for Chrome ext
│   ├── executor.js             ← action queue, preview, confirm, fire
│   ├── memory.js               ← better-sqlite3, user patterns
│   └── integrations/
│       ├── gmail.js            ← Gmail via Claude MCP (GMAIL_MCP_URL env var)
│       ├── supabase.js         ← Supabase REST API direct
│       ├── flights.js          ← SerpAPI google_flights engine
│       └── excel.js            ← xlsx npm package, read/write .xlsx files
└── extension/
    ├── manifest.json           ← Chrome MV3
    ├── content.js              ← DOM scraper, sends to WS
    └── background.js           ← service worker, WS connection manager
```

## Environment variables
```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SERPAPI_KEY=
GMAIL_MCP_URL=https://gmail.mcp.claude.com/mcp
```

## Package dependencies to use
```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "better-sqlite3": "^9.4.3",
    "dotenv": "^16.4.5",
    "ws": "^8.16.0",
    "xlsx": "^0.18.5",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "electron": "^29.1.0"
  }
}
```

## Claude system prompt to use in claude-agent.js
```
You are a voice-first AI copilot for someone who is tired and wants to direct tasks without doing the tedious work.

Rules:
- Talk like a smart friend, not a chatbot. Short. Warm. Zero fluff.
- You work WITH the user — they lead, you execute.
- Max 2-4 sentences per response. This is voice.
- Ask ONE clarifying question at a time, but START the task simultaneously.
- Proactively flag things they didn't ask about but need to know.
- For any write/send/delete action: return a structured action_preview object, never execute directly.
- For read/search actions: execute immediately, report findings conversationally.
- Learn from corrections — if user edits your output, note the pattern.

Action preview format (return as JSON tool call):
{
  "action_id": "uuid",
  "type": "gmail_send" | "supabase_query" | "supabase_mutate" | "flight_search" | "excel_write",
  "summary": "one sentence of what this will do",
  "payload": { ... action-specific data ... },
  "risks": ["optional array of things to flag"]
}
```

## Integration-specific rules (enforce these always)

### Gmail
- Always CC existing thread participants unless user explicitly says not to
- Match the tone of existing thread (formal/casual)
- Include user's signature if stored in memory
- Draft first, user clicks send — NEVER send without confirmation

### Supabase
- Always show the exact SQL or REST call before executing
- NEVER run DELETE or UPDATE without showing affected row count first
- Read operations (SELECT) are fine to run immediately

### Flights (SerpAPI)
- Always check +-2 days around requested date unless user specifies exact
- Flag: any layover under 90 minutes
- Flag: self-transfer (different airline, must re-check bags)
- Flag: overnight layover if user seems unaware
- Present max 3 options with clear tradeoff summary

### Excel
- Read existing sheet structure before proposing any formula
- Show formula in preview before writing
- Never overwrite existing data without confirmation

## Self-improvement loop (DO THIS after every session)
After any user correction, append to tasks/lessons.md:
```
[DATE] [INTEGRATION] What went wrong → What rule prevents it next time
```
Then add a rule to this CLAUDE.md under the relevant integration section.

## Known good code patterns

### WebSocket DOM message format (from extension → Electron)
```json
{
  "type": "dom-update",
  "url": "https://mail.google.com/...",
  "title": "Inbox - Gmail",
  "appType": "gmail",
  "data": {
    "gmail": { "openThread": {...}, "draftContent": "..." },
    "supabase": { "activeTable": "...", "visibleRows": [...] },
    "generic": { "textContent": "...", "forms": [...], "buttons": [...] }
  }
}
```

### IPC pattern (renderer → main → back)
```js
// renderer calls:
const result = await window.ai-assistant.sendMessage(text, needsScreenshot)
// result is: { ok: true, reply: { text, actionPreview? } }
// if actionPreview exists, render confirm card
// user clicks confirm → window.ai-assistant.executeAction(actionPreview.action_id)
```

### Screenshot only when needed
Only request screenshot when:
1. DOM context is null (extension not installed)
2. User is in a native desktop app (not browser)
3. User explicitly says "look at my screen"
Never take continuous screenshots — only on-demand per message.
