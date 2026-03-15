// src/recorder.js — Task Execution Recorder
// Walks user through tasks, records EVERYTHING: screenshots, mouse coords,
// window state, timing, layout, clicks, keypresses — builds rich execution traces.
//
// Usage: node src/recorder.js
// It presents tasks one by one. You execute them manually.
// It watches and records every detail into data/recordings/*.json

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const Computer = require('./computer');
const { buildOCRMap } = require('./ocr-map');

const RECORDINGS_DIR = path.join(__dirname, '..', 'data', 'recordings');
const TASKS_FILE = path.join(__dirname, '..', 'data', 'recorder-tasks.json');

// ============================================================================
// Task definitions — grouped by domain
// ============================================================================

const DEFAULT_TASKS = [
  // --- Messaging ---
  { id: 'discord-dm', domain: 'messaging', app: 'discord', instruction: 'Open Discord and send a DM to any friend saying "hey, testing something real quick"', proactive_hints: ['check if user is online', 'check if DM or GC'] },
  { id: 'discord-gc', domain: 'messaging', app: 'discord', instruction: 'Send a message in any Discord group chat saying "test message"', proactive_hints: ['different from DM — uses channel not ctrl+k search'] },
  { id: 'whatsapp-msg', domain: 'messaging', app: 'whatsapp', instruction: 'Open WhatsApp and send a message to any contact saying "hey"', proactive_hints: ['check if contact is online'] },
  { id: 'teams-msg', domain: 'messaging', app: 'teams', instruction: 'Open Teams and send a message in any chat saying "test"', proactive_hints: ['teams has different shortcuts than discord'] },

  // --- Email ---
  { id: 'gmail-compose', domain: 'email', app: 'gmail', instruction: 'Open Gmail in the browser and compose a new email (don\'t send, just open compose)', proactive_hints: ['check drafts', 'verify recipient'] },
  { id: 'gmail-reply', domain: 'email', app: 'gmail', instruction: 'Open Gmail and reply to the most recent email with "Thanks, got it"', proactive_hints: ['check if reply-all needed', 'check time since last email'] },

  // --- Browser ---
  { id: 'chrome-search', domain: 'browser', app: 'chrome', instruction: 'Open Chrome and search Google for "best restaurants near me"', proactive_hints: ['could use address bar directly'] },
  { id: 'chrome-newtab', domain: 'browser', app: 'chrome', instruction: 'Open a new tab in Chrome and navigate to github.com', proactive_hints: ['ctrl+t is fastest'] },
  { id: 'edge-navigate', domain: 'browser', app: 'edge', instruction: 'Open Edge and go to youtube.com', proactive_hints: ['might already have a tab open'] },

  // --- Files & Apps ---
  { id: 'notepad-write', domain: 'productivity', app: 'notepad', instruction: 'Open Notepad and type "Meeting notes for March 15"', proactive_hints: ['could also use sticky notes'] },
  { id: 'open-spotify', domain: 'media', app: 'spotify', instruction: 'Open Spotify and play any song', proactive_hints: ['check if already playing'] },
  { id: 'open-settings', domain: 'system', app: 'settings', instruction: 'Open Windows Settings and navigate to Display settings', proactive_hints: ['win+i is fastest'] },

  // --- Multi-step ---
  { id: 'copy-paste-cross', domain: 'productivity', app: 'multi', instruction: 'Open Notepad, type "Hello World", select all, copy, then open a new Notepad and paste', proactive_hints: ['ctrl+a, ctrl+c, ctrl+v chain'] },
  { id: 'screenshot-save', domain: 'productivity', app: 'multi', instruction: 'Take a screenshot using Snipping Tool and save it to Desktop', proactive_hints: ['win+shift+s is fastest'] },

  // --- Travel/Research ---
  { id: 'flight-search', domain: 'travel', app: 'chrome', instruction: 'Search Google Flights for cheapest flight from Calgary to San Diego in April', proactive_hints: ['check weather at destination', 'check calendar conflicts', 'check baggage policy'] },
  { id: 'weather-check', domain: 'travel', app: 'chrome', instruction: 'Check the weather forecast for San Diego next week', proactive_hints: ['compare with home city weather'] },

  // --- Social ---
  { id: 'instagram-check', domain: 'social', app: 'instagram', instruction: 'Open Instagram and check your DMs', proactive_hints: ['might be in Edge not Chrome'] },

  // --- Window Management ---
  { id: 'switch-apps', domain: 'system', app: 'multi', instruction: 'Switch between 3 different open apps (Discord, Chrome, Spotify) one after another', proactive_hints: ['alt+tab vs focus_window vs taskbar click — which is fastest?'] },
  { id: 'snap-windows', domain: 'system', app: 'multi', instruction: 'Snap two windows side by side (any two apps)', proactive_hints: ['win+arrow keys'] },
];

// ============================================================================
// Recorder class
// ============================================================================

class TaskRecorder {
  constructor() {
    this.computer = new Computer();
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }

  async prompt(question) {
    return new Promise((resolve) => this.rl.question(question, resolve));
  }

  // Capture full system state snapshot
  async captureState() {
    const state = { timestamp: Date.now() };

    // Window list
    try {
      state.windows = await this.computer.listWindows();
    } catch { state.windows = []; }

    // Foreground window
    try {
      state.foregroundWindow = this.computer.getForegroundWindowTitle();
    } catch { state.foregroundWindow = ''; }

    // Cursor position
    try {
      state.cursor = this.computer.getCursorPosition();
    } catch { state.cursor = { x: 0, y: 0 }; }

    return state;
  }

  // Take screenshot + OCR, return { base64, ocrMap, dimensions }
  async captureScreenshot() {
    try {
      // Use Electron's desktopCapturer if available, otherwise skip
      // In standalone mode we use a simple approach
      const { execSync } = require('child_process');

      // PowerShell screenshot capture (works without Electron)
      const tmpPath = path.join(RECORDINGS_DIR, '_tmp_screenshot.jpg');
      execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${tmpPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $g.Dispose(); $bmp.Dispose() }"`, { windowsHide: true, timeout: 5000 });

      const imgBuffer = fs.readFileSync(tmpPath);
      const base64 = imgBuffer.toString('base64');

      // Run OCR
      let ocrMap = {};
      try {
        ocrMap = await buildOCRMap(imgBuffer);
      } catch { /* OCR optional */ }

      // Cleanup
      try { fs.unlinkSync(tmpPath); } catch {}

      return { base64, ocrMap, size: imgBuffer.length };
    } catch (err) {
      console.error('[recorder] Screenshot failed:', err.message);
      return { base64: null, ocrMap: {}, size: 0 };
    }
  }

  // Record a single task execution
  async recordTask(task) {
    console.log('\n' + '='.repeat(70));
    console.log(`TASK: ${task.instruction}`);
    console.log(`Domain: ${task.domain} | App: ${task.app}`);
    console.log('='.repeat(70));

    const recording = {
      taskId: task.id,
      domain: task.domain,
      app: task.app,
      instruction: task.instruction,
      proactiveHints: task.proactive_hints,
      startedAt: Date.now(),
      snapshots: [],
      success: false,
      notes: '',
    };

    // Capture BEFORE state
    console.log('\n[Recording initial state...]');
    const beforeState = await this.captureState();
    const beforeScreenshot = await this.captureScreenshot();
    recording.snapshots.push({
      phase: 'before',
      state: beforeState,
      ocrLabels: Object.keys(beforeScreenshot.ocrMap).slice(0, 50),
      ocrMap: beforeScreenshot.ocrMap,
      screenshotSize: beforeScreenshot.size,
      timestamp: Date.now(),
    });

    console.log(`  Windows open: ${beforeState.windows.length}`);
    console.log(`  Foreground: "${beforeState.foregroundWindow}"`);
    console.log(`  Cursor: (${beforeState.cursor.x}, ${beforeState.cursor.y})`);
    console.log(`  OCR labels: ${Object.keys(beforeScreenshot.ocrMap).length}`);

    // User executes the task
    console.log('\n>>> GO! Execute the task now. Press ENTER when done (or "skip" to skip) <<<');

    // Poll state every 500ms while user works
    let polling = true;
    const pollInterval = setInterval(async () => {
      if (!polling) return;
      try {
        const midState = await this.captureState();
        recording.snapshots.push({
          phase: 'during',
          state: midState,
          timestamp: Date.now(),
        });
      } catch {}
    }, 500);

    const answer = await this.prompt('');
    polling = false;
    clearInterval(pollInterval);

    if (answer.trim().toLowerCase() === 'skip') {
      recording.success = false;
      recording.notes = 'Skipped by user';
      recording.completedAt = Date.now();
      return recording;
    }

    // Capture AFTER state
    console.log('[Recording final state...]');
    const afterState = await this.captureState();
    const afterScreenshot = await this.captureScreenshot();
    recording.snapshots.push({
      phase: 'after',
      state: afterState,
      ocrLabels: Object.keys(afterScreenshot.ocrMap).slice(0, 50),
      ocrMap: afterScreenshot.ocrMap,
      screenshotSize: afterScreenshot.size,
      timestamp: Date.now(),
    });

    console.log(`  Foreground: "${afterState.foregroundWindow}"`);
    console.log(`  Cursor: (${afterState.cursor.x}, ${afterState.cursor.y})`);
    console.log(`  OCR labels: ${Object.keys(afterScreenshot.ocrMap).length}`);

    // User feedback
    const success = await this.prompt('Was the task successful? (y/n): ');
    recording.success = success.trim().toLowerCase().startsWith('y');

    const notes = await this.prompt('Any notes? (or press Enter to skip): ');
    recording.notes = notes.trim();

    recording.completedAt = Date.now();
    recording.elapsed = recording.completedAt - recording.startedAt;

    // Compute diffs
    recording.diff = {
      foregroundChanged: beforeState.foregroundWindow !== afterState.foregroundWindow,
      foregroundBefore: beforeState.foregroundWindow,
      foregroundAfter: afterState.foregroundWindow,
      cursorMoved: beforeState.cursor.x !== afterState.cursor.x || beforeState.cursor.y !== afterState.cursor.y,
      cursorBefore: beforeState.cursor,
      cursorAfter: afterState.cursor,
      windowCountBefore: beforeState.windows.length,
      windowCountAfter: afterState.windows.length,
      newWindows: afterState.windows
        .filter(aw => !beforeState.windows.some(bw => bw.MainWindowTitle === aw.MainWindowTitle))
        .map(w => w.MainWindowTitle),
      closedWindows: beforeState.windows
        .filter(bw => !afterState.windows.some(aw => aw.MainWindowTitle === bw.MainWindowTitle))
        .map(w => w.MainWindowTitle),
      newOCRLabels: Object.keys(afterScreenshot.ocrMap)
        .filter(k => !beforeScreenshot.ocrMap[k])
        .slice(0, 20),
      elapsed: recording.elapsed,
    };

    return recording;
  }

  // Convert recording to a playbook entry for memory.js
  recordingToPlaybook(recording) {
    if (!recording.success) return null;

    return {
      taskId: recording.taskId,
      domain: recording.domain,
      app: recording.app,
      instruction: recording.instruction,
      proactiveHints: recording.proactiveHints,
      executionContext: {
        foregroundBefore: recording.diff.foregroundBefore,
        foregroundAfter: recording.diff.foregroundAfter,
        cursorStart: recording.diff.cursorBefore,
        cursorEnd: recording.diff.cursorAfter,
        windowsOpened: recording.diff.newWindows,
        windowsClosed: recording.diff.closedWindows,
        ocrLandmarks: recording.snapshots
          .filter(s => s.ocrMap)
          .flatMap(s => Object.entries(s.ocrMap)
            .filter(([_, v]) => v.confidence > 70)
            .map(([label, v]) => ({ label, x: v.centerX, y: v.centerY, confidence: v.confidence }))
          )
          .slice(0, 30),
        elapsed: recording.elapsed,
      },
      recordedAt: Date.now(),
    };
  }

  // Run all tasks
  async run() {
    // Load tasks
    let tasks = DEFAULT_TASKS;
    if (fs.existsSync(TASKS_FILE)) {
      try {
        tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        console.log(`Loaded ${tasks.length} tasks from ${TASKS_FILE}`);
      } catch {
        console.log('Using default task list');
      }
    }

    // Check which tasks already have recordings
    const existing = new Set();
    try {
      const files = fs.readdirSync(RECORDINGS_DIR);
      for (const f of files) {
        if (f.endsWith('.json') && !f.startsWith('_')) {
          existing.add(f.replace('.json', ''));
        }
      }
    } catch {}

    const remaining = tasks.filter(t => !existing.has(t.id));

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║          JARVIS TASK EXECUTION RECORDER              ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Total tasks: ${tasks.length.toString().padEnd(39)}║`);
    console.log(`║  Already recorded: ${existing.size.toString().padEnd(34)}║`);
    console.log(`║  Remaining: ${remaining.length.toString().padEnd(41)}║`);
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  For each task:                                      ║');
    console.log('║  1. Read the instruction                             ║');
    console.log('║  2. Execute it on your PC (recorder watches)         ║');
    console.log('║  3. Press ENTER when done                            ║');
    console.log('║  4. Rate success + optional notes                    ║');
    console.log('║                                                      ║');
    console.log('║  Type "skip" to skip a task, "quit" to stop          ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    const startConfirm = await this.prompt('\nReady to start? (y/n): ');
    if (!startConfirm.trim().toLowerCase().startsWith('y')) {
      console.log('Aborted.');
      this.rl.close();
      return;
    }

    const playbooks = [];
    let completed = 0;

    for (const task of remaining) {
      const recording = await this.recordTask(task);

      // Save individual recording
      const filename = path.join(RECORDINGS_DIR, `${task.id}.json`);
      fs.writeFileSync(filename, JSON.stringify(recording, null, 2));
      console.log(`  Saved: ${filename}`);

      // Convert to playbook if successful
      if (recording.success) {
        const playbook = this.recordingToPlaybook(recording);
        if (playbook) {
          playbooks.push(playbook);
          console.log(`  ✓ Playbook entry created for "${task.id}"`);
        }
      }

      completed++;
      console.log(`\n  Progress: ${completed}/${remaining.length}`);

      // Check if user wants to quit
      if (recording.notes.toLowerCase() === 'quit') break;
    }

    // Save all playbooks
    if (playbooks.length > 0) {
      const playbookFile = path.join(RECORDINGS_DIR, '_playbooks_export.json');
      fs.writeFileSync(playbookFile, JSON.stringify(playbooks, null, 2));
      console.log(`\n✓ ${playbooks.length} playbook entries exported to ${playbookFile}`);
    }

    console.log(`\nDone! ${completed} tasks recorded, ${playbooks.length} successful playbooks.`);
    this.rl.close();
  }
}

// ============================================================================
// Main
// ============================================================================

if (require.main === module) {
  const recorder = new TaskRecorder();
  recorder.run().catch(err => {
    console.error('Recorder error:', err);
    process.exit(1);
  });
}

module.exports = TaskRecorder;
