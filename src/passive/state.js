// src/passive/state.js — Session state for passive monitoring
// Pure data structures. Tracks tabs, nudges, cooldowns, urgency.

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per category
const MAX_DISMISSALS = 3;           // 3 dismissals = category suppressed
const STALE_TAB_DAYS = 3;
const UPCOMING_EVENT_MINUTES = 10;
const HIGH_SWITCH_THRESHOLD = 20;   // tab switches in 5 minutes
const SOCIAL_TIMEOUT_MINUTES = 15;

// Urgency levels
const PRIORITY = {
  CALENDAR: 0,    // P0: calendar event within 10 min
  EMAIL: 1,       // P1: important unread, unsent draft
  STALE_TAB: 2,   // P2: stale tab, high switching
  ACTIVITY: 3,    // P3: YouTube/social media timeout
};

class PassiveState {
  constructor() {
    this.tabHistory = new Map();          // url → { firstSeen, lastSeen, title }
    this.nudgeHistory = [];               // [{ category, text, timestamp }]
    this.nudgeCooldowns = new Map();      // category → timestamp (last nudge)
    this.dismissCounts = new Map();       // category → count
    this.calendarEvents = [];             // [{ title, time, minutesUntil }]
    this.unreadCounts = {};               // { gmail: N, slack: N, ... }
    this.lastForeground = null;           // { title, since }
    this.draftIndicators = [];            // [{ app, age }]
    this.tabSwitchLog = [];              // [timestamp] — for high-switch detection
    this._lastScanHash = '';             // for change detection
  }

  // ---------------------------------------------------------------------------
  // Tab tracking
  // ---------------------------------------------------------------------------

  updateTabs(tabs) {
    if (!Array.isArray(tabs)) return;

    const now = Date.now();
    const currentUrls = new Set();

    for (const tab of tabs) {
      if (!tab.url || tab.url === '(error)') continue;
      currentUrls.add(tab.url);

      const existing = this.tabHistory.get(tab.url);
      if (existing) {
        existing.lastSeen = now;
        existing.title = tab.title || existing.title;
      } else {
        this.tabHistory.set(tab.url, {
          firstSeen: now,
          lastSeen: now,
          title: tab.title || '',
        });
      }
    }

    // Mark tabs no longer open (don't delete — keep history for stale detection)
    // Only prune tabs not seen in 7 days to avoid unbounded growth
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    for (const [url, info] of this.tabHistory) {
      if (!currentUrls.has(url) && info.lastSeen < weekAgo) {
        this.tabHistory.delete(url);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Active content (from DOM scanning)
  // ---------------------------------------------------------------------------

  updateActiveContent(data) {
    if (!data) return;

    const newHash = JSON.stringify(data);
    const changed = newHash !== this._lastScanHash;
    this._lastScanHash = newHash;

    if (data.calendarEvents) {
      this.calendarEvents = data.calendarEvents;
    }
    if (data.unreadCounts) {
      this.unreadCounts = data.unreadCounts;
    }
    if (data.draftIndicators) {
      this.draftIndicators = data.draftIndicators;
    }

    return changed;
  }

  // ---------------------------------------------------------------------------
  // Foreground window tracking
  // ---------------------------------------------------------------------------

  updateForeground(info) {
    if (!info || !info.title) return;

    const now = Date.now();

    // Track tab switching frequency
    if (this.lastForeground && this.lastForeground.title !== info.title) {
      this.tabSwitchLog.push(now);
      // Keep only last 5 minutes
      const fiveMinAgo = now - 5 * 60 * 1000;
      this.tabSwitchLog = this.tabSwitchLog.filter(t => t > fiveMinAgo);
    }

    if (!this.lastForeground || this.lastForeground.title !== info.title) {
      this.lastForeground = { title: info.title, since: now };
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getStaleTabs(days = STALE_TAB_DAYS) {
    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
    const stale = [];
    for (const [url, info] of this.tabHistory) {
      if (info.firstSeen < threshold) {
        stale.push({ url, title: info.title, daysOpen: Math.floor((Date.now() - info.firstSeen) / (24 * 60 * 60 * 1000)) });
      }
    }
    return stale.sort((a, b) => b.daysOpen - a.daysOpen);
  }

  getUpcomingEvents(minutes = UPCOMING_EVENT_MINUTES) {
    return this.calendarEvents.filter(e => e.minutesUntil <= minutes && e.minutesUntil > 0);
  }

  getHighSwitchRate() {
    return this.tabSwitchLog.length >= HIGH_SWITCH_THRESHOLD;
  }

  getForegroundDuration() {
    if (!this.lastForeground) return 0;
    return (Date.now() - this.lastForeground.since) / (60 * 1000); // minutes
  }

  isSocialMediaTimeout() {
    if (!this.lastForeground) return false;
    const title = this.lastForeground.title.toLowerCase();
    const isSocial = /youtube|twitter|x\.com|reddit|instagram|tiktok|twitch/i.test(title);
    return isSocial && this.getForegroundDuration() >= SOCIAL_TIMEOUT_MINUTES;
  }

  // ---------------------------------------------------------------------------
  // Nudge control
  // ---------------------------------------------------------------------------

  canNudge(category) {
    // P0 (calendar) bypasses cooldowns
    if (category === 'calendar') return true;

    // Check dismissal suppression
    const dismissals = this.dismissCounts.get(category) || 0;
    if (dismissals >= MAX_DISMISSALS) return false;

    // Check cooldown
    const lastNudge = this.nudgeCooldowns.get(category);
    if (lastNudge && (Date.now() - lastNudge) < COOLDOWN_MS) return false;

    return true;
  }

  recordNudge(category, text) {
    const now = Date.now();
    this.nudgeHistory.push({ category, text, timestamp: now });
    this.nudgeCooldowns.set(category, now);

    // Keep nudge history bounded
    if (this.nudgeHistory.length > 100) {
      this.nudgeHistory = this.nudgeHistory.slice(-50);
    }
  }

  recordDismissal(category) {
    const count = (this.dismissCounts.get(category) || 0) + 1;
    this.dismissCounts.set(category, count);
  }

  recordAction(category) {
    // User acted on a nudge — reset dismiss count (positive reinforcement)
    this.dismissCounts.set(category, 0);
  }

  // ---------------------------------------------------------------------------
  // Priority ranking
  // ---------------------------------------------------------------------------

  getMostUrgentItem() {
    // P0: Calendar event within 10 min
    const upcoming = this.getUpcomingEvents();
    if (upcoming.length > 0) {
      return { priority: PRIORITY.CALENDAR, category: 'calendar', data: upcoming[0] };
    }

    // P1: Important unread email or unsent draft
    const totalUnread = Object.values(this.unreadCounts).reduce((sum, n) => sum + n, 0);
    if (totalUnread > 0) {
      const topSource = Object.entries(this.unreadCounts)
        .sort(([, a], [, b]) => b - a)[0];
      if (topSource) {
        return { priority: PRIORITY.EMAIL, category: 'unread', data: { source: topSource[0], count: topSource[1] } };
      }
    }

    // P2: Stale tabs
    const stale = this.getStaleTabs();
    if (stale.length > 0) {
      return { priority: PRIORITY.STALE_TAB, category: 'stale_tab', data: stale[0] };
    }

    // P2: High tab switching
    if (this.getHighSwitchRate()) {
      return { priority: PRIORITY.STALE_TAB, category: 'high_switching', data: { count: this.tabSwitchLog.length } };
    }

    // P3: Social media timeout
    if (this.isSocialMediaTimeout()) {
      return { priority: PRIORITY.ACTIVITY, category: 'social_timeout', data: { title: this.lastForeground.title, minutes: Math.round(this.getForegroundDuration()) } };
    }

    return null;
  }
}

module.exports = PassiveState;
module.exports.PRIORITY = PRIORITY;
