// src/memory.js — Simple pattern memory using JSON file (no SQLite dependency needed)
// Stores successful action patterns so the agent learns over time.
const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'data', 'memory.json');
const MAX_PATTERNS = 200;

class Memory {
  constructor() {
    this.patterns = [];
    this._load();
  }

  _load() {
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(MEMORY_FILE)) {
        this.patterns = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      }
    } catch {
      this.patterns = [];
    }
  }

  _save() {
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.patterns, null, 2));
    } catch (err) {
      console.error('[memory] save error:', err.message);
    }
  }

  /**
   * Record a successful task pattern.
   * @param {string} task - What the user asked for (natural language)
   * @param {string} app - Which app was involved (e.g. "discord", "notepad", "chrome")
   * @param {Array} actions - The action sequence that worked [{tool, input}, ...]
   */
  recordSuccess(task, app, actions) {
    // Normalize task to keywords for matching
    const keywords = this._extractKeywords(task);

    this.patterns.push({
      keywords,
      app: (app || '').toLowerCase(),
      actions,
      timestamp: Date.now(),
      uses: 1,
    });

    // Keep only most recent patterns
    if (this.patterns.length > MAX_PATTERNS) {
      this.patterns = this.patterns.slice(-MAX_PATTERNS);
    }
    this._save();
  }

  /**
   * Find a matching pattern for the given task.
   * Returns the best matching action sequence or null.
   */
  findPattern(task) {
    const keywords = this._extractKeywords(task);
    if (keywords.length === 0) return null;

    let best = null;
    let bestScore = 0;

    for (const pattern of this.patterns) {
      const overlap = keywords.filter((k) => pattern.keywords.includes(k)).length;
      const score = overlap / Math.max(keywords.length, pattern.keywords.length);
      if (score > bestScore && score >= 0.4) {
        bestScore = score;
        best = pattern;
      }
    }

    if (best) {
      best.uses++;
      this._save();
    }

    return best;
  }

  /**
   * Get learned tips for an app — what has worked before.
   */
  getTipsForApp(app) {
    const appLower = (app || '').toLowerCase();
    const relevant = this.patterns
      .filter((p) => p.app === appLower)
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 5);

    if (relevant.length === 0) return '';

    const tips = relevant.map((p) => {
      const actionSummary = p.actions
        .map((a) => `${a.tool}(${a.input?.action || ''})`)
        .join(' → ');
      return `  "${p.keywords.join(' ')}" → ${actionSummary}`;
    });

    return `[Learned patterns for ${app}:]\n${tips.join('\n')}`;
  }

  _extractKeywords(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .filter((w) => !['the', 'and', 'for', 'can', 'you', 'just', 'that', 'this', 'with', 'its', 'bro', 'like', 'honestly', 'lowkey', 'really'].includes(w));
  }
}

module.exports = Memory;
