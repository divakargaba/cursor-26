# Lessons learned

_This file is updated automatically after every user correction._
_Format: [DATE] [MODULE] What went wrong → Rule that prevents it_

<!-- Claude Code: append entries here after every correction during the session -->
[2026-03-14] [VOICE] Web Speech API unavailable in Electron on Windows → Use Whisper as primary, Web Speech API not reliable in Electron
[2026-03-14] [VOICE] Whisper fallback requires manual stop (no silence detection) → Future: add silence detection via audio level monitoring to auto-stop recording
[2026-03-14] [AGENT] History corruption from tool_use/tool_result orphans causes cascading 400 errors → Validate history before every API call, auto-nuke if corrupted
[2026-03-14] [AGENT] Screenshot scaling breaks coordinate mapping (model sees scaled image, clicks at wrong positions) → NEVER scale screenshots, keep 1:1 with screen resolution
[2026-03-14] [AGENT] One-action-per-round makes everything feel slow (3-5s API latency per round) → System prompt must demand multiple tool calls per response
[2026-03-14] [AGENT] SendKeys.SendWait unreliable from non-interactive PowerShell → Use keybd_event Win32 API instead
[2026-03-14] [AGENT] navigate then read_page as separate rounds wastes a full API call → Auto-read page context in navigate tool result
[2026-03-14] [ELECTRON] alwaysOnTop overlay steals focus from target apps via koffi keybd_event → Use tray/menubar panel (not alwaysOnTop) so panel never contends for foreground focus
[2026-03-14] [AGENT] Clicks land wrong because Claude eyeballs coordinates from screenshots → 3-tier click system: UIAutomation elements > grid cell labels > raw coords (never)
[2026-03-14] [COMPUTER] @bright-fish/node-ui-automation doesn't exist, EnumChildWindows misses most elements → Compiled C# UIAutomation helper (uia-helper.cs) gets 80+ elements vs 1 from Win32
[2026-03-14] [COMPUTER] UIA helper outputs control chars (0x1A DOS EOF) in element names → Sanitize JSON on Node.js side: strip [\x00-\x1f] before JSON.parse
[2026-03-14] [BROWSER] Playwright CDP connect hangs for 30s when Chrome has no debug port → HTTP check /json/version first (1.5s timeout) before slow Playwright connect
[2026-03-14] [AGENT] No click verification means Claude retries same wrong coordinates → Post-click feedback includes active window title so Claude knows if click landed
[2026-03-14] [COMPUTER] SetForegroundWindow is async — returns before focus transfers. type() fires Ctrl+V before target has input focus → _ensureTargetFocused now retries 3x with sync sleep + title verification
[2026-03-14] [AGENT] 150ms inter-action delay not enough for modern WinUI apps (Windows 11 Notepad) → 350ms after focus_window, 200ms between other native actions
[2026-03-14] [AGENT] Claude hallucinates "I can see the text" in screenshots when text isn't there → System prompt: "NEVER claim success without evidence. Take screenshot to verify after typing."
[2026-03-14] [COMPUTER] Alt trick (keybd_event 0x12) triggers Windows Access Key Tips in modern apps (Notepad, Edge) → puts app in menu mode, eats Ctrl+V → Use Ctrl (0x11) instead of Alt to unlock SetForegroundWindow. Ctrl has no visible side effect.
