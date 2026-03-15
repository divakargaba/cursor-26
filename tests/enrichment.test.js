// Tests for src/enrichment.js — Proactive Context Enrichment

const Enrichment = require('../src/enrichment');

function createEnrichment(overrides = {}) {
  return new Enrichment({ browser: null, ...overrides });
}

// =========================================================================
// Pattern matching
// =========================================================================

describe('Enrichment: pattern matching', () => {
  test('detects travel/flight queries', async () => {
    const e = createEnrichment();
    const result = await e.enrich('find me a flight to San Diego in April', 'chrome');
    expect(result).toContain('Proactive enrichment');
    expect(result).toContain('san diego');
    expect(result).toContain('weather');
  });

  test('detects messaging queries', async () => {
    const e = createEnrichment();
    const result = await e.enrich('message Mixo hey bro', 'discord');
    expect(result).toContain('mixo');
    expect(result).toContain('online');
  });

  test('detects purchase queries', async () => {
    const e = createEnrichment();
    const result = await e.enrich('buy that keyboard on amazon', 'chrome');
    expect(result).toContain('coupon');
  });

  test('detects scheduling queries', async () => {
    const e = createEnrichment();
    const result = await e.enrich('schedule a meeting with the team tomorrow', null);
    expect(result).toContain('timezone');
  });

  test('detects file operation queries', async () => {
    const e = createEnrichment();
    const result = await e.enrich('delete all the temp files on my desktop', null);
    expect(result).toContain('disk space');
  });

  test('returns empty for unmatched queries', async () => {
    const e = createEnrichment();
    const result = await e.enrich('hello how are you', null);
    expect(result).toBe('');
  });

  test('returns empty for very short queries', async () => {
    const e = createEnrichment();
    const result = await e.enrich('hi', null);
    expect(result).toBe('');
  });
});

// =========================================================================
// Destination extraction
// =========================================================================

describe('Enrichment: destination extraction', () => {
  test('extracts "to City" pattern', async () => {
    const e = createEnrichment();
    const result = await e.enrich('fly to New York next week', 'chrome');
    expect(result).toContain('weather');
  });

  test('extracts known city names', async () => {
    const e = createEnrichment();
    const result = await e.enrich('book a flight, heading to toronto', 'chrome');
    expect(result).toContain('toronto');
  });

  test('extracts dates from month names', async () => {
    const e = createEnrichment();
    const result = await e.enrich('flight to calgary in december', 'chrome');
    expect(result).toContain('december');
    expect(result).toContain('scheduling conflicts');
  });

  test('extracts relative dates like "next week"', async () => {
    const e = createEnrichment();
    const result = await e.enrich('trip to vancouver next week', 'chrome');
    expect(result).toContain('next week');
  });
});

// =========================================================================
// Recipient extraction
// =========================================================================

describe('Enrichment: recipient extraction', () => {
  test('extracts "message User" pattern', async () => {
    const e = createEnrichment();
    const result = await e.enrich('message Omar about the project', 'discord');
    expect(result).toContain('omar');
  });

  test('extracts "dm @user" pattern', async () => {
    const e = createEnrichment();
    const result = await e.enrich('dm @Alex on discord', 'discord');
    expect(result).toContain('alex');
  });

  test('extracts "email Person" pattern', async () => {
    const e = createEnrichment();
    const result = await e.enrich('email Sarah the proposal', 'gmail');
    expect(result).toContain('sarah');
  });

  test('extracts "send to Person" pattern', async () => {
    const e = createEnrichment();
    const result = await e.enrich('send the doc to Mike', 'teams');
    expect(result).toContain('mike');
  });
});

// =========================================================================
// Multiple enrichments
// =========================================================================

describe('Enrichment: multiple enrichments', () => {
  test('travel query gets both weather and date enrichments', async () => {
    const e = createEnrichment();
    const result = await e.enrich('book a flight to san diego in april', 'chrome');
    expect(result).toContain('weather');
    expect(result).toContain('scheduling conflicts');
    expect(result).toContain('april');
  });

  test('handles errors gracefully', async () => {
    const e = createEnrichment();
    // Force an internal error by mocking
    e._weatherHint = async () => { throw new Error('API down'); };
    const result = await e.enrich('flight to tokyo in march', 'chrome');
    // Should not throw, should still return partial results
    expect(typeof result).toBe('string');
  });
});

// =========================================================================
// Edge cases
// =========================================================================

describe('Enrichment: edge cases', () => {
  test('handles null app gracefully', async () => {
    const e = createEnrichment();
    const result = await e.enrich('message someone', null);
    expect(result).toContain('online');
  });

  test('handles empty text', async () => {
    const e = createEnrichment();
    const result = await e.enrich('', null);
    expect(result).toBe('');
  });

  test('case insensitive matching', async () => {
    const e = createEnrichment();
    const r1 = await e.enrich('FLIGHT TO MIAMI', 'chrome');
    const r2 = await e.enrich('Flight to Miami', 'chrome');
    expect(r1).toContain('weather');
    expect(r2).toContain('weather');
  });
});
