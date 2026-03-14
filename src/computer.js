// src/computer.js — Platform dispatcher
// Detects OS and requires the correct platform-specific implementation.
// API surface is identical: leftClick, rightClick, doubleClick, mouseMove,
// leftClickDrag, scroll, type, key, getCursorPosition, focusWindow,
// listWindows, getUIElements, getForegroundWindowTitle, runCommand.

const platform = process.platform;

let Computer;
if (platform === 'win32') {
  Computer = require('./computer.windows');
} else if (platform === 'darwin') {
  Computer = require('./computer.macos');
} else {
  // Unsupported platform — provide a stub that throws clear errors
  class UnsupportedComputer {
    constructor() {
      console.warn(`[computer] Platform "${platform}" is not supported. Native actions will fail.`);
    }
    async leftClick() { throw new Error(`Native mouse control not implemented for ${platform}`); }
    async rightClick() { throw new Error(`Native mouse control not implemented for ${platform}`); }
    async middleClick() { throw new Error(`Native mouse control not implemented for ${platform}`); }
    async doubleClick() { throw new Error(`Native mouse control not implemented for ${platform}`); }
    async mouseMove() { throw new Error(`Native mouse control not implemented for ${platform}`); }
    async leftClickDrag() { throw new Error(`Native mouse control not implemented for ${platform}`); }
    async scroll() { throw new Error(`Native mouse control not implemented for ${platform}`); }
    async type() { throw new Error(`Native keyboard control not implemented for ${platform}`); }
    async key() { throw new Error(`Native keyboard control not implemented for ${platform}`); }
    getCursorPosition() { return { x: 0, y: 0 }; }
    getForegroundWindowTitle() { return ''; }
    async focusWindow() { return { ok: false, error: `focusWindow not implemented for ${platform}` }; }
    async listWindows() { return []; }
    async getUIElements() { return { window: 'unknown', elements: [], source: `${platform}-unimplemented` }; }
    async runCommand(command) {
      const { exec } = require('child_process');
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
  Computer = UnsupportedComputer;
}

module.exports = Computer;
