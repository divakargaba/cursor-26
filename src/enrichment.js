// src/enrichment.js — Proactive Context Enrichment
// Detects task patterns and runs parallel enrichments that Claude can use.
// E.g., flight search → also fetch weather. Email draft → check recipient.
//
// Returns enrichment context to inject into the conversation alongside the task.

class Enrichment {
  constructor({ browser } = {}) {
    this.browser = browser;
  }

  /**
   * Analyze user's request and return enrichment context to inject.
   * Runs fast — should not block the main action.
   * @param {string} text - User's message
   * @param {string} app - Detected app
   * @returns {string} Additional context to inject, or empty string
   */
  async enrich(text, app) {
    const lower = text.toLowerCase();
    const enrichments = [];

    // Run matching enrichments in parallel
    const tasks = [];

    // Travel/flights → weather + calendar hint
    if (this._matchesTravel(lower)) {
      const dest = this._extractDestination(lower);
      if (dest) {
        tasks.push(this._weatherHint(dest));
      }
      const dates = this._extractDates(lower);
      if (dates) {
        tasks.push(this._dateConflictHint(dates));
      }
    }

    // Time-related queries → timezone awareness
    if (this._matchesScheduling(lower)) {
      tasks.push(this._timezoneHint(lower));
    }

    // Shopping/purchase → price comparison hint
    if (this._matchesPurchase(lower)) {
      tasks.push(Promise.resolve('[Enrichment: check for coupon codes or better alternatives before purchasing]'));
    }

    // Email/message to specific person → relationship context
    if (this._matchesMessaging(lower)) {
      const recipient = this._extractRecipient(lower);
      if (recipient) {
        tasks.push(Promise.resolve(`[Enrichment: check if ${recipient} is online/active before messaging]`));
      }
    }

    // File operations → safety hints
    if (this._matchesFileOps(lower)) {
      tasks.push(Promise.resolve('[Enrichment: verify target path exists and check available disk space before file operations]'));
    }

    if (tasks.length === 0) return '';

    try {
      const results = await Promise.allSettled(tasks);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          enrichments.push(r.value);
        }
      }
    } catch (err) {
      console.error('[enrichment] error:', err.message);
    }

    return enrichments.length > 0
      ? `\n\n[Proactive enrichment — use these insights if relevant:]\n${enrichments.join('\n')}`
      : '';
  }

  // ===========================================================================
  // Pattern matchers
  // ===========================================================================

  _matchesTravel(text) {
    return /flight|fly|travel|trip|book.*ticket|airline|airport|hotel|airbnb/i.test(text);
  }

  _matchesScheduling(text) {
    return /schedule|meeting|calendar|appointment|remind|block.*time/i.test(text);
  }

  _matchesPurchase(text) {
    return /buy|purchase|order|checkout|add.*cart|subscribe/i.test(text);
  }

  _matchesMessaging(text) {
    return /message|dm|text|email|send.*to|reply|write.*to/i.test(text);
  }

  _matchesFileOps(text) {
    return /delete|move|rename|copy.*file|download|save.*to|backup/i.test(text);
  }

  // ===========================================================================
  // Extractors
  // ===========================================================================

  _extractDestination(text) {
    // "flight to San Diego" → "San Diego"
    const match = text.match(/(?:to|in|at|visiting)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    if (match) return match[1];
    // Common city names
    const cities = ['san diego', 'new york', 'los angeles', 'san francisco', 'chicago',
      'miami', 'seattle', 'denver', 'toronto', 'vancouver', 'montreal', 'calgary',
      'edmonton', 'london', 'paris', 'tokyo', 'dubai', 'sydney', 'amsterdam'];
    for (const city of cities) {
      if (text.includes(city)) return city;
    }
    return null;
  }

  _extractDates(text) {
    // "in April" → { month: 'april' }
    const months = ['january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'];
    for (const m of months) {
      if (text.includes(m)) return { month: m };
    }
    // "next week", "this weekend", specific dates
    if (/next week|this week|this weekend|tomorrow/i.test(text)) {
      return { relative: text.match(/(next week|this week|this weekend|tomorrow)/i)[1] };
    }
    return null;
  }

  _extractRecipient(text) {
    // "message Mixo" → "Mixo", "email Omar" → "Omar", "dm @user" → "user"
    const match = text.match(/(?:message|dm|text|email|send.*to|reply.*to|write.*to)\s+@?([A-Za-z]\w+)/i);
    return match ? match[1] : null;
  }

  // ===========================================================================
  // Enrichment generators
  // ===========================================================================

  async _weatherHint(destination) {
    // Inject a hint for Claude to check weather — Claude can do this via browser
    return `[Enrichment: destination "${destination}" — check weather forecast. Mention temperature and conditions in your response if relevant.]`;
  }

  _dateConflictHint(dates) {
    const desc = dates.month || dates.relative || 'specified dates';
    return `[Enrichment: travel dates "${desc}" — check for scheduling conflicts. The user may have classes, work, or events during this time.]`;
  }

  _timezoneHint(text) {
    // Simple timezone awareness
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `[Enrichment: user's timezone is ${tz}. If scheduling across timezones, mention the time difference.]`;
  }
}

module.exports = Enrichment;
