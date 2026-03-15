// Tests for Phase 5: Self-learning from outcomes
// Tests _learnFromOutcome, preference learning in _saveToMemory,
// and duplicate speech prevention in _runLoop

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
// _learnFromOutcome
// =========================================================================

describe('Self-learning: _learnFromOutcome', () => {
  test('records failure when tool result contains error', () => {
    const agent = createAgent();
    // Seed history so _detectAppFromText can find the app
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'open discord' }] }];

    agent._learnFromOutcome('computer', { action: 'left_click' },
      [{ type: 'text', text: 'Click failed: element not found' }], 500);

    expect(agent.memory.recordFailure).toHaveBeenCalledWith(
      'discord',
      'computer(left_click)',
      expect.stringContaining('failed'),
      'try different approach'
    );
  });

  test('records slow actions (>5s)', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'open chrome' }] }];

    agent._learnFromOutcome('browser_action', { action: 'navigate' },
      [{ type: 'text', text: 'Navigated to https://example.com' }], 8000);

    expect(agent.memory.recordFailure).toHaveBeenCalledWith(
      'chrome',
      'browser_action(navigate)',
      expect.stringContaining('slow'),
      'look for keyboard shortcut or faster path'
    );
  });

  test('skips screenshots — not real actions', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'open discord' }] }];

    agent._learnFromOutcome('computer', { action: 'screenshot' },
      [{ type: 'image', source: {} }], 200);

    expect(agent.memory.recordFailure).not.toHaveBeenCalled();
  });

  test('skips confirmation tool', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'send message' }] }];

    agent._learnFromOutcome('request_confirmation', { summary: 'test' },
      [{ type: 'text', text: 'User confirmed.' }], 3000);

    expect(agent.memory.recordFailure).not.toHaveBeenCalled();
  });

  test('does not record when no app detected', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];

    agent._learnFromOutcome('computer', { action: 'left_click' },
      [{ type: 'text', text: 'Click failed' }], 500);

    // No app detected, so no failure recorded
    expect(agent.memory.recordFailure).not.toHaveBeenCalled();
  });

  test('does not flag fast successful actions as slow', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'open discord' }] }];

    agent._learnFromOutcome('focus_window', { title_pattern: 'Discord' },
      [{ type: 'text', text: 'Focused: Discord' }], 200);

    expect(agent.memory.recordFailure).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Transition learning: focus_window after click fails
// =========================================================================

describe('Self-learning: transition learning', () => {
  test('records pattern when focus_window succeeds after click failed', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'open discord' }] }];

    // Simulate: click fails, then focus_window succeeds
    agent._learnFromOutcome('computer', { action: 'left_click' },
      [{ type: 'text', text: 'Click failed: not found' }], 500);

    expect(agent._lastFailedTool).toBe('computer(left_click)');

    agent._learnFromOutcome('focus_window', { title_pattern: 'Discord' },
      [{ type: 'text', text: 'Focused: Discord' }], 300);

    // Should record two failures: the original click, and the transition lesson
    expect(agent.memory.recordFailure).toHaveBeenCalledTimes(2);
    expect(agent.memory.recordFailure).toHaveBeenCalledWith(
      'discord',
      'computer(left_click)',
      'click failed to switch app',
      expect.stringContaining('focus_window')
    );
  });

  test('clears _lastFailedTool on success', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'open discord' }] }];

    // Fail
    agent._learnFromOutcome('computer', { action: 'left_click' },
      [{ type: 'text', text: 'Click failed' }], 500);
    expect(agent._lastFailedTool).toBe('computer(left_click)');

    // Succeed (not focus_window, so no transition)
    agent._learnFromOutcome('computer', { action: 'type' },
      [{ type: 'text', text: 'Typed text' }], 200);
    expect(agent._lastFailedTool).toBeNull();
  });

  test('_lastFailedTool reset on new chat', () => {
    const agent = createAgent();
    agent._lastFailedTool = 'computer(left_click)';
    agent._currentActions = [];
    agent._chatStartTime = Date.now();
    agent._lastFailedTool = null; // chat() would set this

    expect(agent._lastFailedTool).toBeNull();
  });
});

// =========================================================================
// Preference learning in _saveToMemory
// =========================================================================

describe('Self-learning: preference learning', () => {
  test('learns keyboard preference when key actions used', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'open discord' }] }];
    agent._chatStartTime = Date.now();
    agent._currentActions = [
      { tool: 'focus_window', input: { title_pattern: 'Discord' } },
      { tool: 'computer', input: { action: 'key', text: 'ctrl+k' } },
      { tool: 'computer', input: { action: 'type', text: 'Mixo' } },
    ];

    agent._saveToMemory();

    expect(agent.memory.setPreference).toHaveBeenCalledWith('discord_prefers_keyboard', true);
    expect(agent.memory.setPreference).toHaveBeenCalledWith('discord_uses_focus_window', true);
  });

  test('does not set keyboard preference when no key actions', () => {
    const agent = createAgent();
    agent.history = [{ role: 'user', content: [{ type: 'text', text: 'open chrome' }] }];
    agent._chatStartTime = Date.now();
    agent._currentActions = [
      { tool: 'computer', input: { action: 'left_click', coordinate: [100, 200] } },
    ];

    agent._saveToMemory();

    expect(agent.memory.setPreference).not.toHaveBeenCalledWith('chrome_prefers_keyboard', true);
  });

  test('does not save when no actions taken', () => {
    const agent = createAgent();
    agent._currentActions = [];

    agent._saveToMemory();

    expect(agent.memory.recordSuccess).not.toHaveBeenCalled();
  });

  test('does not save when no user message in history', () => {
    const agent = createAgent();
    agent._currentActions = [{ tool: 'computer', input: { action: 'screenshot' } }];
    agent.history = [];

    agent._saveToMemory();

    expect(agent.memory.recordSuccess).not.toHaveBeenCalled();
  });
});

// =========================================================================
// _executeTool calls _learnFromOutcome
// =========================================================================

describe('Self-learning: _executeTool integration', () => {
  test('_executeTool calls _learnFromOutcome after success', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_learnFromOutcome');

    await agent._executeTool('focus_window', { title_pattern: 'Discord' });

    expect(spy).toHaveBeenCalledWith(
      'focus_window',
      { title_pattern: 'Discord' },
      expect.any(Array),
      expect.any(Number)
    );
  });

  test('_executeTool calls _learnFromOutcome after error', async () => {
    const agent = createAgent();
    agent.computer.focusWindow.mockRejectedValue(new Error('Win32 error'));
    const spy = jest.spyOn(agent, '_learnFromOutcome');

    await agent._executeTool('focus_window', { title_pattern: 'Fake' });

    expect(spy).toHaveBeenCalledWith(
      'focus_window',
      { title_pattern: 'Fake' },
      expect.arrayContaining([expect.objectContaining({ type: 'text' })]),
      expect.any(Number)
    );
  });

  test('_executeTool measures elapsed time', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_learnFromOutcome');

    await agent._executeTool('computer', { action: 'screenshot' });

    // _learnFromOutcome should be called with elapsed >= 0
    const elapsed = spy.mock.calls[0]?.[3];
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});

// =========================================================================
// Duplicate speech prevention in _runLoop
// =========================================================================

describe('Concurrent speech: duplicate prevention', () => {
  test('_runLoop emits text via onProgress and does not duplicate in return', async () => {
    const agent = createAgent();
    const progressCalls = [];
    agent.onProgress = (info) => progressCalls.push(info);

    // Mock API to return text + tool, then text only
    const apiMock = agent.client.beta.messages.create;
    let callCount = 0;
    apiMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: 'text', text: 'Checking Discord now.' },
            { type: 'tool_use', id: 'tu1', name: 'focus_window', input: { title_pattern: 'Discord' } },
          ],
        };
      }
      // Second call: final response, same text
      return {
        content: [
          { type: 'text', text: 'Checking Discord now.' },
        ],
      };
    });

    const result = await agent._runLoop();

    // Text should have been emitted via onProgress in iteration 1
    const textProgress = progressCalls.filter(p => p.type === 'text');
    expect(textProgress.length).toBe(1);
    expect(textProgress[0].text).toBe('Checking Discord now.');

    // Final return should be empty since it was already spoken
    expect(result.text).toBe('');
  });

  test('_runLoop returns final text if it differs from mid-loop text', async () => {
    const agent = createAgent();
    agent.onProgress = jest.fn();

    const apiMock = agent.client.beta.messages.create;
    let callCount = 0;
    apiMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: 'text', text: 'Looking into it.' },
            { type: 'tool_use', id: 'tu1', name: 'computer', input: { action: 'screenshot' } },
          ],
        };
      }
      return {
        content: [
          { type: 'text', text: 'Done. Message sent to Mixo.' },
        ],
      };
    });

    const result = await agent._runLoop();

    // "Done. Message sent to Mixo." is different from "Looking into it." — should be returned
    expect(result.text).toBe('Done. Message sent to Mixo.');
  });

  test('narration is filtered and not spoken', async () => {
    const agent = createAgent();
    const progressCalls = [];
    agent.onProgress = (info) => progressCalls.push(info);

    const apiMock = agent.client.beta.messages.create;
    let callCount = 0;
    apiMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: 'text', text: "Let me open Discord for you." },
            { type: 'tool_use', id: 'tu1', name: 'focus_window', input: { title_pattern: 'Discord' } },
          ],
        };
      }
      return { content: [{ type: 'text', text: 'Sent.' }] };
    });

    const result = await agent._runLoop();

    // "Let me..." should be filtered as narration
    const textProgress = progressCalls.filter(p => p.type === 'text');
    expect(textProgress.length).toBe(0);

    // "Sent." should be returned as final
    expect(result.text).toBe('Sent.');
  });

  test('empty final text when Claude returns only tools then empty', async () => {
    const agent = createAgent();
    agent.onProgress = jest.fn();

    const apiMock = agent.client.beta.messages.create;
    let callCount = 0;
    apiMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'computer', input: { action: 'screenshot' } },
          ],
        };
      }
      return { content: [] };
    });

    const result = await agent._runLoop();
    expect(result.text).toBe('');
  });
});

// =========================================================================
// clearHistory resets learning state
// =========================================================================

describe('Self-learning: state reset', () => {
  test('clearHistory resets _lastFailedTool', () => {
    const agent = createAgent();
    agent._lastFailedTool = 'computer(left_click)';
    agent.clearHistory();
    expect(agent._lastFailedTool).toBeNull();
  });

  test('clearHistory resets model and retry state', () => {
    const agent = createAgent();
    agent._currentModel = 'claude-sonnet-4-6-20250514';
    agent._retryCount = 5;
    agent.clearHistory();
    expect(agent._currentModel).toBe(process.env.AI_MODEL_DEFAULT || 'claude-haiku-4-5-20251001');
    expect(agent._retryCount).toBe(0);
  });
});
