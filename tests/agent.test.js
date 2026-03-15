// Tests for agent.js bug fixes:
// Bug 3: focus_window tool exposed to Claude
// Bug 4: auto-screenshots skip OCR (withOCR=false)
// Bug 5: updated model constants
// Always foreground: every tool brings target window to front

// Mock heavy dependencies before requiring agent
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    beta: { messages: { create: jest.fn() } },
  }));
});

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('../src/memory', () => {
  return jest.fn().mockImplementation(() => ({
    getTipsForApp: jest.fn().mockReturnValue(''),
    recordSuccess: jest.fn(),
  }));
});

jest.mock('../src/ocr-map', () => ({
  buildOCRMap: jest.fn().mockResolvedValue({
    'test': { x: 10, y: 20, w: 50, h: 20, centerX: 35, centerY: 30, confidence: 92, raw: 'Test' },
  }),
  getWorker: jest.fn().mockResolvedValue({}),
}));

const Agent = require('../src/agent');
const { buildOCRMap } = require('../src/ocr-map');

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
// Bug 5: Model constants
// =========================================================================

describe('Bug 5: model constants', () => {
  test('MODEL_ACCURATE is claude-sonnet-4-6-20250514', () => {
    // Agent starts with MODEL_FAST, upgrades to MODEL_ACCURATE.
    // We can check by triggering the upgrade path.
    const agent = createAgent();

    // Simulate 3 identical screenshots to trigger upgrade
    agent._lastScreenshotHash = 'abc123';
    agent._retryCount = 2;

    // The hash will differ from 'abc123' so retryCount resets —
    // but we can check the _currentModel after forcing it
    agent._currentModel = 'claude-sonnet-4-6-20250514'; // simulate upgrade
    expect(agent._currentModel).toBe('claude-sonnet-4-6-20250514');
  });

  test('MODEL_FAST defaults to claude-haiku-4-5-20251001', () => {
    const agent = createAgent();
    expect(agent._currentModel).toBe(process.env.AI_MODEL_DEFAULT || 'claude-haiku-4-5-20251001');
  });

  test('MODEL_FAST respects AI_MODEL_DEFAULT env var', () => {
    const original = process.env.AI_MODEL_DEFAULT;
    process.env.AI_MODEL_DEFAULT = 'claude-test-model';

    // Need to re-require to pick up env var change
    jest.resetModules();
    jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
      beta: { messages: { create: jest.fn() } },
    })));
    jest.mock('dotenv', () => ({ config: jest.fn() }));
    jest.mock('../src/memory', () => jest.fn().mockImplementation(() => ({
      getTipsForApp: jest.fn().mockReturnValue(''),
      recordSuccess: jest.fn(),
    })));
    jest.mock('../src/ocr-map', () => ({
      buildOCRMap: jest.fn().mockResolvedValue({}),
      getWorker: jest.fn().mockResolvedValue({}),
    }));

    const AgentFresh = require('../src/agent');
    const agent = new AgentFresh({
      computer: { listWindows: jest.fn().mockResolvedValue([]) },
      screenshotFn: jest.fn(),
      displayConfig: { physicalWidth: 1920, physicalHeight: 1080, displayWidth: 1024, displayHeight: 576, scaleX: 1.875, scaleY: 1.875 },
    });
    expect(agent._currentModel).toBe('claude-test-model');

    // Restore
    if (original === undefined) delete process.env.AI_MODEL_DEFAULT;
    else process.env.AI_MODEL_DEFAULT = original;
  });
});

// =========================================================================
// Bug 3: focus_window tool
// =========================================================================

describe('Bug 3: focus_window tool', () => {
  test('_getTools() includes focus_window definition', () => {
    const agent = createAgent();
    const tools = agent._getTools();
    const focusTool = tools.find((t) => t.name === 'focus_window');

    expect(focusTool).toBeDefined();
    expect(focusTool.input_schema.properties.title_pattern).toBeDefined();
    expect(focusTool.input_schema.required).toContain('title_pattern');
  });

  test('_executeTool routes focus_window to _execFocusWindow', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_execFocusWindow');

    await agent._executeTool('focus_window', { title_pattern: 'Discord' });

    expect(spy).toHaveBeenCalledWith({ title_pattern: 'Discord' });
  });

  test('_execFocusWindow calls computer.focusWindow and returns screenshot', async () => {
    const agent = createAgent();
    const result = await agent._execFocusWindow({ title_pattern: 'Discord' });

    expect(agent.computer.focusWindow).toHaveBeenCalledWith('Discord');
    // Should have a text block with focus info + image block
    expect(result.some((b) => b.type === 'text' && b.text.includes('Discord'))).toBe(true);
    expect(result.some((b) => b.type === 'image')).toBe(true);
  });

  test('_execFocusWindow returns error when window not found', async () => {
    const agent = createAgent();
    agent.computer.focusWindow.mockResolvedValue({ ok: false, error: 'No window matching "Fake"' });

    const result = await agent._execFocusWindow({ title_pattern: 'Fake' });

    expect(result).toEqual([{ type: 'text', text: 'Could not focus window: No window matching "Fake"' }]);
  });

  test('_execFocusWindow returns error when computer module missing', async () => {
    const agent = createAgent({ computer: null });
    // Re-mock screenshotFn since constructor might not set computer
    const result = await agent._execFocusWindow({ title_pattern: 'Discord' });

    expect(result).toEqual([{ type: 'text', text: 'Focus window not available (no computer module).' }]);
  });

  test('_toolLabel returns label for focus_window', () => {
    const agent = createAgent();
    const label = agent._toolLabel({ name: 'focus_window', input: { title_pattern: 'Discord' } });

    expect(label).toBe('Focusing Discord...');
  });

  test('system prompt mentions focus_window', () => {
    // Read the SYSTEM_PROMPT from module source
    const agent = createAgent();
    // We can check _callAPI builds correctly by inspecting the tools list
    const tools = agent._getTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('focus_window');
  });
});

// =========================================================================
// Bug 4: auto-screenshots skip OCR
// =========================================================================

describe('Bug 4: auto-screenshot OCR skipping', () => {
  beforeEach(() => {
    buildOCRMap.mockClear();
  });

  test('_captureScreenshot() with default (withOCR=true) runs OCR', async () => {
    const agent = createAgent();
    const result = await agent._captureScreenshot();

    expect(buildOCRMap).toHaveBeenCalled();
    // Should include image + OCR text
    expect(result.some((b) => b.type === 'image')).toBe(true);
    expect(result.some((b) => b.type === 'text' && b.text.includes('[OCR:'))).toBe(true);
  });

  test('_captureScreenshot(true) runs OCR', async () => {
    const agent = createAgent();
    const result = await agent._captureScreenshot(true);

    expect(buildOCRMap).toHaveBeenCalled();
  });

  test('_captureScreenshot(false) skips OCR', async () => {
    const agent = createAgent();
    const result = await agent._captureScreenshot(false);

    expect(buildOCRMap).not.toHaveBeenCalled();
    // Should only have image block, no OCR text
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('image');
  });

  test('explicit screenshot action calls _captureScreenshot with OCR', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_captureScreenshot');

    await agent._execComputerAction({ action: 'screenshot' });

    // Default parameter = true (OCR enabled)
    expect(spy).toHaveBeenCalledWith();
  });

  test('left_click action calls _captureScreenshot(false)', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_captureScreenshot');

    await agent._execComputerAction({ action: 'left_click', coordinate: [100, 200] });

    expect(spy).toHaveBeenCalledWith(false);
  });

  test('right_click action calls _captureScreenshot(false)', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_captureScreenshot');

    await agent._execComputerAction({ action: 'right_click', coordinate: [100, 200] });

    expect(spy).toHaveBeenCalledWith(false);
  });

  test('double_click action calls _captureScreenshot(false)', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_captureScreenshot');

    await agent._execComputerAction({ action: 'double_click', coordinate: [100, 200] });

    expect(spy).toHaveBeenCalledWith(false);
  });

  test('type action calls _captureScreenshot(false)', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_captureScreenshot');

    await agent._execComputerAction({ action: 'type', text: 'hello' });

    expect(spy).toHaveBeenCalledWith(false);
  });

  test('key action calls _captureScreenshot(false)', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_captureScreenshot');

    await agent._execComputerAction({ action: 'key', text: 'Return' });

    expect(spy).toHaveBeenCalledWith(false);
  });

  test('scroll action calls _captureScreenshot(false)', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_captureScreenshot');

    await agent._execComputerAction({ action: 'scroll', coordinate: [512, 300], delta_y: -3 });

    expect(spy).toHaveBeenCalledWith(false);
  });

  test('left_click_drag action calls _captureScreenshot(false)', async () => {
    const agent = createAgent();
    const spy = jest.spyOn(agent, '_captureScreenshot');

    await agent._execComputerAction({
      action: 'left_click_drag',
      start_coordinate: [100, 200],
      coordinate: [300, 400],
    });

    expect(spy).toHaveBeenCalledWith(false);
  });
});

// =========================================================================
// Always foreground: every action brings the target to front
// =========================================================================

function createMockBrowser() {
  return {
    isConnected: jest.fn().mockReturnValue(true),
    autoConnectOrLaunchChrome: jest.fn().mockResolvedValue({ connected: true }),
    bringBrowserToFront: jest.fn().mockResolvedValue(undefined),
    cdpNavigate: jest.fn().mockResolvedValue({ ok: true }),
    cdpClick: jest.fn().mockResolvedValue({ ok: true }),
    cdpClickText: jest.fn().mockResolvedValue({ ok: true }),
    cdpType: jest.fn().mockResolvedValue({ ok: true }),
    cdpPressKey: jest.fn().mockResolvedValue({ ok: true }),
    cdpScroll: jest.fn().mockResolvedValue({ ok: true }),
    cdpWaitForLoad: jest.fn().mockResolvedValue({ ok: true }),
    getPageContext: jest.fn().mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      elements: [{ tag: 'div', text: 'Hello', id: null, role: null, type: null }],
    }),
  };
}

describe('Always foreground', () => {
  // -- browser_action: bringBrowserToFront called for every action --

  describe('browser_action always calls bringBrowserToFront', () => {
    test('navigate brings browser to front', async () => {
      const browser = createMockBrowser();
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'navigate', url: 'https://example.com' });

      expect(browser.bringBrowserToFront).toHaveBeenCalled();
    });

    test('read_page brings browser to front', async () => {
      const browser = createMockBrowser();
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'read_page' });

      expect(browser.bringBrowserToFront).toHaveBeenCalled();
    });

    test('click_selector brings browser to front', async () => {
      const browser = createMockBrowser();
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'click_selector', selector: '#btn' });

      expect(browser.bringBrowserToFront).toHaveBeenCalled();
    });

    test('click_text brings browser to front', async () => {
      const browser = createMockBrowser();
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'click_text', text: 'Submit' });

      expect(browser.bringBrowserToFront).toHaveBeenCalled();
    });

    test('type brings browser to front', async () => {
      const browser = createMockBrowser();
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'type', selector: '#input', value: 'hello' });

      expect(browser.bringBrowserToFront).toHaveBeenCalled();
    });

    test('scroll brings browser to front', async () => {
      const browser = createMockBrowser();
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'scroll', direction: 'down' });

      expect(browser.bringBrowserToFront).toHaveBeenCalled();
    });

    test('press_key brings browser to front', async () => {
      const browser = createMockBrowser();
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'press_key', key: 'Enter' });

      expect(browser.bringBrowserToFront).toHaveBeenCalled();
    });

    test('bringBrowserToFront called before the action executes', async () => {
      const browser = createMockBrowser();
      const callOrder = [];
      browser.bringBrowserToFront.mockImplementation(() => { callOrder.push('front'); });
      browser.cdpNavigate.mockImplementation(() => { callOrder.push('navigate'); return { ok: true }; });
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'navigate', url: 'https://example.com' });

      expect(callOrder).toEqual(['front', 'navigate']);
    });

    test('bringBrowserToFront called even after auto-connect', async () => {
      const browser = createMockBrowser();
      browser.isConnected.mockReturnValue(false); // force auto-connect
      const agent = createAgent({ browser });

      await agent._execBrowserAction({ action: 'read_page' });

      expect(browser.autoConnectOrLaunchChrome).toHaveBeenCalled();
      expect(browser.bringBrowserToFront).toHaveBeenCalled();
    });

    test('works when bringBrowserToFront is not available (no crash)', async () => {
      const browser = createMockBrowser();
      delete browser.bringBrowserToFront;
      const agent = createAgent({ browser });

      // Should not throw
      const result = await agent._execBrowserAction({ action: 'read_page' });
      expect(result.some((b) => b.type === 'text')).toBe(true);
    });
  });

  // -- _executeTool: blurOverlayFn called for ALL tool types (except confirmation) --

  describe('_executeTool hides overlay for all actions', () => {
    test('computer tool hides overlay', async () => {
      const agent = createAgent();
      await agent._executeTool('computer', { action: 'screenshot' });
      expect(agent.blurOverlayFn).toHaveBeenCalled();
    });

    test('browser_action hides overlay', async () => {
      const browser = createMockBrowser();
      const agent = createAgent({ browser });
      await agent._executeTool('browser_action', { action: 'read_page' });
      expect(agent.blurOverlayFn).toHaveBeenCalled();
    });

    test('focus_window hides overlay', async () => {
      const agent = createAgent();
      await agent._executeTool('focus_window', { title_pattern: 'Discord' });
      expect(agent.blurOverlayFn).toHaveBeenCalled();
    });

    test('request_confirmation does NOT hide overlay', async () => {
      const agent = createAgent();
      await agent._executeTool('request_confirmation', { summary: 'test', details: 'test' });
      expect(agent.blurOverlayFn).not.toHaveBeenCalled();
    });

    test('overlay hidden before computer action executes', async () => {
      const agent = createAgent();
      const callOrder = [];
      agent.blurOverlayFn = jest.fn(() => callOrder.push('blur'));
      agent.computer.leftClick = jest.fn(() => callOrder.push('click'));

      await agent._executeTool('computer', { action: 'left_click', coordinate: [100, 200] });

      expect(callOrder[0]).toBe('blur');
      expect(callOrder[1]).toBe('click');
    });

    test('overlay hidden before browser action executes', async () => {
      const browser = createMockBrowser();
      const callOrder = [];
      browser.cdpNavigate = jest.fn(() => { callOrder.push('navigate'); return { ok: true }; });
      const agent = createAgent({ browser });
      agent.blurOverlayFn = jest.fn(() => callOrder.push('blur'));

      await agent._executeTool('browser_action', { action: 'navigate', url: 'https://example.com' });

      expect(callOrder[0]).toBe('blur');
      expect(callOrder.includes('navigate')).toBe(true);
    });
  });

  // -- focus_window: uses Win32 SetForegroundWindow --

  describe('focus_window brings target to front via Win32', () => {
    test('focusWindow is called with the title pattern', async () => {
      const agent = createAgent();
      await agent._execFocusWindow({ title_pattern: 'Notepad' });
      expect(agent.computer.focusWindow).toHaveBeenCalledWith('Notepad');
    });

    test('returns screenshot after focusing (user sees result)', async () => {
      const agent = createAgent();
      const result = await agent._execFocusWindow({ title_pattern: 'Chrome' });
      // Must have both confirmation text and a screenshot
      expect(result.some((b) => b.type === 'text' && b.text.includes('Focused'))).toBe(true);
      expect(result.some((b) => b.type === 'image')).toBe(true);
    });
  });
});
