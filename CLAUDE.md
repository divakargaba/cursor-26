# ai-assistant: Project Knowledge & AI Memory

This file serves as the permanent memory for Claude Code. 
When picking up new tasks or resolving bugs, consult these rules first.

## 🏗️ Architecture Stack
1. **Electron Shell:** Overlay UI (`electron/overlay.html`), system shortcuts, and window management (`electron/main.js`).
2. **AI Engine:** Claude Haiku (`src/agent.js`) driving the logic loop.
3. **Computer Control:** Direct Windows API integration via Koffi (`src/computer.js`).
   - *CRITICAL:* All coordinates must use standard `SetCursorPos` coordinate space derived from `GetSystemMetrics(SM_CXSCREEN)`. 
   - Never use physical pixels or raw image pixels without scaling them.
4. **Browser Control:** Chrome DevTools MCP via stdio (`src/mcp-browser.js`).
   - Replaced Playwright. Uses native DevTools protocol.
5. **Vision & Grid:** `desktop-screenshot` with custom grid overlay annotation (`src/grid-overlay.js`).

## 🛑 Hard Rules & Mistake Prevention
*(Update this section ruthlessly whenever Claude makes a mistake twice)*

### 1. Browser & CDP
- **NEVER use Playwright.** It has been removed. Use `mcp-browser.js`.
- **Discord Selectors:** 
  - To type a message: `[data-slate-editor="true"]` or `[aria-label*="Message"]`. 
  - Do NOT use `textarea` (matches the search bar).
- **Element Clicks:** MCP `click` handles visibility checks. If elements are hidden, use keyboard shortcuts instead.

### 2. Native Computer Control (agent.js)
- **Focus Before Typing:** ALWAYS call `focus_window("AppName")` before sending keystrokes or types. Otherwise, input goes to the void or the wrong app.
- **NEVER Guess Coordinates:** The agent cannot "see" pixel offsets. Always use:
  1. `browser_action` with CSS selectors (for Chrome).
  2. `read_screen` to get UIAutomation element names.
  3. `take_screenshot` then click a grid cell like `cell="F4"`.
- **Keyboard Shortcuts > Clicks:** Use `ctrl+k` for Discord/Slack quick switcher, `explorer.exe` for files. It's 10x more reliable than computer vision.

### 3. Coordinate Math (grid-overlay.js)
- Screenshots are returned in physical display pixels (e.g. 1920x1080).
- Windows `SetCursorPos` uses a virtual coordinate space (`GetSystemMetrics`).
- `grid-overlay.js` maps image pixels to the screen metrics scale. Do not double-scale coordinates in `computer.js`.

---

## 🚀 Claude Code Best Practices (The Evolving AI Way)

### 1. Plan Mode First
For any task larger than a 1-line bug fix:
1. Type `/plan` in Claude Code.
2. Outline the files changing and the exact sequence.
3. Once the plan looks solid, switch back to execution.

### 2. Parallel Worktrees
Don't get stuck waiting for Claude. If one agent is refactoring `agent.js`:
```bash
git worktree add ../mcp-branch
cd ../mcp-branch && claude
```
Run independent tasks (like CSS tweaking and backend logic) in parallel.

### 3. Update This File
After EVERY resolved bug or architectural decision, add the lesson learned here with the prompt:
> *"Update your CLAUDE.md so you don't make that mistake again."*

### 4. Custom Skill Commands
Save repetitive debug workflows as skills. For example, to check the Electron logs quickly:
```bash
# Example custom skill setup (to be built):
# /logs -> tails the last 50 lines of electron output
```
