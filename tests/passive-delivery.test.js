// tests/passive-delivery.test.js — Unit tests for PassiveDelivery
const PassiveState = require('../src/passive/state');
const PassiveDelivery = require('../src/passive/delivery');

describe('PassiveDelivery', () => {
  let state, delivery, sentMessages;

  beforeEach(() => {
    state = new PassiveState();
    sentMessages = [];
    delivery = new PassiveDelivery({
      sendToRenderer: (channel, data) => sentMessages.push({ channel, data }),
      state,
    });
  });

  describe('deliver', () => {
    test('delivers nudge when all guards pass', () => {
      const result = delivery.deliver('Test nudge', 'stale_tab');
      expect(result).toBe(true);
      expect(sentMessages.length).toBe(2); // agent-progress + passive-nudge
      expect(sentMessages[0].channel).toBe('agent-progress');
      expect(sentMessages[0].data.text).toBe('Test nudge');
      expect(sentMessages[1].channel).toBe('passive-nudge');
      expect(sentMessages[1].data.category).toBe('stale_tab');
    });

    test('blocks when agent is busy', () => {
      delivery.setAgentBusy(true);
      expect(delivery.deliver('Test', 'stale_tab')).toBe(false);
      expect(sentMessages.length).toBe(0);
    });

    test('blocks when TTS is speaking', () => {
      delivery.setTTSSpeaking(true);
      expect(delivery.deliver('Test', 'stale_tab')).toBe(false);
      expect(sentMessages.length).toBe(0);
    });

    test('blocks when user is typing', () => {
      delivery.setUserTyping(true);
      expect(delivery.deliver('Test', 'stale_tab')).toBe(false);
      expect(sentMessages.length).toBe(0);
    });

    test('blocks with null text or category', () => {
      expect(delivery.deliver(null, 'stale_tab')).toBe(false);
      expect(delivery.deliver('Test', null)).toBe(false);
    });

    test('records nudge in state after delivery', () => {
      delivery.deliver('Test nudge', 'stale_tab');
      expect(state.nudgeHistory.length).toBe(1);
      expect(state.nudgeHistory[0].category).toBe('stale_tab');
    });

    test('blocks on cooldown (double-check)', () => {
      delivery.deliver('First', 'stale_tab');
      expect(delivery.deliver('Second', 'stale_tab')).toBe(false);
    });
  });

  describe('onDismissed', () => {
    test('increments dismiss count', () => {
      delivery.onDismissed('unread');
      expect(state.dismissCounts.get('unread')).toBe(1);
      delivery.onDismissed('unread');
      expect(state.dismissCounts.get('unread')).toBe(2);
    });
  });

  describe('onActedOn', () => {
    test('resets dismiss count', () => {
      delivery.onDismissed('unread');
      delivery.onDismissed('unread');
      delivery.onActedOn('unread');
      expect(state.dismissCounts.get('unread')).toBe(0);
    });
  });
});
