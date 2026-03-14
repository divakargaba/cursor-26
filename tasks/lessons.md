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
