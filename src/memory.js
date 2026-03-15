// src/memory.js — Adaptive memory: playbooks, failures, preferences, context
// Gets smarter with every interaction. Stores what works, what doesn't, and what the user cares about.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  playbooks: path.join(DATA_DIR, 'playbooks.json'),
  failures: path.join(DATA_DIR, 'failures.json'),
  preferences: path.join(DATA_DIR, 'preferences.json'),
  context: path.join(DATA_DIR, 'context.json'),
};

const MAX_PLAYBOOK_ENTRIES = 300;
const MAX_FAILURE_ENTRIES = 200;
const MAX_CONTEXT_ENTRIES = 100;

class Memory {
  constructor() {
    this.playbooks = [];   // Successful action paths per app
    this.failures = [];    // What broke + how it was fixed
    this.preferences = {}; // Learned user behavior patterns
    this.context = [];     // User facts, goals, info mentioned in convo
    this._ensureDir();
    this._loadAll();
  }

  _ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _loadJSON(filepath) {
    try {
      if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch { /* fresh start */ }
    return null;
  }

  _saveJSON(filepath, data) {
    try {
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[memory] save error:', err.message);
    }
  }

  _loadAll() {
    this.playbooks = this._loadJSON(FILES.playbooks) || [];
    this.failures = this._loadJSON(FILES.failures) || [];
    this.preferences = this._loadJSON(FILES.preferences) || {};
    this.context = this._loadJSON(FILES.context) || [];
  }

  // ===========================================================================
  // PLAYBOOKS — successful action sequences
  // ===========================================================================

  /**
   * Record a successful task → action path.
   * @param {string} task - User's natural language request
   * @param {string} app - App involved (discord, chrome, notepad, etc)
   * @param {Array} actions - [{tool, input}, ...] that completed the task
   * @param {number} elapsed - Total time in ms
   */
  recordSuccess(task, app, actions, elapsed = 0) {
    const keywords = this._extractKeywords(task);
    const existing = this._findPlaybook(keywords, app);

    if (existing) {
      // Update existing playbook with latest working path
      existing.actions = actions;
      existing.uses++;
      existing.lastUsed = Date.now();
      existing.avgTime = Math.round((existing.avgTime + elapsed) / 2);
    } else {
      this.playbooks.push({
        keywords,
        app: (app || '').toLowerCase(),
        actions: actions.slice(0, 15),
        timestamp: Date.now(),
        lastUsed: Date.now(),
        uses: 1,
        avgTime: elapsed,
      });
    }

    // Trim old entries
    if (this.playbooks.length > MAX_PLAYBOOK_ENTRIES) {
      this.playbooks.sort((a, b) => b.uses - a.uses);
      this.playbooks = this.playbooks.slice(0, MAX_PLAYBOOK_ENTRIES);
    }
    this._saveJSON(FILES.playbooks, this.playbooks);
  }

  /**
   * Find the best matching playbook for a task.
   */
  getPlaybook(task, app) {
    const keywords = this._extractKeywords(task);
    if (keywords.length === 0) return null;

    const match = this._findPlaybook(keywords, app);
    if (match) {
      match.uses++;
      match.lastUsed = Date.now();
      this._saveJSON(FILES.playbooks, this.playbooks);
    }
    return match;
  }

  _findPlaybook(keywords, app) {
    let best = null;
    let bestScore = 0;

    for (const pb of this.playbooks) {
      // App must match if specified
      if (app && pb.app && pb.app !== app.toLowerCase()) continue;

      const overlap = keywords.filter((k) => pb.keywords.includes(k)).length;
      const score = overlap / Math.max(keywords.length, pb.keywords.length);
      if (score > bestScore && score >= 0.4) {
        bestScore = score;
        best = pb;
      }
    }
    return best;
  }

  // ===========================================================================
  // FAILURES — what went wrong and how it was fixed
  // ===========================================================================

  /**
   * Record a failed action + what fixed it.
   * @param {string} app - App where it happened
   * @param {string} action - What was attempted (e.g. "left_click on taskbar")
   * @param {string} outcome - What went wrong (e.g. "wrong window focused")
   * @param {string} fix - What fixed it (e.g. "use focus_window instead")
   */
  recordFailure(app, action, outcome, fix = '') {
    this.failures.push({
      app: (app || '').toLowerCase(),
      action,
      outcome,
      fix,
      timestamp: Date.now(),
      occurrences: 1,
    });

    // Deduplicate: if same app+action failed before, increment occurrences
    const key = `${(app || '').toLowerCase()}:${action}`;
    const dupes = this.failures.filter(f => `${f.app}:${f.action}` === key);
    if (dupes.length > 1) {
      // Keep the one with a fix, or the latest
      const withFix = dupes.find(f => f.fix) || dupes[dupes.length - 1];
      withFix.occurrences = dupes.reduce((sum, d) => sum + d.occurrences, 0);
      this.failures = this.failures.filter(f => `${f.app}:${f.action}` !== key);
      this.failures.push(withFix);
    }

    if (this.failures.length > MAX_FAILURE_ENTRIES) {
      this.failures = this.failures.slice(-MAX_FAILURE_ENTRIES);
    }
    this._saveJSON(FILES.failures, this.failures);
  }

  /**
   * Get failure warnings for an app.
   */
  getFailuresForApp(app) {
    return this.failures
      .filter((f) => f.app === (app || '').toLowerCase())
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 5);
  }

  /**
   * Get recent failures for an app (within the last hour).
   * Used for injecting known-issue context into agent prompts.
   */
  getRecentFailures(app, limit = 3) {
    const now = Date.now();
    const oneHour = 3600000;
    return this.failures
      .filter(f => f.app === (app || '').toLowerCase() && (now - f.timestamp) < oneHour)
      .slice(-limit);
  }

  // ===========================================================================
  // PREFERENCES — learned user behavior patterns
  // ===========================================================================

  setPreference(key, value) {
    this.preferences[key] = { value, updatedAt: Date.now() };
    this._saveJSON(FILES.preferences, this.preferences);
  }

  getPreference(key) {
    return this.preferences[key]?.value || null;
  }

  // ===========================================================================
  // CONTEXT — facts, goals, info from conversations
  // ===========================================================================

  /**
   * Store a fact learned from conversation.
   * @param {string} content - The fact/goal/info
   * @param {string} source - Where it came from (e.g. "user said", "observed")
   */
  addContext(content, source = 'conversation') {
    // Avoid duplicates
    const existing = this.context.find(c =>
      c.content.toLowerCase() === content.toLowerCase()
    );
    if (existing) {
      existing.lastMentioned = Date.now();
      existing.mentions++;
    } else {
      this.context.push({
        content,
        source,
        timestamp: Date.now(),
        lastMentioned: Date.now(),
        mentions: 1,
      });
    }

    if (this.context.length > MAX_CONTEXT_ENTRIES) {
      // Keep most mentioned + most recent
      this.context.sort((a, b) => b.mentions - a.mentions || b.lastMentioned - a.lastMentioned);
      this.context = this.context.slice(0, MAX_CONTEXT_ENTRIES);
    }
    this._saveJSON(FILES.context, this.context);
  }

  // ===========================================================================
  // INJECTION — build context string for the AI prompt
  // ===========================================================================

  /**
   * Build a complete memory context string to inject into Claude's prompt.
   * @param {string} app - Current detected app
   * @param {string} task - Current user request
   */
  buildContextForPrompt(app, task) {
    const parts = [];

    // 1. Playbook tips for this app
    const appLower = (app || '').toLowerCase();
    if (appLower) {
      const relevant = this.playbooks
        .filter((p) => p.app === appLower)
        .sort((a, b) => b.uses - a.uses)
        .slice(0, 5);

      if (relevant.length > 0) {
        const tips = relevant.map((p) => {
          const steps = p.actions
            .map((a) => `${a.tool}(${a.input?.action || a.input?.title_pattern || ''})`)
            .join(' → ');
          return `  "${p.keywords.join(' ')}" → ${steps} (${p.uses}x, ~${Math.round(p.avgTime / 1000)}s)`;
        });
        parts.push(`[Learned patterns for ${app}:]\n${tips.join('\n')}`);
      }
    }

    // 2. Failure warnings for this app
    const failures = this.getFailuresForApp(app);
    if (failures.length > 0) {
      const warns = failures.map((f) =>
        `  ⚠ "${f.action}" → ${f.outcome}${f.fix ? `. FIX: ${f.fix}` : ''} (${f.occurrences}x)`
      );
      parts.push(`[Known issues for ${app}:]\n${warns.join('\n')}`);
    }

    // 3. User preferences
    const prefEntries = Object.entries(this.preferences);
    if (prefEntries.length > 0) {
      const prefs = prefEntries.slice(0, 10).map(([k, v]) => `  ${k}: ${v.value}`);
      parts.push(`[User preferences:]\n${prefs.join('\n')}`);
    }

    // 4. Recent context facts (last 10)
    const recentContext = this.context
      .sort((a, b) => b.lastMentioned - a.lastMentioned)
      .slice(0, 10);
    if (recentContext.length > 0) {
      const facts = recentContext.map((c) => `  - ${c.content}`);
      parts.push(`[User context:]\n${facts.join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : '';
  }

  // ===========================================================================
  // Legacy compatibility — getTipsForApp (used in agent.js)
  // ===========================================================================

  getTipsForApp(app) {
    return this.buildContextForPrompt(app, '');
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  _extractKeywords(text) {
    const stopwords = ['the', 'and', 'for', 'can', 'you', 'just', 'that', 'this',
      'with', 'its', 'bro', 'like', 'honestly', 'lowkey', 'really', 'please',
      'want', 'need', 'could', 'would', 'should', 'gonna', 'gotta', 'also',
      'then', 'okay', 'sure', 'right', 'real', 'quick', 'hey', 'jarvis'];

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .filter((w) => !stopwords.includes(w));
  }
}

module.exports = Memory;
