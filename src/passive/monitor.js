// src/passive/monitor.js — Orchestrator for passive monitoring (Mode 2)
// 30-second scan loop: collect data → update state → evaluate → deliver nudges.
// Must NEVER crash the app — all errors are caught and logged.

const PassiveState = require('./state');
const Scanner = require('./scanner');
const PassiveIntelligence = require('./intelligence');
const PassiveDelivery = require('./delivery');

const DEFAULT_INTERVAL = 30000; // 30 seconds

class PassiveMonitor {
  /**
   * @param {Object} opts
   * @param {Object} opts.browser       - browser.js module
   * @param {Object} opts.computer      - computer.js instance
   * @param {Object} opts.agent         - Agent instance (for busy check)
   * @param {Object} opts.memory        - Memory instance (for user profile)
   * @param {Function} opts.sendToRenderer - IPC send function
   */
  constructor({ browser, computer, agent, memory, sendToRenderer }) {
    this.state = new PassiveState();
    this.scanner = new Scanner({ browser, computer });
    this.intelligence = new PassiveIntelligence({ state: this.state, memory });
    this.delivery = new PassiveDelivery({ sendToRenderer, state: this.state });

    this.agent = agent;
    this.browser = browser;
    this._interval = null;
    this._paused = false;
    this._running = false;
    this._tickCount = 0;
  }

  /**
   * Start the passive monitoring loop.
   */
  start(intervalMs = DEFAULT_INTERVAL) {
    if (this._interval) return; // already running

    console.log(`[passive/monitor] Starting (interval: ${intervalMs}ms)`);
    this._interval = setInterval(() => this._tick(), intervalMs);

    // Run first tick after a short delay to let app stabilize
    setTimeout(() => this._tick(), 5000);
  }

  /**
   * Stop the monitoring loop.
   */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
      console.log('[passive/monitor] Stopped');
    }
  }

  /**
   * Pause monitoring (e.g., during active Mode 1 commands).
   */
  pause() {
    this._paused = true;
    console.log('[passive/monitor] Paused');
  }

  /**
   * Resume monitoring.
   */
  resume() {
    this._paused = false;
    console.log('[passive/monitor] Resumed');
  }

  /**
   * Check if monitor is actively running (not paused).
   */
  isActive() {
    return this._interval !== null && !this._paused;
  }

  /**
   * Core tick — runs every 30 seconds.
   * All wrapped in try/catch — passive mode must NEVER crash the app.
   */
  async _tick() {
    if (this._paused || this._running) return;

    // Update agent busy state
    const agentBusy = this.agent && typeof this.agent.isBusy === 'function' && this.agent.isBusy();
    this.delivery.setAgentBusy(agentBusy);

    if (agentBusy) {
      return; // Don't scan while agent is actively working
    }

    this._running = true;
    this._tickCount++;

    try {
      // 1. Check browser connection
      if (!this.browser || typeof this.browser.isConnected !== 'function' || !this.browser.isConnected()) {
        this._running = false;
        return;
      }

      // 2. Scan in parallel: tabs + activeContent + foreground
      const [tabs, activeContent, foreground] = await Promise.all([
        this.scanner.scanTabs().catch(() => null),
        this.scanner.scanActiveContent().catch(() => null),
        Promise.resolve(this.scanner.scanForeground()),
      ]);

      // 3. Update state with scan results
      if (tabs) this.state.updateTabs(tabs);
      if (activeContent) this.state.updateActiveContent(activeContent);
      if (foreground) this.state.updateForeground(foreground);

      // 4. Evaluate locally — anything worth mentioning?
      const evaluation = this.intelligence.evaluateLocally();
      if (!evaluation) {
        this._running = false;
        return;
      }

      // 5. Generate nudge text (template or Haiku)
      const nudgeText = await this.intelligence.generateNudgeText(evaluation);
      if (!nudgeText) {
        this._running = false;
        return;
      }

      // 6. Deliver (with all guards)
      this.delivery.deliver(nudgeText, evaluation.category);

    } catch (err) {
      // Passive mode must NEVER crash the app
      console.log('[passive/monitor] Tick error (non-fatal):', err.message);
    }

    this._running = false;
  }
}

module.exports = PassiveMonitor;
