// src/passive/delivery.js — Speech + rules for passive nudge delivery
// Guards: agent busy? TTS speaking? user typing? Cooldown? Dismiss count?

class PassiveDelivery {
  constructor({ sendToRenderer, state }) {
    this.sendToRenderer = sendToRenderer;
    this.state = state;
    this._agentBusy = false;
    this._ttsSpeaking = false;
    this._userTyping = false;
  }

  /**
   * Deliver a nudge if all guards pass.
   * Returns true if delivered, false if blocked.
   */
  deliver(text, category) {
    if (!text || !category) return false;

    // Guard: don't interrupt active agent
    if (this._agentBusy) {
      console.log('[passive/delivery] Blocked: agent busy');
      return false;
    }

    // Guard: don't talk over TTS
    if (this._ttsSpeaking) {
      console.log('[passive/delivery] Blocked: TTS speaking');
      return false;
    }

    // Guard: don't interrupt typing
    if (this._userTyping) {
      console.log('[passive/delivery] Blocked: user typing');
      return false;
    }

    // Guard: cooldown + dismiss check (already checked in intelligence, but double-check)
    if (!this.state.canNudge(category)) {
      console.log(`[passive/delivery] Blocked: cooldown/dismissed for ${category}`);
      return false;
    }

    // Deliver via TTS (reuse existing agent-progress channel for speech)
    this.sendToRenderer('agent-progress', { type: 'text', text });

    // Also send as passive-nudge for toast UI
    this.sendToRenderer('passive-nudge', { category, text });

    // Record in state
    this.state.recordNudge(category, text);

    console.log(`[passive/delivery] Delivered [${category}]: ${text}`);
    return true;
  }

  /**
   * Handle nudge dismissal from UI.
   */
  onDismissed(category) {
    this.state.recordDismissal(category);
    console.log(`[passive/delivery] Dismissed: ${category} (count: ${this.state.dismissCounts.get(category)})`);
  }

  /**
   * Handle user acting on a nudge (positive reinforcement).
   */
  onActedOn(category) {
    this.state.recordAction(category);
  }

  /**
   * Set agent busy state — called by monitor when agent starts/stops.
   */
  setAgentBusy(busy) {
    this._agentBusy = busy;
  }

  /**
   * Set TTS speaking state — called via IPC from renderer.
   */
  setTTSSpeaking(speaking) {
    this._ttsSpeaking = speaking;
  }

  /**
   * Set user typing state — called via IPC from renderer.
   */
  setUserTyping(typing) {
    this._userTyping = typing;
  }
}

module.exports = PassiveDelivery;
