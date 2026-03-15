// Tests for Bug 2: MCP Chrome connects to existing browser before launching new one
// Focused on argument construction and fallback logic

beforeEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

function setupMocks(shouldSucceed = true) {
  // Mock fs.accessSync to throw (no local bin → use npx)
  jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    accessSync: jest.fn(() => { throw new Error('ENOENT'); }),
  }));

  // Mock readline to capture and auto-respond to JSON-RPC
  jest.mock('readline', () => ({
    createInterface: jest.fn(() => {
      const rl = { on: jest.fn() };
      return rl;
    }),
  }));

  // Mock child_process.spawn
  const mockSpawn = jest.fn();
  jest.mock('child_process', () => ({ spawn: mockSpawn }));

  // Create mock process factory
  function makeMockProc(succeed) {
    let stdinLineHandler = null;

    const proc = {
      stdin: {
        write: jest.fn((msg) => {
          try {
            const parsed = JSON.parse(msg.trim());
            if (parsed.id !== undefined && stdinLineHandler) {
              if (succeed) {
                process.nextTick(() => stdinLineHandler(JSON.stringify({
                  jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2024-11-05' },
                })));
              } else {
                process.nextTick(() => stdinLineHandler(JSON.stringify({
                  jsonrpc: '2.0', id: parsed.id, error: { message: 'Connection refused' },
                })));
              }
            }
          } catch {}
        }),
      },
      stdout: {},
      stderr: { on: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
    };

    // Wire up readline to capture line callback
    const rl = require('readline');
    rl.createInterface.mockImplementation(() => ({
      on: jest.fn((event, cb) => {
        if (event === 'line') stdinLineHandler = cb;
      }),
    }));

    return proc;
  }

  return { mockSpawn, makeMockProc };
}

describe('Bug 2: MCP Chrome browser connection', () => {
  test('start() passes --browser-url when browserUrl option given', async () => {
    const { mockSpawn, makeMockProc } = setupMocks();
    const proc = makeMockProc(true);
    mockSpawn.mockReturnValue(proc);

    const mcpBrowser = require('../src/mcp-browser');
    await mcpBrowser.start({ browserUrl: 'http://localhost:9222' });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--browser-url=http://localhost:9222');
    expect(args.every(a => !a.includes('--executable-path'))).toBe(true);

    mcpBrowser.stop();
  });

  test('start() passes --executable-path when no browserUrl', async () => {
    const { mockSpawn, makeMockProc } = setupMocks();
    const proc = makeMockProc(true);
    mockSpawn.mockReturnValue(proc);

    const mcpBrowser = require('../src/mcp-browser');
    await mcpBrowser.start({ executablePath: '/usr/bin/chrome' });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--executable-path=/usr/bin/chrome');
    expect(args.every(a => !a.includes('--browser-url'))).toBe(true);

    mcpBrowser.stop();
  });

  test('autoConnectOrLaunchChrome tries port 9222 first', async () => {
    const { mockSpawn, makeMockProc } = setupMocks();
    const proc = makeMockProc(true);
    mockSpawn.mockReturnValue(proc);

    const mcpBrowser = require('../src/mcp-browser');
    const result = await mcpBrowser.autoConnectOrLaunchChrome();

    expect(result.connected).toBe(true);
    expect(result.message).toContain('existing Chrome');

    const firstArgs = mockSpawn.mock.calls[0][1];
    expect(firstArgs).toContain('--browser-url=http://localhost:9222');

    mcpBrowser.stop();
  });

  test('autoConnectOrLaunchChrome falls back when 9222 fails', async () => {
    const { mockSpawn, makeMockProc } = setupMocks();
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      return makeMockProc(callIdx > 1); // first fails, second succeeds
    });

    const mcpBrowser = require('../src/mcp-browser');
    const result = await mcpBrowser.autoConnectOrLaunchChrome();

    expect(result.connected).toBe(true);
    expect(result.message).toContain('new Chrome');
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // First call had --browser-url, second didn't
    const firstArgs = mockSpawn.mock.calls[0][1];
    expect(firstArgs.some(a => a.includes('--browser-url'))).toBe(true);
    const secondArgs = mockSpawn.mock.calls[1][1];
    expect(secondArgs.every(a => !a.includes('--browser-url'))).toBe(true);

    mcpBrowser.stop();
  });

  test('browserUrl takes precedence over executablePath', async () => {
    const { mockSpawn, makeMockProc } = setupMocks();
    const proc = makeMockProc(true);
    mockSpawn.mockReturnValue(proc);

    const mcpBrowser = require('../src/mcp-browser');
    await mcpBrowser.start({
      browserUrl: 'http://localhost:9222',
      executablePath: '/usr/bin/chrome',
    });

    const args = mockSpawn.mock.calls[0][1];
    // browserUrl should be used, not executablePath
    expect(args).toContain('--browser-url=http://localhost:9222');
    expect(args.every(a => !a.includes('--executable-path'))).toBe(true);

    mcpBrowser.stop();
  });
});
