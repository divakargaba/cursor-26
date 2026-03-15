// src/computer.windows.js — Windows control: mouse/keyboard/clipboard/windows (no PowerShell)
// Uses koffi for direct Win32 DLL calls — synchronous, instant, zero process overhead.
const { exec, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

// ---------------------------------------------------------------------------
// Win32 DLL bindings (loaded once at require time, synchronous)
// ---------------------------------------------------------------------------

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const msvcrt = koffi.load('msvcrt.dll');

// --- Mouse ---
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const mouse_event = user32.func('void __stdcall mouse_event(uint32_t dwFlags, int dx, int dy, int dwData, uintptr_t dwExtraInfo)');

const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;

// --- Keyboard ---
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
const KEYEVENTF_KEYUP = 0x0002;

// --- Window management ---
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)');
const GetWindowTextA = user32.func('int __stdcall GetWindowTextA(void *hWnd, uint8_t *lpString, int nMaxCount)');
const GetWindowTextLengthA = user32.func('int __stdcall GetWindowTextLengthA(void *hWnd)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, uint32_t *lpdwProcessId)');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)');
const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void *hWnd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void *hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)');
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;

// EnumWindows callback
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *, intptr_t)');

// --- Cursor ---
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(void *lpPoint)');

// --- Clipboard ---
const OpenClipboard = user32.func('bool __stdcall OpenClipboard(void *hWndNewOwner)');
const CloseClipboard = user32.func('bool __stdcall CloseClipboard()');
const EmptyClipboard = user32.func('bool __stdcall EmptyClipboard()');
const SetClipboardData = user32.func('void * __stdcall SetClipboardData(uint32_t uFormat, void *hMem)');
const GetClipboardData = user32.func('void * __stdcall GetClipboardData(uint32_t uFormat)');
const GlobalAlloc = kernel32.func('void * __stdcall GlobalAlloc(uint32_t uFlags, uintptr_t dwBytes)');
const GlobalLock = kernel32.func('void * __stdcall GlobalLock(void *hMem)');
const GlobalUnlock = kernel32.func('bool __stdcall GlobalUnlock(void *hMem)');
const GlobalSize = kernel32.func('uintptr_t __stdcall GlobalSize(void *hMem)');
const memcpy = msvcrt.func('void * __cdecl memcpy(void *dest, void *src, uintptr_t count)');

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;

// --- Process info ---
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *hObject)');
const QueryFullProcessImageNameA = kernel32.func('bool __stdcall QueryFullProcessImageNameA(void *hProcess, uint32_t dwFlags, uint8_t *lpExeName, uint32_t *lpdwSize)');
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const SW_RESTORE = 9;

// --- Win32 Accessibility (MSAA via oleacc.dll) ---
let oleacc = null;
let AccessibleObjectFromWindow = null;
let GetWindowRect = null;
try {
  oleacc = koffi.load('oleacc.dll');
  // We use GetWindowRect to get window positioning for coordinate mapping
  GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, void *lpRect)');
} catch (err) {
  console.warn('[computer] oleacc.dll not available:', err.message);
}

// EnumChildWindows for iterating child windows (buttons, edits, etc.)
const EnumChildWindowsProc = koffi.proto('bool __stdcall EnumChildWindowsProc(void *hwnd, intptr_t lParam)');
const EnumChildWindows = user32.func('bool __stdcall EnumChildWindows(void *hWndParent, EnumChildWindowsProc *, intptr_t)');
const GetClassNameA = user32.func('int __stdcall GetClassNameA(void *hWnd, uint8_t *lpClassName, int nMaxCount)');
const IsWindowEnabled = user32.func('bool __stdcall IsWindowEnabled(void *hWnd)');

// ---------------------------------------------------------------------------
// Virtual key code map
// ---------------------------------------------------------------------------

const VK = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5B, super: 0x5B,
  enter: 0x0D, return: 0x0D, tab: 0x09, escape: 0x1B, esc: 0x1B,
  backspace: 0x08, delete: 0x2E, space: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74,
  f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47,
  h: 0x48, i: 0x49, j: 0x4A, k: 0x4B, l: 0x4C, m: 0x4D, n: 0x4E,
  o: 0x4F, p: 0x50, q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55,
  v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5A,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
};

// ---------------------------------------------------------------------------
// Computer class
// ---------------------------------------------------------------------------

class Computer {
  constructor() {
    // No init needed — koffi bindings load synchronously at module level
    this._lastFocusedHwnd = null; // Store target HWND for focus re-acquisition
    this._uiaHelperPath = null;
    this._uiaCompiled = false;
  }

  /**
   * Re-verify and re-set focus to the last focusWindow target.
   * Called synchronously right before keystrokes to prevent the Electron
   * overlay from stealing focus during async gaps.
   */
  _ensureTargetFocused() {
    if (!this._lastFocusedHwnd) return;
    // Ctrl press/release to unlock SetForegroundWindow (NOT Alt — triggers menu overlays)
    keybd_event(0x11, 0, 0, 0);
    keybd_event(0x11, 0, KEYEVENTF_KEYUP, 0);
    SetForegroundWindow(this._lastFocusedHwnd);
  }

  _validateCoords(...vals) {
    for (const v of vals) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`Invalid coordinate: ${v}`);
      }
    }
  }

  // =========================================================================
  // Clipboard (private helpers — pure Win32 via koffi)
  // =========================================================================

  _writeClipboard(text) {
    const utf16 = Buffer.from(text + '\0', 'utf16le');
    const hMem = GlobalAlloc(GMEM_MOVEABLE, utf16.length);
    if (!hMem) return false;
    const pMem = GlobalLock(hMem);
    if (!pMem) return false;
    memcpy(pMem, utf16, utf16.length);
    GlobalUnlock(hMem);
    if (!OpenClipboard(null)) return false;
    EmptyClipboard();
    SetClipboardData(CF_UNICODETEXT, hMem);
    CloseClipboard();
    return true;
  }

  _readClipboard() {
    if (!OpenClipboard(null)) return '';
    const hData = GetClipboardData(CF_UNICODETEXT);
    if (!hData) { CloseClipboard(); return ''; }
    const pData = GlobalLock(hData);
    if (!pData) { CloseClipboard(); return ''; }
    const size = GlobalSize(hData);
    const buf = Buffer.alloc(Number(size));
    memcpy(buf, pData, Number(size));
    GlobalUnlock(hData);
    CloseClipboard();
    return buf.toString('utf16le').replace(/\0+$/, '');
  }

  _clearClipboard() {
    if (OpenClipboard(null)) {
      EmptyClipboard();
      CloseClipboard();
    }
  }

  // =========================================================================
  // Mouse
  // =========================================================================

  async leftClick(x, y) {
    this._validateCoords(x, y);
    SetCursorPos(Math.round(x), Math.round(y));
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }

  async rightClick(x, y) {
    this._validateCoords(x, y);
    SetCursorPos(Math.round(x), Math.round(y));
    mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
    mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
  }

  async middleClick(x, y) {
    this._validateCoords(x, y);
    SetCursorPos(Math.round(x), Math.round(y));
    mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
    mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
  }

  async doubleClick(x, y) {
    this._validateCoords(x, y);
    const rx = Math.round(x), ry = Math.round(y);
    SetCursorPos(rx, ry);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    await new Promise((r) => setTimeout(r, 30));
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }

  async mouseMove(x, y) {
    this._validateCoords(x, y);
    SetCursorPos(Math.round(x), Math.round(y));
  }

  async leftClickDrag(startX, startY, endX, endY) {
    this._validateCoords(startX, startY, endX, endY);
    SetCursorPos(Math.round(startX), Math.round(startY));
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    await new Promise((r) => setTimeout(r, 30));
    SetCursorPos(Math.round(endX), Math.round(endY));
    await new Promise((r) => setTimeout(r, 30));
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }

  async scroll(x, y, direction, amount = 3) {
    this._validateCoords(x, y);
    SetCursorPos(Math.round(x), Math.round(y));
    const clicks = (direction === 'up' || direction === 'left') ? amount * 120 : -(amount * 120);
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, clicks, 0);
  }

  // =========================================================================
  // Keyboard
  // =========================================================================

  async type(text) {
    const old = this._readClipboard();
    // CRITICAL: _ensureTargetFocused + clipboard + Ctrl+V must be fully synchronous.
    // Any async gap (await/setTimeout) lets Electron's event loop steal focus back.
    this._ensureTargetFocused();
    this._writeClipboard(text);
    keybd_event(0x11, 0, 0, 0);       // Ctrl down
    keybd_event(0x56, 0, 0, 0);       // V down
    keybd_event(0x56, 0, KEYEVENTF_KEYUP, 0); // V up
    keybd_event(0x11, 0, KEYEVENTF_KEYUP, 0); // Ctrl up
    // Only AFTER keystrokes are sent do we yield — safe to restore clipboard
    await new Promise((r) => setTimeout(r, 50));
    if (old) {
      this._writeClipboard(old);
    } else {
      this._clearClipboard();
    }
  }

  async key(keys) {
    const combo = keys.toLowerCase().trim();
    const codes = this._parseKeyCodes(combo);
    if (codes) {
      this._ensureTargetFocused();
      for (const vk of codes) keybd_event(vk, 0, 0, 0);
      for (const vk of [...codes].reverse()) keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
    } else {
      console.warn(`[computer] Unknown key combo: ${keys}`);
    }
  }

  _parseKeyCodes(combo) {
    const parts = combo.split('+').map((p) => p.trim());
    const codes = parts.map((p) => VK[p]);
    if (codes.some((c) => c === undefined)) return null;
    return codes;
  }

  // =========================================================================
  // Cursor
  // =========================================================================

  getCursorPosition() {
    try {
      const buf = Buffer.alloc(8); // POINT = {int X, int Y} = 8 bytes
      GetCursorPos(buf);
      return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
    } catch {
      return { x: 0, y: 0 };
    }
  }

  // =========================================================================
  // Window management
  // =========================================================================

  /**
   * Enumerate all visible windows with titles.
   * Returns array of { hwnd, title, pid }.
   */
  _enumWindows() {
    const windows = [];
    const cb = koffi.register((hwnd, lParam) => {
      try {
        if (!IsWindowVisible(hwnd)) return true;
        const len = GetWindowTextLengthA(hwnd);
        if (len <= 0) return true;
        const buf = Buffer.alloc(len + 1);
        GetWindowTextA(hwnd, buf, len + 1);
        const title = buf.toString('utf8', 0, len);
        const pidBuf = Buffer.alloc(4);
        GetWindowThreadProcessId(hwnd, pidBuf);
        const pid = pidBuf.readUInt32LE(0);
        windows.push({ hwnd, title, pid });
      } catch (err) {
        console.error('[computer] EnumWindows callback error:', err.message);
      }
      return true;
    }, koffi.pointer(EnumWindowsProc));

    EnumWindows(cb, 0);
    koffi.unregister(cb);
    return windows;
  }

  /**
   * Get process name from PID via QueryFullProcessImageName.
   */
  _getProcessName(pid) {
    try {
      const hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!hProcess) return 'unknown';
      const nameBuf = Buffer.alloc(260);
      const sizeBuf = Buffer.alloc(4);
      sizeBuf.writeUInt32LE(260);
      const ok = QueryFullProcessImageNameA(hProcess, 0, nameBuf, sizeBuf);
      CloseHandle(hProcess);
      if (!ok) return 'unknown';
      const actualLen = sizeBuf.readUInt32LE(0);
      const exePath = nameBuf.toString('utf8', 0, actualLen);
      return path.basename(exePath, '.exe');
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get the title of the currently focused window.
   */
  getForegroundWindowTitle() {
    try {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return '';
      const buf = Buffer.alloc(256);
      const len = GetWindowTextA(hwnd, buf, 256);
      return buf.toString('utf8', 0, len);
    } catch {
      return '';
    }
  }

  /**
   * Focus a window by title pattern (regex match).
   * Uses AttachThreadInput trick to bypass foreground lock.
   */
  async focusWindow(titlePattern) {
    try {
      const windows = this._enumWindows();
      const regex = new RegExp(titlePattern, 'i');
      const candidates = windows.filter((w) => regex.test(w.title));

      if (candidates.length === 0) {
        return { ok: false, error: `No window matching "${titlePattern}"` };
      }

      // Rank: prefer process name match > title starts with pattern > substring match
      // This prevents Chrome tabs containing "discord" from beating the Discord app
      const pattern = titlePattern.toLowerCase();
      const ranked = candidates.map((w) => {
        const proc = (this._getProcessName(w.pid) || '').toLowerCase();
        const title = w.title.toLowerCase();
        let score = 0;
        if (proc.includes(pattern)) score += 100;           // Process name match (e.g. Discord.exe)
        if (title.startsWith(pattern)) score += 50;         // Title starts with pattern
        if (title === pattern) score += 200;                // Exact match
        if (proc === 'chrome' || proc === 'explorer') score -= 20; // Deprioritize browser tabs
        return { ...w, score };
      });
      ranked.sort((a, b) => b.score - a.score);
      const match = ranked[0];

      const fgHwnd = GetForegroundWindow();
      const fgPidBuf = Buffer.alloc(4);
      const fgThread = GetWindowThreadProcessId(fgHwnd, fgPidBuf);
      const targetPidBuf = Buffer.alloc(4);
      const targetThread = GetWindowThreadProcessId(match.hwnd, targetPidBuf);
      const curThread = GetCurrentThreadId();

      // Ctrl press/release to generate input event — unlocks SetForegroundWindow.
      // Do NOT use Alt — it triggers Access Key overlays in modern Windows apps.
      keybd_event(0x11, 0, 0, 0);
      keybd_event(0x11, 0, KEYEVENTF_KEYUP, 0);

      AttachThreadInput(curThread, fgThread, true);
      AttachThreadInput(curThread, targetThread, true);
      ShowWindow(match.hwnd, SW_RESTORE);
      SetForegroundWindow(match.hwnd);
      BringWindowToTop(match.hwnd);
      // Force to front: briefly set TOPMOST then remove — guarantees visibility
      SetWindowPos(match.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
      SetWindowPos(match.hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
      AttachThreadInput(curThread, targetThread, false);
      AttachThreadInput(curThread, fgThread, false);

      // Store HWND so _ensureTargetFocused can re-acquire focus before keystrokes
      this._lastFocusedHwnd = match.hwnd;

      const processName = this._getProcessName(match.pid);
      return { ok: true, process: processName, title: match.title };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * List all visible windows with titles.
   */
  async listWindows() {
    try {
      const windows = this._enumWindows();
      return windows.map((w) => ({
        Id: w.pid,
        ProcessName: this._getProcessName(w.pid),
        MainWindowTitle: w.title,
      }));
    } catch {
      return [];
    }
  }

  // =========================================================================
  // UI Automation
  // =========================================================================

  /**
   * Compile the C# UIAutomation helper (one-time).
   * Returns path to compiled .exe, or null if compilation fails.
   */
  _compileUIAHelper() {
    if (this._uiaCompiled) return this._uiaHelperPath;
    this._uiaCompiled = true;

    try {
      const srcPath = path.join(__dirname, 'uia-helper.cs');
      const exePath = path.join(__dirname, '..', 'data', 'uia-helper.exe');

      if (!fs.existsSync(srcPath)) {
        console.warn('[computer] uia-helper.cs not found');
        return null;
      }

      // Check if already compiled and up to date
      if (fs.existsSync(exePath)) {
        const srcMtime = fs.statSync(srcPath).mtimeMs;
        const exeMtime = fs.statSync(exePath).mtimeMs;
        if (exeMtime > srcMtime) {
          this._uiaHelperPath = exePath;
          console.log('[computer] UIA helper already compiled');
          return exePath;
        }
      }

      // Find csc.exe — try .NET Framework 4.x (available on all modern Windows)
      const cscPaths = [
        'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
        'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
      ];
      let cscPath = null;
      for (const p of cscPaths) {
        if (fs.existsSync(p)) { cscPath = p; break; }
      }
      if (!cscPath) {
        console.warn('[computer] csc.exe not found — UIAutomation helper unavailable');
        return null;
      }

      // Ensure output directory
      const dir = path.dirname(exePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Reference assemblies — use WPF subdirectory (available in all .NET Framework 4.x installs)
      const fwDir = path.dirname(cscPath);
      const wpfDir = path.join(fwDir, 'WPF');
      const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll']
        .map((dll) => {
          const wpfPath = path.join(wpfDir, dll);
          return fs.existsSync(wpfPath) ? `/reference:"${wpfPath}"` : `/reference:${dll}`;
        })
        .join(' ');

      // Compile
      execSync(
        `"${cscPath}" /nologo /optimize /out:"${exePath}" ${refs} "${srcPath}"`,
        { timeout: 15000, windowsHide: true, stdio: 'pipe' }
      );

      if (fs.existsSync(exePath)) {
        console.log('[computer] UIA helper compiled successfully');
        this._uiaHelperPath = exePath;
        return exePath;
      }
    } catch (err) {
      console.warn('[computer] UIA helper compilation failed:', err.message);
    }
    return null;
  }

  /**
   * Get UI elements via UIAutomation (compiled C# helper).
   * Returns { window, elements[] } or null if unavailable.
   */
  _getUIElementsViaUIA() {
    try {
      const exePath = this._compileUIAHelper();
      if (!exePath) return null;

      const output = execFileSync(exePath, [], {
        timeout: 3000,
        windowsHide: true,
        encoding: 'utf8',
      });

      const result = JSON.parse(output);
      if (result && Array.isArray(result.elements) && result.elements.length > 0) {
        return result;
      }
    } catch (err) {
      console.warn('[computer] UIA helper error:', err.message);
    }
    return null;
  }

  /**
   * Get UI elements — tries UIAutomation first, falls back to EnumChildWindows.
   * Returns { window, windowRect, elements[], source }.
   */
  async getUIElements() {
    try {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return { window: 'unknown', elements: [], source: 'none' };

      // Get window title
      const titleBuf = Buffer.alloc(256);
      const titleLen = GetWindowTextA(hwnd, titleBuf, 256);
      const windowTitle = titleBuf.toString('utf8', 0, titleLen);

      // Get window rect
      const winRectBuf = Buffer.alloc(16);
      GetWindowRect(hwnd, winRectBuf);
      const winRect = {
        left: winRectBuf.readInt32LE(0),
        top: winRectBuf.readInt32LE(4),
        right: winRectBuf.readInt32LE(8),
        bottom: winRectBuf.readInt32LE(12),
      };

      // Tier 1: UIAutomation (works with modern apps — WPF, UWP, Electron, etc.)
      const uiaResult = this._getUIElementsViaUIA();
      if (uiaResult && uiaResult.elements.length > 0) {
        return {
          window: uiaResult.window || windowTitle || 'unknown',
          windowRect: winRect,
          elements: uiaResult.elements,
          source: 'uia',
        };
      }

      // Tier 2: EnumChildWindows (works for traditional Win32 apps)
      const elements = this._enumChildElements(hwnd);
      return {
        window: windowTitle || 'unknown',
        windowRect: winRect,
        elements,
        source: 'win32',
      };
    } catch (err) {
      console.error('[computer] getUIElements error:', err.message);
      const title = this.getForegroundWindowTitle();
      return { window: title || 'unknown', elements: [], source: 'error' };
    }
  }

  /**
   * Enumerate child windows of a parent window (recursive).
   * Returns array of { name, type, className, enabled, x, y, w, h }.
   */
  _enumChildElements(parentHwnd) {
    const CLASS_TYPE_MAP = {
      button: 'Button',
      edit: 'Edit',
      richedit20w: 'Edit',
      richedit50w: 'Edit',
      combobox: 'ComboBox',
      listbox: 'ListBox',
      syslistview32: 'ListView',
      systreeview32: 'TreeView',
      systabcontrol32: 'Tab',
      msctls_trackbar32: 'Slider',
      scrollbar: 'ScrollBar',
      static: 'Label',
      syslink: 'Link',
      toolbarwindow32: 'Toolbar',
      msctls_statusbar32: 'StatusBar',
    };

    const elements = [];
    const MAX_ELEMENTS = 60;
    const seen = new Set(); // avoid duplicates from recursive enumeration

    // Recursive child enumeration — collects children and grandchildren
    const enumChildren = (parentHwnd, depth) => {
      if (elements.length >= MAX_ELEMENTS || depth > 3) return;

      const cb = koffi.register((childHwnd, lParam) => {
        try {
          if (elements.length >= MAX_ELEMENTS) return false;
          if (!IsWindowVisible(childHwnd)) return true;

          // Get class name
          const classBuf = Buffer.alloc(128);
          const classLen = GetClassNameA(childHwnd, classBuf, 128);
          const className = classBuf.toString('utf8', 0, classLen).toLowerCase();

          // Get text
          const childTitleLen = GetWindowTextLengthA(childHwnd);
          let childTitle = '';
          if (childTitleLen > 0) {
            const childTitleBuf = Buffer.alloc(childTitleLen + 1);
            GetWindowTextA(childHwnd, childTitleBuf, childTitleLen + 1);
            childTitle = childTitleBuf.toString('utf8', 0, childTitleLen);
          }

          // Get bounding rect (screen coordinates)
          const rectBuf = Buffer.alloc(16);
          if (!GetWindowRect(childHwnd, rectBuf)) return true;
          const left = rectBuf.readInt32LE(0);
          const top = rectBuf.readInt32LE(4);
          const right = rectBuf.readInt32LE(8);
          const bottom = rectBuf.readInt32LE(12);
          const w = right - left;
          const h = bottom - top;

          if (w <= 2 || h <= 2) return true;

          // Dedup by position
          const key = `${left},${top},${w},${h}`;
          if (seen.has(key)) return true;
          seen.add(key);

          const type = CLASS_TYPE_MAP[className] || className;
          const enabled = IsWindowEnabled(childHwnd);

          elements.push({
            name: childTitle || '',
            type,
            className,
            enabled,
            x: Math.round(left + w / 2),
            y: Math.round(top + h / 2),
            w,
            h,
          });

          // Recurse into children of this child (for toolbars, rebar, etc.)
          if (depth < 3) {
            enumChildren(childHwnd, depth + 1);
          }
        } catch {
          // Skip this element
        }
        return true;
      }, koffi.pointer(EnumChildWindowsProc));

      EnumChildWindows(parentHwnd, cb, 0);
      koffi.unregister(cb);
    };

    enumChildren(parentHwnd, 0);
    return elements;
  }

  // =========================================================================
  // Command execution (unchanged — stays as child_process.exec)
  // =========================================================================

  async runCommand(command) {
    return new Promise((resolve) => {
      exec(command, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
        if (err && err.killed) {
          resolve({ ok: false, error: 'Command timed out (10s)' });
        } else {
          resolve({
            ok: !err,
            stdout: (stdout || '').trim().slice(0, 2000),
            stderr: (stderr || '').trim().slice(0, 500),
            error: err ? err.message : null,
          });
        }
      });
    });
  }
}

module.exports = Computer;
