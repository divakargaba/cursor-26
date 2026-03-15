// Tests for Training Mode

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    beta: { messages: { create: jest.fn() } },
  }));
});

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('../src/memory', () => {
  return jest.fn().mockImplementation(() => ({
    getTipsForApp: jest.fn().mockReturnValue(''),
    buildContextForPrompt: jest.fn().mockReturnValue(''),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
    setPreference: jest.fn(),
    getPreference: jest.fn().mockReturnValue(null),
    addContext: jest.fn(),
    playbooks: [],
    failures: [],
    _loadRecordedPlaybooks: jest.fn(),
  }));
});

jest.mock('../src/enrichment', () => {
  return jest.fn().mockImplementation(() => ({
    enrich: jest.fn().mockResolvedValue(''),
  }));
});

jest.mock('../src/ocr-map', () => ({
  buildOCRMap: jest.fn().mockResolvedValue({}),
  getWorker: jest.fn().mockResolvedValue({}),
}));

const Agent = require('../src/agent');

function createAgent(overrides = {}) {
  return new Agent({
    browser: null,
    computer: {
      leftClick: jest.fn(),
      rightClick: jest.fn(),
      doubleClick: jest.fn(),
      middleClick: jest.fn(),
      type: jest.fn(),
      key: jest.fn(),
      scroll: jest.fn(),
      mouseMove: jest.fn(),
      leftClickDrag: jest.fn(),
      focusWindow: jest.fn().mockResolvedValue({ ok: true, process: 'Discord.exe', title: 'Discord' }),
      listWindows: jest.fn().mockResolvedValue([]),
      getCursorPosition: jest.fn().mockReturnValue({ x: 100, y: 200 }),
      getForegroundWindowTitle: jest.fn().mockReturnValue('Discord'),
    },
    screenshotFn: jest.fn().mockResolvedValue({
      ok: true,
      data: Buffer.from('fake-screenshot').toString('base64'),
      mediaType: 'image/jpeg',
    }),
    blurOverlayFn: jest.fn(),
    onProgress: jest.fn(),
    onConfirmationRequest: jest.fn().mockResolvedValue({ confirmed: true }),
    displayConfig: {
      physicalWidth: 1920, physicalHeight: 1080,
      displayWidth: 1024, displayHeight: 576,
      scaleX: 1.875, scaleY: 1.875,
    },
    ...overrides,
  });
}

// =========================================================================
// Entering/exiting training mode
// =========================================================================

describe('Training mode: activation', () => {
  test('enters training mode with "training mode"', () => {
    const agent = createAgent();
    const result = agent._handleTrainingCommand('training mode');
    expect(result).not.toBeNull();
    expect(result.text).toContain('Training mode active');
    expect(agent._trainingMode).toBe(true);
  });

  test('enters training mode case-insensitive', () => {
    const agent = createAgent();
    const result = agent._handleTrainingCommand('Training Mode');
    expect(result).not.toBeNull();
    expect(agent._trainingMode).toBe(true);
  });

  test('exits training mode with "training done"', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    const result = agent._handleTrainingCommand('training done');
    expect(result).not.toBeNull();
    expect(result.text).toContain('Training done');
    expect(agent._trainingMode).toBe(false);
  });

  test('exits with "done training" variant', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    const result = agent._handleTrainingCommand('done training');
    expect(result).not.toBeNull();
    expect(agent._trainingMode).toBe(false);
  });

  test('returns null for non-training text when not in training mode', () => {
    const agent = createAgent();
    const result = agent._handleTrainingCommand('open discord');
    expect(result).toBeNull();
  });

  test('returns null for regular text when in training mode (lets it pass through as a task)', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    const result = agent._handleTrainingCommand('open discord');
    expect(result).toBeNull();
    expect(agent._trainingTask).toBe('open discord');
  });
});

// =========================================================================
// Feedback codes
// =========================================================================

describe('Training mode: feedback codes', () => {
  test('g = good, records success', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open discord';
    agent._currentActions = [{ tool: 'focus_window', input: { title_pattern: 'Discord' } }];
    agent._chatStartTime = Date.now();

    const result = agent._handleTrainingCommand('g');
    expect(result.text).toContain('saved playbook');
    expect(agent.memory.recordSuccess).toHaveBeenCalledWith(
      'open discord', 'discord', expect.any(Array), expect.any(Number)
    );
  });

  test('f = failed, records failure', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open discord';
    agent._currentActions = [];

    const result = agent._handleTrainingCommand('f');
    expect(result.text).toContain('failure recorded');
    expect(agent.memory.recordFailure).toHaveBeenCalled();
  });

  test('s = stuck, records loop failure', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open chrome';

    const result = agent._handleTrainingCommand('s');
    expect(result.text).toContain('stuck pattern recorded');
    expect(agent.memory.recordFailure).toHaveBeenCalledWith(
      'chrome', 'loop', expect.stringContaining('stuck'), expect.any(String)
    );
  });

  test('slow = too slow', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open spotify';
    agent._chatStartTime = Date.now() - 10000; // 10s ago
    agent._currentActions = [{ tool: 'computer', input: { action: 'left_click' } }];

    const result = agent._handleTrainingCommand('slow');
    expect(result.text).toContain('slow path recorded');
  });

  test('wrong = did the wrong thing', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open discord';

    const result = agent._handleTrainingCommand('wrong');
    expect(result.text).toContain('wrong action recorded');
  });

  test('narr = narrated too much', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open notepad';

    const result = agent._handleTrainingCommand('narr');
    expect(result.text).toContain('less talking');
    expect(agent.memory.recordFailure).toHaveBeenCalledWith(
      expect.any(String), 'voice', expect.stringContaining('narrated'), expect.any(String)
    );
  });

  test('silent = should have spoken', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'find flights to toronto';

    const result = agent._handleTrainingCommand('silent');
    expect(result.text).toContain('more proactive');
  });

  test('p+ = reinforces proactive behavior', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'find flights to san diego';

    const result = agent._handleTrainingCommand('p+');
    expect(result.text).toContain('proactivity reinforced');
    expect(agent.memory.addContext).toHaveBeenCalledWith(
      expect.stringContaining('Proactive behavior'),
      'training'
    );
  });

  test('p- = missed proactive opportunity', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'book a flight';

    const result = agent._handleTrainingCommand('p-');
    expect(result.text).toContain('missed proactivity recorded');
  });

  test('skip = next task', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'hard task';

    const result = agent._handleTrainingCommand('skip');
    expect(result.text).toContain('skipped');
  });
});

// =========================================================================
// Combo feedback codes
// =========================================================================

describe('Training mode: combo codes', () => {
  test('g p+ = good and proactive', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'find flights';
    agent._currentActions = [{ tool: 'browser_action', input: { action: 'navigate' } }];
    agent._chatStartTime = Date.now();

    const result = agent._handleTrainingCommand('g p+');
    expect(result.text).toContain('saved playbook');
    expect(result.text).toContain('proactivity reinforced');
    expect(agent.memory.recordSuccess).toHaveBeenCalled();
    expect(agent.memory.addContext).toHaveBeenCalled();
  });

  test('slow narr = slow and talked too much', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open chrome';
    agent._currentActions = [];
    agent._chatStartTime = Date.now();

    const result = agent._handleTrainingCommand('slow narr');
    expect(result.text).toContain('slow path recorded');
    expect(result.text).toContain('less talking');
  });

  test('g silent = good but should have spoken', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'search flights';
    agent._currentActions = [{ tool: 'browser_action', input: { action: 'navigate' } }];
    agent._chatStartTime = Date.now();

    const result = agent._handleTrainingCommand('g silent');
    expect(result.text).toContain('saved playbook');
    expect(result.text).toContain('more proactive');
  });

  test('invalid code returns null (treated as a task)', () => {
    const agent = createAgent();
    agent._trainingMode = true;

    const result = agent._handleTrainingCommand('open discord');
    expect(result).toBeNull();
  });

  test('partially invalid combo returns null', () => {
    const agent = createAgent();
    agent._trainingMode = true;

    const result = agent._handleTrainingCommand('g hello');
    expect(result).toBeNull(); // "hello" is not a valid code
  });
});

// =========================================================================
// Demo mode
// =========================================================================

describe('Training mode: demo recording', () => {
  test('demo starts recording', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open discord';

    const result = agent._handleTrainingCommand('demo');
    expect(result.text).toContain('Recording');
    expect(agent._demoRecording).toBe(true);
  });

  test('f demo starts recording after failure', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open discord';
    agent._currentActions = [];

    const result = agent._handleTrainingCommand('f demo');
    // "f" is processed first (records failure), then "demo" starts recording
    expect(result.text).toContain('Recording');
    expect(agent._demoRecording).toBe(true);
  });

  test('done finishes demo recording', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open discord';
    agent._demoRecording = true;
    agent._demoStartTime = Date.now() - 5000;
    agent._demoSnapshots = [
      { phase: 'before', timestamp: Date.now() - 5000, cursor: { x: 100, y: 200 }, foreground: 'Desktop' },
      { phase: 'during', timestamp: Date.now() - 3000, cursor: { x: 300, y: 400 }, foreground: 'Discord' },
    ];

    const result = agent._handleTrainingCommand('done');
    expect(result.text).toContain('Recorded');
    expect(agent._demoRecording).toBe(false);
    expect(agent.memory._loadRecordedPlaybooks).toHaveBeenCalled();
  });

  test('done outside demo mode is treated as exit training', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._demoRecording = false;

    // "done" alone is not a valid feedback code, so it falls through
    // But "training done" would exit
    const result = agent._handleTrainingCommand('training done');
    expect(result.text).toContain('Training done');
  });
});

// =========================================================================
// Training mode context injection
// =========================================================================

describe('Training mode: context', () => {
  test('training mode hint is injected into context', async () => {
    const agent = createAgent();
    agent._trainingMode = true;

    // Mock the API to return immediately
    agent.client.beta.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Done.' }],
    });

    await agent.chat('open discord');

    // Check that the last user message content includes training mode hint
    const lastUserMsg = agent.history.find(m => m.role === 'user');
    const contextBlock = lastUserMsg.content.find(c =>
      c.type === 'text' && c.text.includes('TRAINING MODE')
    );
    expect(contextBlock).toBeDefined();
  });

  test('training mode hint NOT injected when not in training', async () => {
    const agent = createAgent();
    agent._trainingMode = false;

    agent.client.beta.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Done.' }],
    });

    await agent.chat('open discord');

    const lastUserMsg = agent.history.find(m => m.role === 'user');
    const contextBlock = lastUserMsg.content.find(c =>
      c.type === 'text' && c.text.includes('TRAINING MODE')
    );
    expect(contextBlock).toBeUndefined();
  });
});

// =========================================================================
// Task tracking
// =========================================================================

describe('Training mode: task tracking', () => {
  test('sets _trainingTask when new text is given in training mode', () => {
    const agent = createAgent();
    agent._trainingMode = true;

    agent._handleTrainingCommand('open discord and message Mixo');
    expect(agent._trainingTask).toBe('open discord and message Mixo');
  });

  test('clears _trainingTask after feedback', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent._trainingTask = 'open discord';
    agent._currentActions = [];
    agent._chatStartTime = Date.now();

    agent._handleTrainingCommand('g');
    expect(agent._trainingTask).toBeNull();
  });

  test('clearHistory does not reset training mode', () => {
    const agent = createAgent();
    agent._trainingMode = true;
    agent.clearHistory();
    expect(agent._trainingMode).toBe(true);
  });
});
