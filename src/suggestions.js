const Anthropic = require('@anthropic-ai/sdk');
const { execSync } = require('child_process');

const SUGGESTION_MODEL = 'claude-haiku-4-5-20251001';
const SUGGESTION_MAX_TOKENS = 400;
const SUGGESTION_TEMPERATURE = 0.7;
const DEBOUNCE_MS = 3000;
const RATE_LIMIT_MS = 12000;
const CACHE_TTL_MS = 60000;
const POLL_INTERVAL_MS = 4000;

const IS_MAC = process.platform === 'darwin';

const SYSTEM_PROMPT = `You are a proactive AI assistant with full awareness of the user's computer. You can see their active app, all their open browser tabs, and a screenshot of their screen. Based on ALL of this context, suggest exactly 3 actionable things you could help with right now.

Rules:
- You MUST return exactly 3 suggestions. Never return fewer.
- Each suggestion must be a single short sentence (under 12 words), phrased as a question or offer
- Consider ALL context: the active app, open browser tabs, and what's visible on screen
- Pick the 3 most PERTINENT tasks across the entire computer — not just the focused app
- Be specific to what you see. "Summarize the 5 unread Slack messages" not "Help with messages"
- Only suggest things you could actually do (browse, type, click, draft, organize, summarize, search)
- Prioritize by what would save the most effort or reduce the most cognitive load
- If you see unread messages, emails, or notifications across any tab — those are high priority
- Do not suggest anything dangerous, destructive, or irreversible without qualification

Respond with ONLY a JSON array of exactly 3 strings. No markdown, no explanation, no preamble.
Example: ["Reply to Sarah's Slack message?", "Summarize the open GitHub PR?", "Add the song playing to a playlist?"]`;

class SuggestionEngine {
  constructor({ browser, computer, screenshotFn, onSuggestions }) {
    this.browser = browser;
    this.computer = computer;
    this.screenshotFn = screenshotFn || null;
    this.onSuggestions = onSuggestions || (() => {});
    this.client = new Anthropic();
    this.cache = new Map();
    this.enabled = true;
    this.agentBusy = false;
    this.lastApiCall = 0;
    this._debounceTimer = null;
    this._pollInterval = null;
    this._lastContextKey = null;
    this._destroyed = false;
  }

  start() {
    if (this._pollInterval) return;
    console.log('[suggestions] Engine started');
    this._poll();
    this._pollInterval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  enable() { this.enabled = true; }
  disable() { this.enabled = false; }

  clearCache() {
    this.cache.clear();
    this._lastContextKey = null;
  }

  destroy() {
    this._destroyed = true;
    this.enabled = false;
    clearTimeout(this._debounceTimer);
    clearInterval(this._pollInterval);
    this._pollInterval = null;
    this.cache.clear();
  }

  async _poll() {
    if (!this.enabled || this.agentBusy || this._destroyed) return;

    try {
      const context = await this._gatherContext();
      if (context) {
        this.onContextChange(context);
      }
    } catch (err) {
      console.error('[suggestions] Poll error:', err.message);
    }
  }

  /**
   * Detect the foreground application (macOS).
   */
  _getForegroundApp() {
    if (!IS_MAC) return null;
    try {
      const result = execSync(`osascript -e '
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set appName to name of frontProc
  try
    set winTitle to name of front window of frontProc
  on error
    set winTitle to ""
  end try
  return appName & "|||" & winTitle
end tell'`, { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const parts = result.split('|||');
      return { appName: parts[0] || '', windowTitle: parts[1] || '' };
    } catch {
      return null;
    }
  }

  /**
   * Gather HOLISTIC context from the entire computer:
   * 1. Foreground app + window title
   * 2. ALL open Chrome tabs (URLs + titles)
   * 3. Screenshot of the screen
   * All combined into one context blob for the model.
   */
  async _gatherContext() {
    const parts = [];

    // 1. Foreground app
    const fgApp = this._getForegroundApp();
    const appName = fgApp ? fgApp.appName : 'Unknown';
    const windowTitle = fgApp ? fgApp.windowTitle : '';
    console.log(`[suggestions] Context: app="${appName}" win="${windowTitle}"`);
    parts.push(`Active App: ${appName}`);
    if (windowTitle) parts.push(`Window Title: ${windowTitle}`);

    // 2. All Chrome tabs via CDP — sync URL-only (title() hangs on some pages)
    let tabsSummary = '';
    try {
      if (this.browser && typeof this.browser.getTabUrls === 'function') {
        const tabs = this.browser.getTabUrls();
        if (tabs.length > 0) {
          const tabLines = tabs.map(t => {
            try {
              const u = new URL(t.url);
              return `  - ${u.hostname}${u.pathname.length > 1 ? u.pathname.slice(0, 50) : ''}`;
            } catch {
              return `  - ${t.url.slice(0, 60)}`;
            }
          });
          tabsSummary = tabLines.join('\n');
          parts.push(`\nOpen Browser Tabs (${tabs.length}):\n${tabsSummary}`);
        }
      }
    } catch (err) {
      // CDP not available — skip tabs
    }

    // 3. Screenshot (with timeout)
    let screenshotData = null;
    if (this.screenshotFn) {
      try {
        const shot = await Promise.race([
          this.screenshotFn(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 3000)),
        ]);
        if (shot && shot.ok && shot.data) {
          screenshotData = shot;
        }
      } catch {
        // No screenshot
      }
    }

    const contextText = parts.join('\n');
    // Key: use app name + window title + tab summary hash for dedup
    const key = this._makeKey(appName, windowTitle, tabsSummary);

    return {
      key,
      text: contextText,
      screenshot: screenshotData,
    };
  }

  _makeKey(primary, secondary, content) {
    const raw = `${primary || ''}|${secondary || ''}|${(content || '').slice(0, 300)}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return String(hash);
  }

  onContextChange(context) {
    if (!this.enabled || this.agentBusy || this._destroyed) return;

    const key = context.key;

    // Same context as last time — skip
    if (key === this._lastContextKey) return;
    this._lastContextKey = key;

    // Check cache
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      this.onSuggestions(cached.suggestions);
      return;
    }

    // Debounce
    clearTimeout(this._debounceTimer);
    console.log(`[suggestions] Debounce set for key ${key}`);
    this._debounceTimer = setTimeout(() => this._generateSuggestions(context, key), DEBOUNCE_MS);
  }

  async _generateSuggestions(context, key) {
    console.log(`[suggestions] Debounce fired, generating...`);
    if (!this.enabled || this.agentBusy || this._destroyed) return;

    const timeSinceLastCall = Date.now() - this.lastApiCall;
    if (timeSinceLastCall < RATE_LIMIT_MS) return;

    this.lastApiCall = Date.now();
    console.log('[suggestions] Generating for:', context.text.slice(0, 300));

    try {
      // Build messages — always include screenshot if available for richer context
      const userContent = [];
      if (context.screenshot) {
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: context.screenshot.mediaType || 'image/jpeg',
            data: context.screenshot.data,
          },
        });
      }
      userContent.push({ type: 'text', text: context.text });

      const response = await this.client.messages.create({
        model: SUGGESTION_MODEL,
        max_tokens: SUGGESTION_MAX_TOKENS,
        temperature: SUGGESTION_TEMPERATURE,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });

      const rawText = response.content[0].text.trim();
      const stripped = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(stripped);

      if (Array.isArray(parsed)) {
        const suggestions = parsed
          .filter(s => typeof s === 'string' && s.length > 0 && s.length <= 100)
          .slice(0, 3);

        this.cache.set(key, { suggestions, timestamp: Date.now() });
        console.log(`[suggestions] Generated ${suggestions.length} suggestions`);
        this.onSuggestions(suggestions);
      } else {
        this.onSuggestions([]);
      }
    } catch (err) {
      console.error('[suggestions] API error:', err.message);
    }
  }
}

module.exports = SuggestionEngine;
