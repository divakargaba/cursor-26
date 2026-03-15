// src/enrichment.js — Proactive Context Enrichment
// Fetches REAL data in parallel: weather (Open-Meteo), calendar conflicts, etc.
// Returns enrichment results to inject into the Claude prompt.

// City → approximate coordinates for Open-Meteo (no API key needed)
const CITY_COORDS = {
  'cairo': { lat: 30.04, lon: 31.24 }, 'new york': { lat: 40.71, lon: -74.01 },
  'los angeles': { lat: 34.05, lon: -118.24 }, 'san francisco': { lat: 37.77, lon: -122.42 },
  'chicago': { lat: 41.88, lon: -87.63 }, 'miami': { lat: 25.76, lon: -80.19 },
  'seattle': { lat: 47.61, lon: -122.33 }, 'denver': { lat: 39.74, lon: -104.99 },
  'toronto': { lat: 43.65, lon: -79.38 }, 'vancouver': { lat: 49.28, lon: -123.12 },
  'montreal': { lat: 45.50, lon: -73.57 }, 'calgary': { lat: 51.05, lon: -114.07 },
  'edmonton': { lat: 53.55, lon: -113.49 }, 'london': { lat: 51.51, lon: -0.13 },
  'paris': { lat: 48.86, lon: 2.35 }, 'tokyo': { lat: 35.68, lon: 139.69 },
  'dubai': { lat: 25.20, lon: 55.27 }, 'sydney': { lat: -33.87, lon: 151.21 },
  'amsterdam': { lat: 52.37, lon: 4.90 }, 'berlin': { lat: 52.52, lon: 13.41 },
  'rome': { lat: 41.90, lon: 12.50 }, 'madrid': { lat: 40.42, lon: -3.70 },
  'istanbul': { lat: 41.01, lon: 28.98 }, 'bangkok': { lat: 13.76, lon: 100.50 },
  'singapore': { lat: 1.35, lon: 103.82 }, 'hong kong': { lat: 22.32, lon: 114.17 },
  'mumbai': { lat: 19.08, lon: 72.88 }, 'delhi': { lat: 28.61, lon: 77.21 },
  'beijing': { lat: 39.90, lon: 116.40 }, 'seoul': { lat: 37.57, lon: 126.98 },
  'mexico city': { lat: 19.43, lon: -99.13 }, 'sao paulo': { lat: -23.55, lon: -46.63 },
  'buenos aires': { lat: -34.60, lon: -58.38 }, 'nairobi': { lat: -1.29, lon: 36.82 },
  'lagos': { lat: 6.52, lon: 3.38 }, 'johannesburg': { lat: -26.20, lon: 28.05 },
  'casablanca': { lat: 33.57, lon: -7.59 }, 'riyadh': { lat: 24.69, lon: 46.72 },
  'doha': { lat: 25.29, lon: 51.53 }, 'san diego': { lat: 32.72, lon: -117.16 },
  'boston': { lat: 42.36, lon: -71.06 }, 'washington': { lat: 38.91, lon: -77.04 },
  'dallas': { lat: 32.78, lon: -96.80 }, 'houston': { lat: 29.76, lon: -95.37 },
  'atlanta': { lat: 33.75, lon: -84.39 }, 'phoenix': { lat: 33.45, lon: -112.07 },
  'las vegas': { lat: 36.17, lon: -115.14 }, 'ottawa': { lat: 45.42, lon: -75.70 },
  'winnipeg': { lat: 49.90, lon: -97.14 }, 'halifax': { lat: 44.65, lon: -63.57 },
};

class Enrichment {
  constructor({ browser, memory } = {}) {
    this.browser = browser;
    this.memory = memory;
  }

  async enrich(text, app) {
    const lower = text.toLowerCase();
    const tasks = [];

    if (this._matchesTravel(lower)) {
      const dest = this._extractDestination(lower);
      const dates = this._extractDates(lower);
      if (dest) tasks.push(this._fetchWeather(dest, dates));
      if (dates) tasks.push(this._checkCalendarConflicts(dates));
      tasks.push(this._checkPeakTravel(dates));
    }

    if (this._matchesScheduling(lower)) {
      const dates = this._extractDates(lower);
      if (dates) tasks.push(this._checkCalendarConflicts(dates));
      tasks.push(this._timezoneInfo());
    }

    if (this._matchesMessaging(lower)) {
      const recipient = this._extractRecipient(lower);
      if (recipient) tasks.push(this._checkRecipientImportance(recipient));
    }

    if (tasks.length === 0) return '';

    const results = await Promise.allSettled(tasks);
    const enrichments = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (enrichments.length === 0) return '';

    console.log(`[enrichment] ${enrichments.length} insights found`);
    return `\n\n[PROACTIVE INSIGHTS — mention the most important one in your response:]\n${enrichments.join('\n')}`;
  }

  // ===========================================================================
  // Pattern matchers
  // ===========================================================================

  _matchesTravel(text) {
    return /flight|fly|travel|trip|book.*ticket|airline|airport|hotel|airbnb|cheap.*to/i.test(text);
  }

  _matchesScheduling(text) {
    return /schedule|meeting|calendar|appointment|remind|block.*time/i.test(text);
  }

  _matchesMessaging(text) {
    return /message|dm|text|email|send.*to|reply|write.*to|follow.*up/i.test(text);
  }

  // ===========================================================================
  // Extractors
  // ===========================================================================

  _extractDestination(text) {
    const match = text.match(/(?:to|in|at|visiting|for)\s+([a-z][a-z\s]+?)(?:\s+in\s+|\s+for\s+|\s+around\s+|[.!?,]|$)/i);
    if (match) {
      const raw = match[1].trim().toLowerCase();
      // Check against known cities
      for (const city of Object.keys(CITY_COORDS)) {
        if (raw.includes(city)) return city;
      }
      // Return raw if it looks like a city name
      if (raw.length > 2 && raw.length < 30) return raw;
    }
    // Direct city name search
    for (const city of Object.keys(CITY_COORDS)) {
      if (text.toLowerCase().includes(city)) return city;
    }
    return null;
  }

  _extractDates(text) {
    const months = ['january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'];
    const lower = text.toLowerCase();
    for (let i = 0; i < months.length; i++) {
      if (lower.includes(months[i])) return { month: months[i], monthNum: i + 1 };
    }
    // Short month names
    const shortMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    for (let i = 0; i < shortMonths.length; i++) {
      if (lower.includes(shortMonths[i])) return { month: months[i], monthNum: i + 1 };
    }
    if (/next week|this week/i.test(lower)) {
      const d = new Date(); d.setDate(d.getDate() + 7);
      return { month: months[d.getMonth()], monthNum: d.getMonth() + 1, relative: 'next week' };
    }
    if (/next month/i.test(lower)) {
      const d = new Date(); d.setMonth(d.getMonth() + 1);
      return { month: months[d.getMonth()], monthNum: d.getMonth() + 1, relative: 'next month' };
    }
    return null;
  }

  _extractRecipient(text) {
    const match = text.match(/(?:message|dm|text|email|send.*to|reply.*to|write.*to|follow.*up.*with)\s+@?([A-Za-z][\w\s]{1,20}?)(?:\s+about|\s+regarding|\s+on|[.!?,]|$)/i);
    return match ? match[1].trim() : null;
  }

  // ===========================================================================
  // REAL enrichment fetchers
  // ===========================================================================

  /**
   * Fetch actual weather from Open-Meteo (free, no API key).
   */
  async _fetchWeather(destination, dates) {
    const coords = CITY_COORDS[destination.toLowerCase()];
    if (!coords) return `[WEATHER] Could not find coordinates for "${destination}" -- mention you couldn't check weather.`;

    try {
      // Determine date range
      let startDate, endDate;
      const now = new Date();
      if (dates && dates.monthNum) {
        const year = dates.monthNum <= now.getMonth() ? now.getFullYear() + 1 : now.getFullYear();
        startDate = `${year}-${String(dates.monthNum).padStart(2, '0')}-01`;
        const lastDay = new Date(year, dates.monthNum, 0).getDate();
        endDate = `${year}-${String(dates.monthNum).padStart(2, '0')}-${lastDay}`;
      } else {
        // Default: next 7 days
        startDate = now.toISOString().slice(0, 10);
        const end = new Date(now); end.setDate(end.getDate() + 7);
        endDate = end.toISOString().slice(0, 10);
      }

      // Open-Meteo forecast (free, up to 16 days) or climate for future months
      const isFuture = new Date(startDate) > new Date(Date.now() + 16 * 86400000);
      let url;
      if (isFuture) {
        // Use climate API for months beyond forecast range
        url = `https://climate-api.open-meteo.com/v1/climate?latitude=${coords.lat}&longitude=${coords.lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean,precipitation_sum&models=EC_Earth3P_HR`;
      } else {
        url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=auto`;
      }

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return null;
      const data = await resp.json();

      if (isFuture && data.daily) {
        const temps = data.daily.temperature_2m_mean || [];
        const precip = data.daily.precipitation_sum || [];
        const avgTemp = temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : null;
        const totalPrecip = precip.reduce((a, b) => a + b, 0);
        const capDest = destination.charAt(0).toUpperCase() + destination.slice(1);
        const tempF = Math.round(avgTemp * 9/5 + 32);
        const conditions = totalPrecip > 50 ? 'rainy season' : totalPrecip > 20 ? 'some rain expected' : 'mostly dry';
        const advisory = avgTemp > 35 ? 'Very hot, pack light.' : avgTemp < 5 ? 'Very cold, pack warm.' : '';
        return `[WEATHER] ${capDest} in ${dates?.month || 'requested dates'} is around ${tempF} degrees Fahrenheit, ${conditions}. ${advisory}`.trim();
      }

      if (data.daily) {
        const maxTemps = data.daily.temperature_2m_max || [];
        const minTemps = data.daily.temperature_2m_min || [];
        const rainProbs = data.daily.precipitation_probability_max || [];
        const avgHigh = maxTemps.length ? Math.round(maxTemps.reduce((a, b) => a + b, 0) / maxTemps.length) : null;
        const avgLow = minTemps.length ? Math.round(minTemps.reduce((a, b) => a + b, 0) / minTemps.length) : null;
        const maxRain = rainProbs.length ? Math.max(...rainProbs) : 0;
        const capDest = destination.charAt(0).toUpperCase() + destination.slice(1);
        const highF = Math.round(avgHigh * 9/5 + 32);
        const lowF = Math.round(avgLow * 9/5 + 32);
        const advisory = avgHigh > 35 ? 'Very hot, pack light.' : avgHigh < 5 ? 'Very cold, pack warm.' : '';
        return `[WEATHER] ${capDest} is around ${highF} to ${lowF} degrees Fahrenheit, ${maxRain} percent chance of rain. ${advisory}`.trim();
      }

      return null;
    } catch (err) {
      console.log('[enrichment] Weather fetch failed:', err.message);
      return null;
    }
  }

  /**
   * Check user's known schedule for conflicts with travel dates.
   */
  async _checkCalendarConflicts(dates) {
    if (!this.memory || !this.memory.userProfile) return null;
    const profile = this.memory.userProfile.toLowerCase();
    const month = dates?.month || '';

    // Extract known events/deadlines from profile
    const conflicts = [];

    // Check for demo days, deadlines, launches
    if (profile.includes('demo') || profile.includes('deadline') || profile.includes('launch') || profile.includes('pilot')) {
      if (profile.includes('fall 2025') || profile.includes('fall 2026')) {
        conflicts.push('URide pilot launch target');
      }
    }

    // Check for classes (CS student, second year)
    if (profile.includes('university') || profile.includes('student')) {
      // School months: Sep-Apr
      const schoolMonths = ['september', 'october', 'november', 'december', 'january', 'february', 'march', 'april'];
      if (schoolMonths.includes(month)) {
        conflicts.push('classes likely in session (university semester)');
      }
    }

    // Check for work schedule
    if (profile.includes('envoy') || profile.includes('ramp agent')) {
      conflicts.push('work at Envoy (check shift schedule)');
    }

    // Check for club events
    if (profile.includes('martial arts') || profile.includes('sparring club')) {
      conflicts.push('UofC Martial Arts Club commitments');
    }

    // Check for karate competitions
    if (profile.includes('karate') && profile.includes('national') || profile.includes('competition')) {
      conflicts.push('potential karate competition dates');
    }

    if (conflicts.length === 0) return null;
    return `[CALENDAR] Potential conflicts for ${month || 'these dates'}: ${conflicts.join('; ')}. Mention the most relevant one.`;
  }

  /**
   * Check if travel dates fall during peak/expensive periods.
   */
  async _checkPeakTravel(dates) {
    if (!dates || !dates.monthNum) return null;
    const m = dates.monthNum;
    const peaks = [];
    if (m === 3 || m === 4) peaks.push('spring break -- prices typically 20-40% higher');
    if (m === 6 || m === 7 || m === 8) peaks.push('summer peak season -- book early');
    if (m === 12) peaks.push('holiday season -- flights and hotels at peak pricing');
    if (m === 11 && dates.month === 'november') peaks.push('Thanksgiving travel week if late November');
    if (peaks.length === 0) return null;
    return `[PRICING] ${peaks.join('. ')}.`;
  }

  /**
   * Check if a message recipient is flagged as important in user profile.
   */
  async _checkRecipientImportance(recipient) {
    if (!this.memory || !this.memory.userProfile) return null;
    const profile = this.memory.userProfile.toLowerCase();
    const recipLower = recipient.toLowerCase();

    // Check if recipient is mentioned in profile
    if (profile.includes(recipLower)) {
      // Determine relationship
      if (profile.includes(recipLower) && (profile.includes('investor') || profile.includes('professor'))) {
        return `[PRIORITY] ${recipient} appears to be a high-priority contact (investor/professor). Use professional tone, respond promptly.`;
      }
      if (profile.includes(recipLower) && (profile.includes('co-founded') || profile.includes('teammate') || profile.includes('partner'))) {
        return `[CONTEXT] ${recipient} is a co-founder/teammate. Casual tone OK.`;
      }
      return `[CONTEXT] ${recipient} is mentioned in user's profile -- they know this person.`;
    }
    return null;
  }

  /**
   * Get timezone info for scheduling.
   */
  async _timezoneInfo() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();
      const offset = -now.getTimezoneOffset() / 60;
      return `[TIMEZONE] User is in ${tz} (UTC${offset >= 0 ? '+' : ''}${offset}). Current time: ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    } catch { return null; }
  }
}

module.exports = Enrichment;
