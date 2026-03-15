// Tests for src/memory.js — Adaptive memory system
// Tests playbooks, failures, preferences, context, user profile, and recorded playbooks

const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a temp directory for test data to avoid polluting real data
const TEST_DATA_DIR = path.join(os.tmpdir(), `memory-test-${Date.now()}`);
const TEST_USER_PROFILE = path.join(TEST_DATA_DIR, 'omar.md');

// Patch DATA_DIR and USER_PROFILE_PATH before requiring Memory
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((...args) => actual.existsSync(...args)),
    readFileSync: jest.fn((...args) => actual.readFileSync(...args)),
    writeFileSync: jest.fn((...args) => actual.writeFileSync(...args)),
    mkdirSync: jest.fn((...args) => actual.mkdirSync(...args)),
    readdirSync: jest.fn((...args) => actual.readdirSync(...args)),
    unlinkSync: jest.fn((...args) => actual.unlinkSync(...args)),
  };
});

// We'll test Memory methods directly instead of mocking fs
// Reset mocks and use real fs for each test
beforeEach(() => {
  fs.existsSync.mockImplementation(jest.requireActual('fs').existsSync);
  fs.readFileSync.mockImplementation(jest.requireActual('fs').readFileSync);
  fs.writeFileSync.mockImplementation(jest.requireActual('fs').writeFileSync);
  fs.mkdirSync.mockImplementation(jest.requireActual('fs').mkdirSync);
  fs.readdirSync.mockImplementation(jest.requireActual('fs').readdirSync);
});

const Memory = require('../src/memory');

// =========================================================================
// Playbooks
// =========================================================================

describe('Memory: playbooks', () => {
  test('recordSuccess creates a new playbook entry', () => {
    const m = new Memory();
    m.playbooks = [];
    m._saveJSON = jest.fn(); // don't write to disk

    m.recordSuccess('open discord and message Mixo', 'discord', [
      { tool: 'focus_window', input: { title_pattern: 'Discord' } },
      { tool: 'computer', input: { action: 'key', text: 'ctrl+k' } },
    ], 5000);

    expect(m.playbooks.length).toBe(1);
    expect(m.playbooks[0].app).toBe('discord');
    expect(m.playbooks[0].actions.length).toBe(2);
    expect(m.playbooks[0].uses).toBe(1);
    expect(m.playbooks[0].avgTime).toBe(5000);
  });

  test('recordSuccess updates existing playbook on keyword match', () => {
    const m = new Memory();
    m.playbooks = [{
      keywords: ['open', 'discord', 'message', 'mixo'],
      app: 'discord',
      actions: [{ tool: 'old', input: {} }],
      timestamp: Date.now(),
      lastUsed: Date.now(),
      uses: 3,
      avgTime: 4000,
    }];
    m._saveJSON = jest.fn();

    m.recordSuccess('open discord and message mixo hey', 'discord', [
      { tool: 'focus_window', input: { title_pattern: 'Discord' } },
    ], 3000);

    expect(m.playbooks.length).toBe(1);
    expect(m.playbooks[0].uses).toBe(4);
    expect(m.playbooks[0].actions[0].tool).toBe('focus_window'); // updated
  });

  test('getPlaybook finds matching entry', () => {
    const m = new Memory();
    m.playbooks = [{
      keywords: ['discord', 'message', 'mixo'],
      app: 'discord',
      actions: [{ tool: 'focus_window', input: { title_pattern: 'Discord' } }],
      timestamp: Date.now(),
      lastUsed: Date.now(),
      uses: 5,
      avgTime: 3000,
    }];
    m._saveJSON = jest.fn();

    const result = m.getPlaybook('message mixo on discord', 'discord');
    expect(result).not.toBeNull();
    expect(result.app).toBe('discord');
  });

  test('getPlaybook returns null for unmatched query', () => {
    const m = new Memory();
    m.playbooks = [{
      keywords: ['discord', 'message'],
      app: 'discord',
      actions: [],
      timestamp: Date.now(),
      lastUsed: Date.now(),
      uses: 1,
      avgTime: 1000,
    }];
    m._saveJSON = jest.fn();

    const result = m.getPlaybook('open spotify and play music', 'spotify');
    expect(result).toBeNull();
  });

  test('playbooks are trimmed when exceeding MAX_PLAYBOOK_ENTRIES', () => {
    const m = new Memory();
    m.playbooks = [];
    m._saveJSON = jest.fn();

    // Add 305 entries
    for (let i = 0; i < 305; i++) {
      m.playbooks.push({
        keywords: [`task${i}`],
        app: 'test',
        actions: [],
        timestamp: Date.now(),
        lastUsed: Date.now(),
        uses: i, // higher i = more uses = kept
        avgTime: 1000,
      });
    }

    m.recordSuccess('new task', 'test', [], 1000);

    expect(m.playbooks.length).toBeLessThanOrEqual(300);
  });
});

// =========================================================================
// Failures
// =========================================================================

describe('Memory: failures', () => {
  test('recordFailure creates a new failure entry', () => {
    const m = new Memory();
    m.failures = [];
    m._saveJSON = jest.fn();

    m.recordFailure('discord', 'computer(left_click)', 'wrong window', 'use focus_window');

    expect(m.failures.length).toBe(1);
    expect(m.failures[0].app).toBe('discord');
    expect(m.failures[0].action).toBe('computer(left_click)');
    expect(m.failures[0].fix).toBe('use focus_window');
  });

  test('recordFailure deduplicates same app+action', () => {
    const m = new Memory();
    m.failures = [];
    m._saveJSON = jest.fn();

    m.recordFailure('discord', 'click_taskbar', 'wrong window', '');
    m.recordFailure('discord', 'click_taskbar', 'wrong window again', 'use focus_window');

    expect(m.failures.length).toBe(1);
    expect(m.failures[0].occurrences).toBe(2);
    expect(m.failures[0].fix).toBe('use focus_window');
  });

  test('getFailuresForApp returns sorted by occurrences', () => {
    const m = new Memory();
    m.failures = [
      { app: 'discord', action: 'a', outcome: 'x', fix: '', occurrences: 1, timestamp: 1 },
      { app: 'discord', action: 'b', outcome: 'y', fix: '', occurrences: 5, timestamp: 2 },
      { app: 'chrome', action: 'c', outcome: 'z', fix: '', occurrences: 10, timestamp: 3 },
    ];

    const result = m.getFailuresForApp('discord');
    expect(result.length).toBe(2);
    expect(result[0].action).toBe('b'); // most occurrences first
    expect(result[1].action).toBe('a');
  });

  test('getFailuresForApp filters by app', () => {
    const m = new Memory();
    m.failures = [
      { app: 'discord', action: 'a', outcome: 'x', fix: '', occurrences: 1, timestamp: 1 },
      { app: 'chrome', action: 'b', outcome: 'y', fix: '', occurrences: 1, timestamp: 2 },
    ];

    const discord = m.getFailuresForApp('discord');
    const chrome = m.getFailuresForApp('chrome');
    expect(discord.length).toBe(1);
    expect(chrome.length).toBe(1);
    expect(discord[0].app).toBe('discord');
    expect(chrome[0].app).toBe('chrome');
  });
});

// =========================================================================
// Preferences
// =========================================================================

describe('Memory: preferences', () => {
  test('setPreference stores key-value pair', () => {
    const m = new Memory();
    m._saveJSON = jest.fn();

    m.setPreference('default_browser', 'chrome');
    expect(m.getPreference('default_browser')).toBe('chrome');
  });

  test('getPreference returns null for unknown key', () => {
    const m = new Memory();
    expect(m.getPreference('nonexistent')).toBeNull();
  });

  test('setPreference updates existing preference', () => {
    const m = new Memory();
    m._saveJSON = jest.fn();

    m.setPreference('theme', 'dark');
    m.setPreference('theme', 'light');
    expect(m.getPreference('theme')).toBe('light');
  });
});

// =========================================================================
// Context
// =========================================================================

describe('Memory: context', () => {
  test('addContext stores a fact', () => {
    const m = new Memory();
    m.context = []; // clear any loaded data
    m._saveJSON = jest.fn();

    m.addContext('User has a trip planned for April', 'conversation');
    expect(m.context.length).toBe(1);
    expect(m.context[0].content).toBe('User has a trip planned for April');
    expect(m.context[0].mentions).toBe(1);
  });

  test('addContext deduplicates by content', () => {
    const m = new Memory();
    m.context = []; // clear any loaded data
    m._saveJSON = jest.fn();

    m.addContext('User studies CS at UofC', 'conversation');
    m.addContext('user studies cs at uofc', 'conversation'); // same, different case

    expect(m.context.length).toBe(1);
    expect(m.context[0].mentions).toBe(2);
  });

  test('context trimmed to MAX_CONTEXT_ENTRIES', () => {
    const m = new Memory();
    m._saveJSON = jest.fn();

    for (let i = 0; i < 105; i++) {
      m.addContext(`fact ${i}`, 'test');
    }

    expect(m.context.length).toBeLessThanOrEqual(100);
  });
});

// =========================================================================
// buildContextForPrompt
// =========================================================================

describe('Memory: buildContextForPrompt', () => {
  test('includes playbook tips for matched app', () => {
    const m = new Memory();
    m.playbooks = [{
      keywords: ['message', 'discord'],
      app: 'discord',
      actions: [{ tool: 'focus_window', input: { title_pattern: 'Discord' } }],
      timestamp: Date.now(),
      lastUsed: Date.now(),
      uses: 5,
      avgTime: 3000,
    }];

    const ctx = m.buildContextForPrompt('discord', 'message on discord');
    expect(ctx).toContain('Learned patterns for discord');
    expect(ctx).toContain('focus_window');
  });

  test('includes failure warnings for matched app', () => {
    const m = new Memory();
    m.failures = [{
      app: 'discord',
      action: 'click_taskbar',
      outcome: 'wrong window',
      fix: 'use focus_window',
      occurrences: 3,
      timestamp: Date.now(),
    }];

    const ctx = m.buildContextForPrompt('discord', 'open discord');
    expect(ctx).toContain('Known issues for discord');
    expect(ctx).toContain('click_taskbar');
    expect(ctx).toContain('use focus_window');
  });

  test('includes user preferences', () => {
    const m = new Memory();
    m.preferences = {
      default_browser: { value: 'chrome', updatedAt: Date.now() },
    };

    const ctx = m.buildContextForPrompt(null, 'open browser');
    expect(ctx).toContain('User preferences');
    expect(ctx).toContain('chrome');
  });

  test('includes user context facts', () => {
    const m = new Memory();
    m.context = [{
      content: 'User has a trip planned for April',
      source: 'conversation',
      timestamp: Date.now(),
      lastMentioned: Date.now(),
      mentions: 1,
    }];

    const ctx = m.buildContextForPrompt(null, 'anything');
    expect(ctx).toContain('User context');
    expect(ctx).toContain('trip planned for April');
  });

  test('includes user profile when loaded', () => {
    const m = new Memory();
    m.userProfile = 'Omar is a CS student at UofC';

    const ctx = m.buildContextForPrompt(null, 'hello');
    expect(ctx).toContain('User profile');
    expect(ctx).toContain('CS student');
  });

  test('returns empty string when no context available', () => {
    const m = new Memory();
    m.playbooks = [];
    m.failures = [];
    m.preferences = {};
    m.context = [];
    m.userProfile = '';
    m.recordedPlaybooks = [];

    const ctx = m.buildContextForPrompt(null, 'hello');
    expect(ctx).toBe('');
  });
});

// =========================================================================
// Recorded playbooks (from recorder.js)
// =========================================================================

describe('Memory: recorded playbooks', () => {
  test('getRecordedContext returns traces for matching app', () => {
    const m = new Memory();
    m.recordedPlaybooks = [{
      taskId: 'discord-dm',
      domain: 'messaging',
      app: 'discord',
      instruction: 'Send a DM on Discord',
      executionContext: {
        foregroundBefore: 'Chrome',
        foregroundAfter: 'Discord',
        cursorStart: { x: 100, y: 200 },
        cursorEnd: { x: 500, y: 300 },
        ocrLandmarks: [
          { label: 'Friends', x: 50, y: 100, confidence: 95 },
        ],
        elapsed: 8000,
      },
    }];

    const ctx = m.getRecordedContext('discord', 'message someone');
    expect(ctx).toContain('Recorded execution traces');
    expect(ctx).toContain('Send a DM on Discord');
    expect(ctx).toContain('Chrome');
    expect(ctx).toContain('Discord');
    expect(ctx).toContain('Friends');
  });

  test('getRecordedContext returns empty for unmatched app', () => {
    const m = new Memory();
    m.recordedPlaybooks = [{
      taskId: 'discord-dm',
      app: 'discord',
      instruction: 'Send a DM on Discord',
      executionContext: {},
    }];

    const ctx = m.getRecordedContext('spotify', 'play music');
    expect(ctx).toBe('');
  });

  test('getRecordedContext matches by task keywords', () => {
    const m = new Memory();
    m.recordedPlaybooks = [{
      taskId: 'chrome-search',
      app: 'chrome',
      instruction: 'Search Google for restaurants',
      executionContext: {
        foregroundBefore: 'Desktop',
        foregroundAfter: 'Chrome',
        cursorStart: { x: 0, y: 0 },
        cursorEnd: { x: 500, y: 300 },
        elapsed: 5000,
      },
    }];

    const ctx = m.getRecordedContext(null, 'search for something on google');
    expect(ctx).toContain('Search Google for restaurants');
  });

  test('getRecordedContext returns empty when no playbooks', () => {
    const m = new Memory();
    m.recordedPlaybooks = [];

    const ctx = m.getRecordedContext('discord', 'anything');
    expect(ctx).toBe('');
  });
});

// =========================================================================
// Keyword extraction
// =========================================================================

describe('Memory: keyword extraction', () => {
  test('extracts meaningful keywords, skips stopwords', () => {
    const m = new Memory();
    const kw = m._extractKeywords('hey jarvis can you just open discord for me please');
    expect(kw).toContain('open');
    expect(kw).toContain('discord');
    expect(kw).not.toContain('hey');
    expect(kw).not.toContain('jarvis');
    expect(kw).not.toContain('can');
    expect(kw).not.toContain('you');
    expect(kw).not.toContain('just');
    expect(kw).not.toContain('please');
  });

  test('filters words shorter than 3 chars', () => {
    const m = new Memory();
    const kw = m._extractKeywords('go to the dm on it');
    expect(kw).not.toContain('go');
    expect(kw).not.toContain('to');
    expect(kw).not.toContain('on');
    expect(kw).not.toContain('it');
  });

  test('lowercases everything', () => {
    const m = new Memory();
    const kw = m._extractKeywords('Open Discord AND Message Mixo');
    for (const k of kw) {
      expect(k).toBe(k.toLowerCase());
    }
  });
});
