# ai-assistant: Project Knowledge & AI Memory

This file serves as the permanent memory for Claude Code.
When picking up new tasks or resolving bugs, consult these rules first.

## Architecture Stack
1. **Electron Shell:** Overlay UI (`electron/panel.html`), system shortcuts, and window management (`electron/main.js`).
2. **AI Engine:** Claude computer-use API (`src/agent.js`) — hybrid tool setup.
   - **Native computer-use tool** (`computer_20250124`): Claude analyzes screenshots, returns pixel coordinates for clicks. Trained for this.
   - **CDP browser tool** (`browser_action`): Chrome DevTools Protocol for web pages — faster than screenshot clicking.
   - **Confirmation tool** (`request_confirmation`): Safety gate for destructive actions.
   - **Dynamic model switching:** Haiku 4.5 (fast, default) → Sonnet 4.6 (accurate, on retry/failure).
3. **Computer Control:** Direct Windows API integration via Koffi (`src/computer.js`).
   - Uses `SetPhysicalCursorPos` for mouse, `keybd_event` for keyboard.
   - Coordinate scaling: Claude sends coords in display space (1024xN), we multiply by scale factor → physical pixels.
4. **Browser Control:** Chrome CDP via Playwright (`src/browser.js`).
   - Auto-connects to Chrome with `--remote-debugging-port=9222`.
   - Also supports Electron app CDP (Discord, Spotify, etc.).
5. **Screenshot Pipeline:** `desktopCapturer` → `nativeImage.resize()` → JPEG quality 50 → base64.
   - Physical screen (e.g. 1920x1080) downscaled to ~1024x576 (max 1024px long edge).
   - Scale factors stored in `displayConfig` for coordinate mapping.

## Hard Rules & Mistake Prevention

### 1. Computer-Use Coordinates
- Claude returns coordinates in **display space** (e.g. 1024x576).
- `agent.js _scaleToPhysical()` multiplies by `scaleX`/`scaleY` → physical pixels.
- **NEVER double-scale.** `computer.js` uses physical coords directly via `SetPhysicalCursorPos`.
- Auto-screenshot after every action (click/type/key/scroll) — Claude sees the result immediately.

### 2. Browser & CDP
- `browser_action` is for **web pages** — faster than screenshot→click cycle.
- Discord/Slack: prefer keyboard shortcuts (`ctrl+k` quick switcher) over clicking.
- CDP auto-connects to Chrome on port 9222. Electron apps on other ports (9224=Discord, etc).

### 3. Model Switching
- **Default: Haiku 4.5** — fast, cheap, good enough for most tasks.
- **Auto-upgrade to Sonnet 4.6** when:
  - Screenshot unchanged after 3+ actions (nothing happened).
  - User says "look carefully", "be precise", etc.
- Model resets to Haiku on `clearHistory()`.

### 4. Deleted Components (do NOT recreate)
- `src/grid-overlay.js` — **DELETED.** Claude's native computer-use replaces grid cells.
- `native_action` tool — **REMOVED.** Replaced by `computer` tool (computer-use API).
- `take_screenshot` tool — **REMOVED.** `computer` tool handles screenshots.

---

## Claude Code Best Practices

### 1. Plan Mode First
For any task larger than a 1-line bug fix:
1. Type `/plan` in Claude Code.
2. Outline the files changing and the exact sequence.
3. Once the plan looks solid, switch back to execution.

### 2. Update This File
After EVERY resolved bug or architectural decision, add the lesson learned here.

### 3. Beta API
- Computer-use requires `betas: ["computer-use-2025-01-24"]` header.
- Uses `client.beta.messages.create()` not `client.messages.create()`.
- Tool type: `computer_20250124` (not a custom tool schema).
