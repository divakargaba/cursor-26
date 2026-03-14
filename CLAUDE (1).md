# AI Assistant — Agent Instructions

## What this is
A voice-first AI copilot that floats over the user's screen and controls their computer WITH them.
Fully conversational — user speaks, AI speaks back. Like talking to a person sitting next to you.
No app-specific API keys. Just Anthropic API key + computer control.

## Core philosophy
- Fully voice-driven both ways. User speaks → AI speaks back. Always.
- Short spoken responses only. 1-3 sentences. This is a conversation, not a report.
- Work WITH the user. They direct, AI executes the tedious parts.
- Ask ONE clarifying question max, and start the task simultaneously.
- Flag risks the user didn't ask about.
- Read/navigate actions: run immediately. Send/delete/submit: STOP, describe what you're about to do, wait for "yeah do it".

## How it controls the computer (speed-ranked, use in order)

### Tier 1 — CDP (Chrome DevTools Protocol) — use for ANYTHING in a browser
- Playwright connects to the user's running Chrome via --remote-debugging-port=9222
- Can read full DOM as structured text, click by CSS selector, type into fields, navigate URLs
- Takes 5-20ms. No images. No vision. Just direct browser control.
- Covers: Gmail, Google Flights, Supabase web dashboard, any website, Excel Online, etc.
- User launches Chrome once with: open -a "Google Chrome" --args --remote-debugging-port=9222
- Playwright auto-connects on startup

### Tier 2 — Accessibility API — use for native desktop apps
- macOS: osascript JXA reads full UI element tree of any native app in ~10ms as structured text
- Windows: UI Automation via PowerShell
- Covers: native Excel, Finder, native mail clients, any non-browser app

### Tier 3 — Screenshot + Claude vision — LAST RESORT ONLY
- Only when Tier 1 and Tier 2 both fail (canvas apps, games, weird Electron apps)
- Capture ONCE, get multiple actions back from Claude, then capture again. Never per-action.
- Uses Electron desktopCapturer or node-screenshots

## Voice — BOTH directions

### Input (user → AI)
- whisper-node (local whisper.cpp) — free, ~300ms, runs on device, no API
- Push-to-talk: hold mic button or hold a hotkey
- MediaRecorder → saves webm → whisper transcribes → sends to agent
- First run downloads base.en model (~150MB), then instant forever after

### Output (AI → user) — AI ALWAYS SPEAKS BACK
- Web Speech API SpeechSynthesis — built into Electron's Chromium, completely free, zero latency
- window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
- Pick voice: prefer "Samantha" on macOS, any en-US non-Compact voice otherwise
- Speak EVERY AI response automatically — user should never need to read anything
- If user starts speaking: cancel current utterance immediately
- Do NOT read out action card details — just say "check this out" or "take a look"
- Keep spoken text under 150 chars before natural pause — long utterances sound robotic

## Repo structure
```
ai-assistant/
├── CLAUDE.md
├── package.json
├── .env.example
├── tasks/
│   ├── todo.md
│   └── lessons.md
├── electron/
│   ├── main.js          — BrowserWindow overlay, Cmd+Shift+Space hotkey, tray, IPC
│   ├── preload.js       — contextBridge: sendMessage, confirmAction, cancelAction, hide
│   └── overlay.html     — chat UI, mic button, TTS, message bubbles, action preview card
├── src/
│   ├── agent.js         — Claude API, tool routing, 20-turn history, action loop
│   ├── voice.js         — whisper-node transcription wrapper
│   ├── browser.js       — Playwright CDP: connect, getPageContext, click, type, navigate
│   ├── screen.js        — macOS JXA accessibility tree + screenshot fallback
│   ├── executor.js      — nut-js mouse/keyboard for native apps
│   ├── memory.js        — better-sqlite3: preferences, learned patterns
│   └── action-queue.js  — pending destructive actions map, confirm/cancel
└── reference/           — clone these and READ them before building, delete after
    ├── computer-use/    — Anthropic computer use demo: study the action loop pattern
    └── openclaw/        — OpenClaw: study CDP browser control + skill/tool routing system
```

## Dependencies
```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "playwright": "^1.42.0",
    "@nut-tree/nut-js": "^4.2.0",
    "whisper-node": "^1.1.0",
    "better-sqlite3": "^9.4.3",
    "dotenv": "^16.4.5",
    "node-screenshots": "^0.1.1",
    "active-win": "^8.1.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "electron": "^29.1.0"
  }
}
```

## The only env var needed
```
ANTHROPIC_API_KEY=sk-ant-...
```

## CDP browser control — src/browser.js
```js
const { chromium } = require('playwright')
let browser = null, page = null

async function connectToChrome() {
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222')
    const pages = browser.contexts()[0]?.pages() || []
    page = pages[pages.length - 1]
    return !!page
  } catch(e) { return false }
}

async function getPageContext() {
  if (!page) return null
  await getCurrentPage()
  const url = page.url()
  const title = await page.title()
  const structure = await page.evaluate(() => {
    const els = document.querySelectorAll('input,textarea,button,a,select,[role="button"],[role="link"],h1,h2,h3,p,td,th,label,[aria-label]')
    const result = []
    els.forEach(el => {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return
      result.push({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 150),
        id: el.id || '',
        role: el.getAttribute('role') || '',
        type: el.getAttribute('type') || '',
        href: el.href || '',
      })
    })
    return result.slice(0, 150)
  })
  return { url, title, elements: structure }
}

async function getCurrentPage() {
  if (!browser) return null
  const pages = browser.contexts()[0]?.pages() || []
  page = pages[pages.length - 1]
  return page
}

async function cdpClick(selector) { await page.click(selector, { timeout: 5000 }) }
async function cdpClickText(text) { await page.getByText(text).first().click({ timeout: 5000 }) }
async function cdpType(selector, text) { await page.fill(selector, text) }
async function cdpNavigate(url) { await page.goto(url, { waitUntil: 'domcontentloaded' }) }
async function cdpPressKey(key) { await page.keyboard.press(key) }
async function cdpScroll(direction) { await page.mouse.wheel(0, direction === 'down' ? 400 : -400) }

module.exports = { connectToChrome, getPageContext, getCurrentPage, cdpClick, cdpClickText, cdpType, cdpNavigate, cdpPressKey, cdpScroll }
```

## Accessibility tree — src/screen.js (macOS)
```js
const { execSync } = require('child_process')

function getAccessibilityTree() {
  const script = `
    const se = Application('System Events')
    const front = se.applicationProcesses.whose({frontmost:true})[0]
    if (!front.windows.length) return JSON.stringify(null)
    const win = front.windows[0]
    function collect(el, depth) {
      if (depth > 5) return null
      try {
        const node = { role: el.role(), title: el.title?.() || '', value: String(el.value?.() || '').slice(0,100) }
        const kids = (el.uiElements?.() || []).slice(0,15).map(k => collect(k, depth+1)).filter(Boolean)
        if (kids.length) node.children = kids
        return node
      } catch(e) { return null }
    }
    JSON.stringify(collect(win, 0))
  `
  try {
    return JSON.parse(execSync(`osascript -l JavaScript -e ${JSON.stringify(script)}`, { timeout: 2000, encoding: 'utf8' }))
  } catch(e) { return null }
}

module.exports = { getAccessibilityTree }
```

## TTS in overlay.html
```js
let currentUtterance = null

function speak(text) {
  window.speechSynthesis.cancel()
  const clean = text.replace(/\[ACTION:[^\]]+\]/g, 'take a look at what I found.')
                    .replace(/```[\s\S]*?```/g, '')  // strip code blocks
                    .trim()
  if (!clean) return
  const utterance = new SpeechSynthesisUtterance(clean)
  const voices = window.speechSynthesis.getVoices()
  const voice = voices.find(v => v.name === 'Samantha')
    || voices.find(v => v.lang === 'en-US' && !v.name.includes('Compact'))
    || voices[0]
  if (voice) utterance.voice = voice
  utterance.rate = 1.08
  utterance.pitch = 1.0
  currentUtterance = utterance
  window.speechSynthesis.speak(utterance)
}

// Cancel when user starts speaking
function onMicStart() { window.speechSynthesis.cancel() }

// Voices load async on some systems
window.speechSynthesis.onvoiceschanged = () => { /* voices now available */ }
```

## Claude tools to define in agent.js
```js
const tools = [
  {
    name: 'browser_action',
    description: 'Control browser via CDP. ALWAYS use this first for anything on a website.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['navigate','read_page','click_selector','click_text','type','scroll','press_key'] },
        url: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        value: { type: 'string' },
        direction: { type: 'string', enum: ['up','down'] },
        key: { type: 'string' }
      },
      required: ['action']
    }
  },
  {
    name: 'native_action',
    description: 'Control native desktop apps (not browser) via accessibility + mouse/keyboard.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read_screen','click','type','key','scroll'] },
        target: { type: 'string' },
        value: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['action']
    }
  },
  {
    name: 'take_screenshot',
    description: 'Only when browser_action and native_action both fail.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'request_confirmation',
    description: 'ALWAYS call this before send/submit/delete/post. Shows preview, waits for user.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        details: { type: 'string' },
        risks: { type: 'array', items: { type: 'string' } }
      },
      required: ['summary', 'details']
    }
  }
]
```

## System prompt for Claude
```
You are a voice-first AI copilot controlling a computer alongside a tired user. You speak to them, they speak to you. Real conversation.

VOICE (most important):
- Every response is SPOKEN ALOUD. Keep it 1-3 sentences. Never a bullet list. Never headers.
- Casual and warm. Like a smart friend. Not a corporate assistant.
- Start doing the task while asking any question simultaneously.
- When you find results: say the key thing out loud in one sentence, the UI card shows the rest.

COMPUTER CONTROL:
- Anything in a browser → use browser_action. Always. No exceptions. It's instant.
- Native desktop app → use native_action.
- Screenshot → only if both above fail. Say "hang on, let me look at your screen" before taking it.
- Before Send / Delete / Submit / Post / Confirm → ALWAYS call request_confirmation. Never skip.
- After navigating: call browser_action read_page before doing anything else.
- Wait 300ms between actions.
- Stuck after 10 actions → stop and say out loud what's blocking you.

TASK-SPECIFIC:
- Flights: always check +-2 days unless told exact date. Flag any layover under 90min, any self-transfer.
- Email: draft it, say out loud "wrote a quick reply to [name], keeping it [tone], want me to send it?" then wait.
- Supabase: say what query you're about to run, run it, read results aloud briefly.
- Excel: read the sheet structure first, propose formula out loud, wait for go-ahead before writing.
```

## Startup sequence (in main.js / on app ready)
1. Check macOS Accessibility permission — if missing: speak "I need accessibility access to control your computer, opening settings" → open System Preferences → Privacy → Accessibility
2. Try CDP connect to Chrome — log result, don't block startup if it fails
3. Init whisper-node — if model not present: speak "downloading my voice model, one sec" + show spinner in UI
4. Once ready: speak "hey, ready when you are"

## Self-improvement loop
After EVERY user correction, append to tasks/lessons.md:
[DATE] [CONTEXT] What went wrong → Rule preventing it next time
Then add that rule to the relevant section of this file.

## Known good patterns
- Gmail compose via CDP: navigate to mail.google.com → read_page → click_selector '[data-tooltip="Compose"]' → type into fields → request_confirmation before clicking Send
- Google Flights via CDP: navigate to google.com/flights → fill airports → read_page to get results
- Chrome MUST be launched with --remote-debugging-port=9222. Tell user to do this on first run or automate it.
- nut-js silently fails without Accessibility permission on macOS. Always check on startup.
- SpeechSynthesis.getVoices() returns empty array until voiceschanged fires — always wait for that event.
- whisper-node blocks the main thread while downloading model — run in a worker or show clear loading UI.
