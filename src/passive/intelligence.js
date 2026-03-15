// src/passive/intelligence.js — Decision engine for passive monitoring
// Two-tier: local heuristics (free) then optional Haiku call for phrasing.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL_HAIKU = 'claude-haiku-4-5-20251001';

class PassiveIntelligence {
  constructor({ state, memory }) {
    this.state = state;
    this.memory = memory;
    this.client = null; // Lazy init — only created if Haiku call needed
  }

  /**
   * Check state for actionable items using local heuristics.
   * Returns { shouldNudge, category, rawData, template } or null.
   */
  evaluateLocally() {
    const item = this.state.getMostUrgentItem();
    if (!item) return null;

    // Check cooldown/dismiss before proceeding
    if (!this.state.canNudge(item.category)) return null;

    return {
      shouldNudge: true,
      category: item.category,
      priority: item.priority,
      rawData: item.data,
    };
  }

  /**
   * Generate nudge text. Uses templates for simple cases, Haiku for ambiguous ones.
   * Returns string or null.
   */
  async generateNudgeText(evaluation) {
    if (!evaluation || !evaluation.shouldNudge) return null;

    const { category, rawData } = evaluation;

    // Template-based generation (free, instant)
    const template = this._getTemplate(category, rawData);
    if (template) return template;

    // Ambiguous case — use Haiku for natural phrasing (~$0.0005)
    return await this._generateWithHaiku(category, rawData);
  }

  /**
   * Template-based text generation for common cases.
   */
  _getTemplate(category, data) {
    switch (category) {
      case 'calendar':
        if (data.title && data.minutesUntil !== undefined) {
          return `You have "${data.title}" in ${data.minutesUntil} minute${data.minutesUntil !== 1 ? 's' : ''}.`;
        }
        if (data.title && data.timeText) {
          return `Upcoming: "${data.title}" at ${data.timeText}.`;
        }
        return null;

      case 'unread': {
        const { source, count } = data;
        const sourceName = source.charAt(0).toUpperCase() + source.slice(1);
        return `${count} unread in ${sourceName}.`;
      }

      case 'stale_tab':
        if (data.title && data.daysOpen) {
          const shortTitle = data.title.length > 50 ? data.title.slice(0, 47) + '...' : data.title;
          return `"${shortTitle}" has been open for ${data.daysOpen} days -- still need it?`;
        }
        return null;

      case 'high_switching':
        return `You've switched tabs ${data.count} times in the last 5 minutes. Need help finding something?`;

      case 'social_timeout':
        return `You've been on ${this._extractSiteName(data.title)} for ${data.minutes} minutes.`;

      default:
        return null;
    }
  }

  /**
   * Extract site name from window title for cleaner nudges.
   */
  _extractSiteName(title) {
    if (!title) return 'this site';
    const lower = title.toLowerCase();
    if (lower.includes('youtube')) return 'YouTube';
    if (lower.includes('twitter') || lower.includes('x.com')) return 'Twitter/X';
    if (lower.includes('reddit')) return 'Reddit';
    if (lower.includes('instagram')) return 'Instagram';
    if (lower.includes('tiktok')) return 'TikTok';
    if (lower.includes('twitch')) return 'Twitch';
    return 'this site';
  }

  /**
   * Use Haiku for ambiguous/complex nudge phrasing.
   * Cost: ~$0.0005 per call.
   */
  async _generateWithHaiku(category, data) {
    try {
      if (!this.client) {
        this.client = new Anthropic();
      }

      const userProfile = this.memory?.userProfile
        ? `\nUser context: ${this.memory.userProfile.slice(0, 200)}`
        : '';

      const response = await this.client.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Generate a brief, natural nudge (1 sentence max, no filler) for this situation:
Category: ${category}
Data: ${JSON.stringify(data)}${userProfile}

Rules: Be direct. No "Hey" or "Just wanted to let you know". State the fact. Sound like a sharp assistant, not a chatbot.`,
        }],
      });

      const text = response.content?.[0]?.text?.trim();
      return text || null;
    } catch (err) {
      console.log('[passive/intelligence] Haiku call failed:', err.message);
      return null;
    }
  }
}

module.exports = PassiveIntelligence;
