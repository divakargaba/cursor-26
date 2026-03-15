// src/passive/scanner.js — Data collection for passive monitoring
// Wraps browser.js and computer.js. All methods return null on error (never crashes).

class Scanner {
  constructor({ browser, computer }) {
    this.browser = browser;
    this.computer = computer;
  }

  /**
   * List all open Chrome tabs.
   * Returns [{ url, title }] or null on error.
   */
  async scanTabs() {
    try {
      if (!this.browser || !this.browser.isConnected()) return null;
      const tabs = await this.browser.listTabs();
      return tabs || null;
    } catch (err) {
      console.log('[passive/scanner] scanTabs error:', err.message);
      return null;
    }
  }

  /**
   * Extract semantic content from the active browser page.
   * Lighter than _extractElements() — only reads titles, badges, and key indicators.
   * Returns { calendarEvents, unreadCounts, draftIndicators } or null.
   */
  async scanActiveContent() {
    try {
      if (!this.browser || !this.browser.isConnected()) return null;

      const page = await this.browser.getCurrentPage();
      if (!page) return null;

      const data = await page.evaluate(() => {
        const result = {
          calendarEvents: [],
          unreadCounts: {},
          draftIndicators: [],
        };

        // --- Title-based unread detection ---
        const title = document.title || '';

        // Gmail: "Inbox (5) - user@gmail.com - Gmail"
        const gmailMatch = title.match(/Inbox\s*\((\d+)\)/i);
        if (gmailMatch) {
          result.unreadCounts.gmail = parseInt(gmailMatch[1], 10);
        }

        // Outlook: "(5) Mail - user - Outlook"
        const outlookMatch = title.match(/^\((\d+)\)\s*Mail/i);
        if (outlookMatch) {
          result.unreadCounts.outlook = parseInt(outlookMatch[1], 10);
        }

        // Slack: "* Slack | workspace" (asterisk = unread)
        if (/^\*\s/.test(title) || /slack/i.test(title)) {
          // Check for notification badge in DOM
          const badge = document.querySelector('.p-channel_sidebar__badge, [data-qa="mention-badge"]');
          if (badge) {
            const count = parseInt(badge.textContent, 10);
            if (!isNaN(count)) result.unreadCounts.slack = count;
          }
        }

        // --- Calendar event detection (Google Calendar) ---
        // Look for upcoming event cards/chips
        const calSelectors = [
          '[data-eventid]',                    // Google Calendar events
          '.chip-caption',                     // Calendar event chips
          '[aria-label*="event"]',             // General event elements
        ];
        for (const sel of calSelectors) {
          try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
              if (text && text.length < 200) {
                // Try to extract time info
                const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
                if (timeMatch) {
                  result.calendarEvents.push({
                    title: text.slice(0, 100),
                    timeText: timeMatch[1],
                  });
                }
              }
            }
          } catch { /* selector not found — fine */ }
        }

        // --- Draft detection ---
        // Gmail compose window
        const composeWindows = document.querySelectorAll('.AD, [role="dialog"][aria-label*="New Message"], [role="dialog"][aria-label*="Compose"]');
        if (composeWindows.length > 0) {
          result.draftIndicators.push({ app: 'gmail', count: composeWindows.length });
        }

        return result;
      }).catch(() => null);

      return data;
    } catch (err) {
      console.log('[passive/scanner] scanActiveContent error:', err.message);
      return null;
    }
  }

  /**
   * Get the title of the currently focused window.
   * Returns { title } or null.
   */
  scanForeground() {
    try {
      // Use browser.js getForegroundTitle (koffi/AppleScript based)
      if (this.browser && typeof this.browser.getForegroundTitle === 'function') {
        const title = this.browser.getForegroundTitle();
        return title ? { title } : null;
      }
      return null;
    } catch (err) {
      console.log('[passive/scanner] scanForeground error:', err.message);
      return null;
    }
  }
}

module.exports = Scanner;
