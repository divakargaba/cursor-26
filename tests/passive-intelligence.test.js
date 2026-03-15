// tests/passive-intelligence.test.js — Unit tests for PassiveIntelligence
const PassiveState = require('../src/passive/state');
const PassiveIntelligence = require('../src/passive/intelligence');

describe('PassiveIntelligence', () => {
  let state, intelligence;

  beforeEach(() => {
    state = new PassiveState();
    intelligence = new PassiveIntelligence({ state, memory: null });
  });

  describe('evaluateLocally', () => {
    test('returns null when nothing urgent', () => {
      expect(intelligence.evaluateLocally()).toBeNull();
    });

    test('returns calendar evaluation when event upcoming', () => {
      state.calendarEvents = [{ title: 'Standup', minutesUntil: 5 }];
      const eval_ = intelligence.evaluateLocally();
      expect(eval_.shouldNudge).toBe(true);
      expect(eval_.category).toBe('calendar');
    });

    test('returns null when category on cooldown', () => {
      state.unreadCounts = { gmail: 3 };
      state.recordNudge('unread', 'test');
      expect(intelligence.evaluateLocally()).toBeNull();
    });

    test('returns unread evaluation', () => {
      state.unreadCounts = { gmail: 5 };
      const eval_ = intelligence.evaluateLocally();
      expect(eval_.shouldNudge).toBe(true);
      expect(eval_.category).toBe('unread');
    });
  });

  describe('generateNudgeText', () => {
    test('generates calendar template', async () => {
      const text = await intelligence.generateNudgeText({
        shouldNudge: true,
        category: 'calendar',
        rawData: { title: 'Team Standup', minutesUntil: 5 },
      });
      expect(text).toContain('Team Standup');
      expect(text).toContain('5 minute');
    });

    test('generates unread template', async () => {
      const text = await intelligence.generateNudgeText({
        shouldNudge: true,
        category: 'unread',
        rawData: { source: 'gmail', count: 3 },
      });
      expect(text).toContain('3 unread');
      expect(text).toContain('Gmail');
    });

    test('generates stale tab template', async () => {
      const text = await intelligence.generateNudgeText({
        shouldNudge: true,
        category: 'stale_tab',
        rawData: { title: 'Old Research Paper', daysOpen: 5 },
      });
      expect(text).toContain('Old Research Paper');
      expect(text).toContain('5 days');
    });

    test('generates high switching template', async () => {
      const text = await intelligence.generateNudgeText({
        shouldNudge: true,
        category: 'high_switching',
        rawData: { count: 25 },
      });
      expect(text).toContain('25 times');
    });

    test('generates social timeout template', async () => {
      const text = await intelligence.generateNudgeText({
        shouldNudge: true,
        category: 'social_timeout',
        rawData: { title: 'YouTube - Cat Videos', minutes: 20 },
      });
      expect(text).toContain('YouTube');
      expect(text).toContain('20 minutes');
    });

    test('returns null for null evaluation', async () => {
      const text = await intelligence.generateNudgeText(null);
      expect(text).toBeNull();
    });

    test('returns null for shouldNudge=false', async () => {
      const text = await intelligence.generateNudgeText({ shouldNudge: false });
      expect(text).toBeNull();
    });
  });
});
