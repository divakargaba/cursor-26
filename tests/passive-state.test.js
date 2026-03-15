// tests/passive-state.test.js — Unit tests for PassiveState
const PassiveState = require('../src/passive/state');

describe('PassiveState', () => {
  let state;

  beforeEach(() => {
    state = new PassiveState();
  });

  describe('updateTabs', () => {
    test('tracks new tabs with firstSeen/lastSeen', () => {
      state.updateTabs([
        { url: 'https://google.com', title: 'Google' },
        { url: 'https://github.com', title: 'GitHub' },
      ]);
      expect(state.tabHistory.size).toBe(2);
      const google = state.tabHistory.get('https://google.com');
      expect(google.title).toBe('Google');
      expect(google.firstSeen).toBeDefined();
      expect(google.lastSeen).toBeDefined();
    });

    test('updates lastSeen on subsequent scans', () => {
      state.updateTabs([{ url: 'https://google.com', title: 'Google' }]);
      const first = state.tabHistory.get('https://google.com').lastSeen;

      // Simulate time passing
      state.tabHistory.get('https://google.com').lastSeen -= 1000;
      state.updateTabs([{ url: 'https://google.com', title: 'Google' }]);
      const second = state.tabHistory.get('https://google.com').lastSeen;
      expect(second).toBeGreaterThanOrEqual(first);
    });

    test('ignores error tabs', () => {
      state.updateTabs([{ url: '(error)', title: '(error)' }]);
      expect(state.tabHistory.size).toBe(0);
    });

    test('handles null/empty input', () => {
      state.updateTabs(null);
      state.updateTabs([]);
      expect(state.tabHistory.size).toBe(0);
    });
  });

  describe('getStaleTabs', () => {
    test('returns tabs older than threshold', () => {
      state.tabHistory.set('https://old.com', {
        firstSeen: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
        lastSeen: Date.now(),
        title: 'Old Tab',
      });
      state.tabHistory.set('https://new.com', {
        firstSeen: Date.now() - 1 * 60 * 60 * 1000, // 1 hour ago
        lastSeen: Date.now(),
        title: 'New Tab',
      });

      const stale = state.getStaleTabs(3);
      expect(stale.length).toBe(1);
      expect(stale[0].title).toBe('Old Tab');
      expect(stale[0].daysOpen).toBe(5);
    });

    test('returns empty array when no stale tabs', () => {
      state.updateTabs([{ url: 'https://fresh.com', title: 'Fresh' }]);
      expect(state.getStaleTabs(3)).toEqual([]);
    });
  });

  describe('nudge control', () => {
    test('canNudge returns true for new category', () => {
      expect(state.canNudge('stale_tab')).toBe(true);
    });

    test('canNudge returns false during cooldown', () => {
      state.recordNudge('stale_tab', 'test');
      expect(state.canNudge('stale_tab')).toBe(false);
    });

    test('calendar bypasses cooldown', () => {
      state.recordNudge('calendar', 'test');
      expect(state.canNudge('calendar')).toBe(true);
    });

    test('3 dismissals suppresses category', () => {
      state.recordDismissal('unread');
      state.recordDismissal('unread');
      expect(state.canNudge('unread')).toBe(true);
      state.recordDismissal('unread');
      expect(state.canNudge('unread')).toBe(false);
    });

    test('recordAction resets dismiss count', () => {
      state.recordDismissal('unread');
      state.recordDismissal('unread');
      state.recordDismissal('unread');
      expect(state.canNudge('unread')).toBe(false);
      state.recordAction('unread');
      expect(state.canNudge('unread')).toBe(true);
    });
  });

  describe('urgency ranking', () => {
    test('calendar is highest priority', () => {
      state.calendarEvents = [{ title: 'Standup', time: null, minutesUntil: 5 }];
      const item = state.getMostUrgentItem();
      expect(item.category).toBe('calendar');
      expect(item.priority).toBe(0);
    });

    test('unread email is P1', () => {
      state.unreadCounts = { gmail: 3 };
      const item = state.getMostUrgentItem();
      expect(item.category).toBe('unread');
      expect(item.priority).toBe(1);
    });

    test('stale tab is P2', () => {
      state.tabHistory.set('https://old.com', {
        firstSeen: Date.now() - 5 * 24 * 60 * 60 * 1000,
        lastSeen: Date.now(),
        title: 'Old Tab',
      });
      const item = state.getMostUrgentItem();
      expect(item.category).toBe('stale_tab');
      expect(item.priority).toBe(2);
    });

    test('returns null when nothing urgent', () => {
      expect(state.getMostUrgentItem()).toBeNull();
    });

    test('calendar trumps unread email', () => {
      state.calendarEvents = [{ title: 'Meeting', minutesUntil: 3 }];
      state.unreadCounts = { gmail: 10 };
      const item = state.getMostUrgentItem();
      expect(item.category).toBe('calendar');
    });
  });

  describe('foreground tracking', () => {
    test('tracks tab switch count', () => {
      state.updateForeground({ title: 'App A' });
      state.updateForeground({ title: 'App B' });
      state.updateForeground({ title: 'App C' });
      expect(state.tabSwitchLog.length).toBe(2);
    });

    test('social media timeout detection', () => {
      state.lastForeground = {
        title: 'YouTube - Some Video',
        since: Date.now() - 20 * 60 * 1000, // 20 minutes ago
      };
      expect(state.isSocialMediaTimeout()).toBe(true);
    });

    test('no timeout for non-social apps', () => {
      state.lastForeground = {
        title: 'Visual Studio Code',
        since: Date.now() - 60 * 60 * 1000,
      };
      expect(state.isSocialMediaTimeout()).toBe(false);
    });
  });
});
