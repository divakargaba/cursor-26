// src/computer.macos.js — macOS control: mouse/keyboard/clipboard/windows
// Uses AppleScript (osascript) for keyboard, windows, and clipboard.
// Uses cliclick (https://github.com/BlueM/cliclick) for mouse if available,
// falls back to AppleScript mouse positioning + click via System Events.
//
// External dependency: cliclick (optional but recommended for precise mouse control)
//   Install: brew install cliclick
//   Without cliclick, mouse clicks use AppleScript which is less precise.

const { exec, execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Detect cliclick availability at load time
// ---------------------------------------------------------------------------

let _hasCliclick = false;
try {
  execSync('which cliclick', { stdio: 'pipe' });
  _hasCliclick = true;
  console.log('[computer-macos] cliclick found — using for mouse control');
} catch {
  console.warn('[computer-macos] cliclick not found. Mouse clicks will use AppleScript (less precise).');
  console.warn('[computer-macos] Install with: brew install cliclick');
}

// ---------------------------------------------------------------------------
// AppleScript helpers
// ---------------------------------------------------------------------------

function runOsascript(script) {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    console.error('[computer-macos] osascript error:', err.message);
    return '';
  }
}

function runOsascriptMultiline(script) {
  try {
    return execSync('osascript', {
      input: script,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    console.error('[computer-macos] osascript error:', err.message);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Key code mapping for AppleScript key code commands
// Maps key names to macOS virtual key codes
// ---------------------------------------------------------------------------

const MAC_KEY_CODES = {
  enter: 36, return: 36, tab: 48, escape: 27, esc: 27,
  delete: 51, backspace: 51, forwarddelete: 117,
  space: 49,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96,
  f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

// Modifier mapping: key name → AppleScript modifier
const MAC_MODIFIERS = {
  command: 'command down', cmd: 'command down',
  control: 'control down', ctrl: 'control down',
  option: 'option down', alt: 'option down',
  shift: 'shift down',
};

// Character key codes for single characters (used when modifiers are present)
const MAC_CHAR_KEY_CODES = {
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38,
  k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1,
  t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21,
  '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
};

// ---------------------------------------------------------------------------
// Computer class — macOS implementation
// ---------------------------------------------------------------------------

class Computer {
  constructor() {
    this._lastFocusedApp = null; // Store app name for focus re-acquisition
  }

  /**
   * Re-focus the last targeted app before keystrokes.
   * macOS equivalent of _ensureTargetFocused on Windows.
   */
  _ensureTargetFocused() {
    if (!this._lastFocusedApp) return;
    try {
      runOsascript(`tell application "${this._lastFocusedApp}" to activate`);
    } catch {
      // Best effort — don't crash
    }
  }

  _validateCoords(...vals) {
    for (const v of vals) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`Invalid coordinate: ${v}`);
      }
    }
  }

  // =========================================================================
  // Clipboard (pbcopy / pbpaste)
  // =========================================================================

  _writeClipboard(text) {
    try {
      execSync('pbcopy', { input: text, timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }

  _readClipboard() {
    try {
      return execSync('pbpaste', { timeout: 2000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return '';
    }
  }

  _clearClipboard() {
    try {
      execSync('pbcopy', { input: '', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      // ignore
    }
  }

  // =========================================================================
  // Mouse
  // =========================================================================

  async leftClick(x, y) {
    this._validateCoords(x, y);
    const rx = Math.round(x), ry = Math.round(y);
    if (_hasCliclick) {
      execSync(`cliclick c:${rx},${ry}`, { timeout: 3000, stdio: 'pipe' });
    } else {
      // AppleScript fallback — less precise but functional
      runOsascriptMultiline(`
tell application "System Events"
  click at {${rx}, ${ry}}
end tell`);
    }
  }

  async rightClick(x, y) {
    this._validateCoords(x, y);
    const rx = Math.round(x), ry = Math.round(y);
    if (_hasCliclick) {
      execSync(`cliclick rc:${rx},${ry}`, { timeout: 3000, stdio: 'pipe' });
    } else {
      runOsascriptMultiline(`
tell application "System Events"
  -- AppleScript doesn't natively support right-click at coordinates easily
  -- This is a known limitation without cliclick
end tell`);
      console.warn('[computer-macos] Right-click without cliclick is unsupported. Install cliclick.');
    }
  }

  async middleClick(x, y) {
    this._validateCoords(x, y);
    // Middle click is rarely supported via AppleScript; cliclick doesn't support it either
    // Fall back to a regular click
    console.warn('[computer-macos] Middle-click not supported on macOS, falling back to left-click');
    await this.leftClick(x, y);
  }

  async doubleClick(x, y) {
    this._validateCoords(x, y);
    const rx = Math.round(x), ry = Math.round(y);
    if (_hasCliclick) {
      execSync(`cliclick dc:${rx},${ry}`, { timeout: 3000, stdio: 'pipe' });
    } else {
      runOsascriptMultiline(`
tell application "System Events"
  click at {${rx}, ${ry}}
  delay 0.05
  click at {${rx}, ${ry}}
end tell`);
    }
  }

  async mouseMove(x, y) {
    this._validateCoords(x, y);
    const rx = Math.round(x), ry = Math.round(y);
    if (_hasCliclick) {
      execSync(`cliclick m:${rx},${ry}`, { timeout: 3000, stdio: 'pipe' });
    } else {
      // AppleScript mouse move is very limited
      console.warn('[computer-macos] mouseMove without cliclick is a no-op');
    }
  }

  async leftClickDrag(startX, startY, endX, endY) {
    this._validateCoords(startX, startY, endX, endY);
    if (_hasCliclick) {
      const sx = Math.round(startX), sy = Math.round(startY);
      const ex = Math.round(endX), ey = Math.round(endY);
      execSync(`cliclick dd:${sx},${sy} du:${ex},${ey}`, { timeout: 5000, stdio: 'pipe' });
    } else {
      console.warn('[computer-macos] leftClickDrag without cliclick is unsupported');
    }
  }

  async scroll(x, y, direction, amount = 3) {
    this._validateCoords(x, y);
    // Move mouse to position first, then scroll
    if (_hasCliclick) {
      const rx = Math.round(x), ry = Math.round(y);
      execSync(`cliclick m:${rx},${ry}`, { timeout: 3000, stdio: 'pipe' });
    }
    // Use AppleScript for scroll — cliclick doesn't support scroll
    const scrollDir = (direction === 'up' || direction === 'left') ? amount : -amount;
    runOsascriptMultiline(`
tell application "System Events"
  -- Scroll using key codes (Page Up / Page Down as rough equivalent)
  ${scrollDir > 0 ? `repeat ${Math.abs(scrollDir)} times\nkey code 116\nend repeat` : `repeat ${Math.abs(scrollDir)} times\nkey code 121\nend repeat`}
end tell`);
  }

  // =========================================================================
  // Keyboard
  // =========================================================================

  /**
   * Type text using clipboard + Cmd+V (paste), same pattern as Windows.
   * Preserves existing clipboard content.
   */
  async type(text) {
    const old = this._readClipboard();
    this._ensureTargetFocused();
    this._writeClipboard(text);

    // Cmd+V to paste
    runOsascriptMultiline(`
tell application "System Events"
  keystroke "v" using command down
end tell`);

    // Wait for paste to complete, then restore clipboard
    await new Promise((r) => setTimeout(r, 100));
    if (old) {
      this._writeClipboard(old);
    } else {
      this._clearClipboard();
    }
  }

  /**
   * Press a key combination.
   * Accepts formats like: "command+c", "ctrl+shift+a", "enter", "tab", "f5"
   * Maps ctrl→command on macOS for common shortcuts (Ctrl+C → Cmd+C).
   */
  async key(keys) {
    const combo = keys.toLowerCase().trim();
    const parts = combo.split('+').map((p) => p.trim());

    this._ensureTargetFocused();

    // Separate modifiers from the actual key
    const modifiers = [];
    let mainKey = null;

    for (const part of parts) {
      if (MAC_MODIFIERS[part]) {
        modifiers.push(MAC_MODIFIERS[part]);
      } else {
        mainKey = part;
      }
    }

    if (!mainKey) {
      console.warn(`[computer-macos] No main key found in combo: ${keys}`);
      return;
    }

    // Check if the main key is a special key (Enter, Tab, etc.) or character
    const specialKeyCode = MAC_KEY_CODES[mainKey];
    const charKeyCode = MAC_CHAR_KEY_CODES[mainKey];

    if (specialKeyCode !== undefined) {
      // Use key code for special keys
      const modStr = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
      runOsascriptMultiline(`
tell application "System Events"
  key code ${specialKeyCode}${modStr}
end tell`);
    } else if (mainKey.length === 1) {
      // Single character — use keystroke
      const modStr = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
      runOsascriptMultiline(`
tell application "System Events"
  keystroke "${mainKey}"${modStr}
end tell`);
    } else if (charKeyCode !== undefined) {
      // Named character key with key code
      const modStr = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
      runOsascriptMultiline(`
tell application "System Events"
  key code ${charKeyCode}${modStr}
end tell`);
    } else {
      console.warn(`[computer-macos] Unknown key: ${mainKey} in combo: ${keys}`);
    }
  }

  // =========================================================================
  // Cursor
  // =========================================================================

  getCursorPosition() {
    if (_hasCliclick) {
      try {
        const output = execSync('cliclick p', { timeout: 2000, encoding: 'utf8', stdio: 'pipe' }).trim();
        // Output format: "x,y"
        const [x, y] = output.split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return { x, y };
        }
      } catch {
        // fall through
      }
    }
    return { x: 0, y: 0 };
  }

  // =========================================================================
  // Window management
  // =========================================================================

  /**
   * Get the title of the currently focused window.
   */
  getForegroundWindowTitle() {
    try {
      // Get frontmost application, then its frontmost window title
      const result = runOsascriptMultiline(`
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  try
    set winTitle to name of front window of frontApp
  on error
    set winTitle to name of frontApp
  end try
  return winTitle
end tell`);
      return result;
    } catch {
      return '';
    }
  }

  /**
   * Focus a window by title pattern (regex match).
   * Uses AppleScript to activate the app and raise the matching window.
   */
  async focusWindow(titlePattern) {
    try {
      const regex = new RegExp(titlePattern, 'i');

      // Get list of windows with their apps
      const windowsRaw = runOsascriptMultiline(`
set output to ""
tell application "System Events"
  set allProcs to every application process whose visible is true
  repeat with proc in allProcs
    set procName to name of proc
    try
      set wins to every window of proc
      repeat with w in wins
        try
          set winName to name of w
          set output to output & procName & "|||" & winName & "\\n"
        end try
      end repeat
    end try
  end repeat
end tell
return output`);

      const lines = windowsRaw.split('\n').filter(Boolean);
      let matchedApp = null;
      let matchedTitle = null;

      for (const line of lines) {
        const [appName, winTitle] = line.split('|||');
        if (winTitle && regex.test(winTitle)) {
          matchedApp = appName;
          matchedTitle = winTitle;
          break;
        }
        // Also try matching against app name
        if (appName && regex.test(appName) && !matchedApp) {
          matchedApp = appName;
          matchedTitle = winTitle || appName;
        }
      }

      if (!matchedApp) {
        return { ok: false, error: `No window matching "${titlePattern}"` };
      }

      // Activate the application
      runOsascript(`tell application "${matchedApp}" to activate`);

      this._lastFocusedApp = matchedApp;
      await new Promise((r) => setTimeout(r, 200));

      return { ok: true, process: matchedApp, title: matchedTitle };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * List all visible windows with titles.
   * Returns array matching Windows format: [{ Id, ProcessName, MainWindowTitle }]
   */
  async listWindows() {
    try {
      const output = runOsascriptMultiline(`
set output to ""
tell application "System Events"
  set allProcs to every application process whose visible is true
  repeat with proc in allProcs
    set procName to name of proc
    set procId to unix id of proc
    try
      set wins to every window of proc
      repeat with w in wins
        try
          set winName to name of w
          set output to output & procId & "|||" & procName & "|||" & winName & "\\n"
        end try
      end repeat
    on error
      -- Some processes don't expose windows
      set output to output & procId & "|||" & procName & "|||" & procName & "\\n"
    end try
  end repeat
end tell
return output`);

      return output.split('\n').filter(Boolean).map((line) => {
        const [id, processName, title] = line.split('|||');
        return {
          Id: parseInt(id, 10) || 0,
          ProcessName: processName || 'unknown',
          MainWindowTitle: title || '',
        };
      });
    } catch {
      return [];
    }
  }

  // =========================================================================
  // UI Automation — stubbed on macOS
  // =========================================================================

  /**
   * Get UI elements — stubbed on macOS.
   * macOS Accessibility API (AXUIElement) requires native bindings.
   * Returns a stub result so the agent doesn't crash and knows the limitation.
   */
  async getUIElements() {
    const windowTitle = this.getForegroundWindowTitle();
    return {
      window: windowTitle || 'unknown',
      elements: [],
      source: 'macos-stub',
    };
  }

  // =========================================================================
  // Command execution
  // =========================================================================

  async runCommand(command) {
    return new Promise((resolve) => {
      exec(command, { timeout: 10000 }, (err, stdout, stderr) => {
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
