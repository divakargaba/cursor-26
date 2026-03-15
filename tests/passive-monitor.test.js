// tests/passive-monitor.test.js — Integration test for PassiveMonitor
const PassiveMonitor = require('../src/passive/monitor');

describe('PassiveMonitor', () => {
  let monitor, sentMessages, mockBrowser, mockAgent;

  beforeEach(() => {
    sentMessages = [];
    mockBrowser = {
      isConnected: () => true,
      listTabs: async () => [
        { url: 'https://google.com', title: 'Google' },
        { url: 'https://github.com', title: 'GitHub' },
      ],
      getCurrentPage: async () => ({
        evaluate: async () => ({
          calendarEvents: [],
          unreadCounts: {},
          draftIndicators: [],
        }),
      }),
      getForegroundTitle: () => 'Google Chrome',
    };
    mockAgent = {
      isBusy: () => false,
      memory: { userProfile: 'Test user' },
    };

    monitor = new PassiveMonitor({
      browser: mockBrowser,
      computer: null,
      agent: mockAgent,
      memory: mockAgent.memory,
      sendToRenderer: (channel, data) => sentMessages.push({ channel, data }),
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  test('start/stop lifecycle', () => {
    monitor.start(60000);
    expect(monitor.isActive()).toBe(true);
    monitor.stop();
    expect(monitor.isActive()).toBe(false);
  });

  test('pause/resume', () => {
    monitor.start(60000);
    expect(monitor.isActive()).toBe(true);
    monitor.pause();
    expect(monitor.isActive()).toBe(false);
    monitor.resume();
    expect(monitor.isActive()).toBe(true);
  });

  test('tick skips when paused', async () => {
    monitor.pause();
    await monitor._tick();
    expect(monitor._tickCount).toBe(0);
  });

  test('tick skips when agent busy', async () => {
    mockAgent.isBusy = () => true;
    await monitor._tick();
    // Tick increments but exits early after agent busy check
    expect(sentMessages.length).toBe(0);
  });

  test('tick skips when browser disconnected', async () => {
    mockBrowser.isConnected = () => false;
    await monitor._tick();
    expect(monitor._tickCount).toBe(1);
    expect(sentMessages.length).toBe(0);
  });

  test('tick scans and updates state', async () => {
    await monitor._tick();
    expect(monitor._tickCount).toBe(1);
    expect(monitor.state.tabHistory.size).toBe(2);
  });

  test('tick delivers nudge when urgent item found', async () => {
    // Pre-seed state with a stale tab
    monitor.state.tabHistory.set('https://old.com', {
      firstSeen: Date.now() - 5 * 24 * 60 * 60 * 1000,
      lastSeen: Date.now(),
      title: 'Old Research',
    });

    await monitor._tick();
    // Should have delivered a nudge
    const nudge = sentMessages.find(m => m.channel === 'passive-nudge');
    expect(nudge).toBeDefined();
    expect(nudge.data.category).toBe('stale_tab');
  });

  test('tick handles errors gracefully', async () => {
    mockBrowser.listTabs = async () => { throw new Error('CDP disconnected'); };
    // Should not throw
    await expect(monitor._tick()).resolves.not.toThrow();
  });

  test('does not start twice', () => {
    monitor.start(60000);
    const interval1 = monitor._interval;
    monitor.start(60000);
    expect(monitor._interval).toBe(interval1);
  });
});
