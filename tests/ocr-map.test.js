// Tests for Bug 1: OCR crash fix (tesseract.js v7 API)
// Verifies buildOCRMap handles blocks → paragraphs → lines → words structure

jest.mock('tesseract.js', () => ({
  createWorker: jest.fn(),
}));

const { createWorker } = require('tesseract.js');

// Reset module cache between tests so getWorker() reinitializes
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

function loadOCRMap() {
  // Fresh require each time since module caches the worker promise
  jest.resetModules();
  jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));
  return require('../src/ocr-map');
}

describe('buildOCRMap', () => {
  test('parses tesseract.js v7 block structure correctly', async () => {
    const mockWorker = {
      setParameters: jest.fn(),
      recognize: jest.fn().mockResolvedValue({
        data: {
          blocks: [{
            paragraphs: [{
              lines: [{
                text: 'Send Message',
                bbox: { x0: 100, y0: 200, x1: 250, y1: 220 },
                confidence: 92,
                words: [
                  { text: 'Send', bbox: { x0: 100, y0: 200, x1: 150, y1: 220 }, confidence: 95 },
                  { text: 'Message', bbox: { x0: 160, y0: 200, x1: 250, y1: 220 }, confidence: 90 },
                ],
              }],
            }],
          }],
        },
      }),
    };

    const { createWorker } = require('tesseract.js');
    createWorker.mockResolvedValue(mockWorker);

    const { buildOCRMap } = require('../src/ocr-map');
    const map = await buildOCRMap(Buffer.from('fake-image'));

    // Should have individual words
    expect(map['send']).toBeDefined();
    expect(map['send'].centerX).toBe(125);
    expect(map['send'].centerY).toBe(210);
    expect(map['send'].confidence).toBe(95);
    expect(map['send'].raw).toBe('Send');

    expect(map['message']).toBeDefined();
    expect(map['message'].centerX).toBe(205);

    // Should have the full line
    expect(map['send message']).toBeDefined();
    expect(map['send message'].centerX).toBe(175);
    expect(map['send message'].confidence).toBe(92);
  });

  test('passes { blocks: true } output option to recognize()', async () => {
    const mockWorker = {
      setParameters: jest.fn(),
      recognize: jest.fn().mockResolvedValue({ data: { blocks: [] } }),
    };

    const { createWorker } = require('tesseract.js');
    createWorker.mockResolvedValue(mockWorker);

    const { buildOCRMap } = require('../src/ocr-map');
    await buildOCRMap(Buffer.from('fake'));

    expect(mockWorker.recognize).toHaveBeenCalledWith(
      expect.any(Buffer),
      {},
      { blocks: true }
    );
  });

  test('skips low-confidence words (< 50) from word index', async () => {
    const mockWorker = {
      setParameters: jest.fn(),
      recognize: jest.fn().mockResolvedValue({
        data: {
          blocks: [{
            paragraphs: [{
              lines: [{
                text: 'good bad',
                bbox: { x0: 0, y0: 0, x1: 100, y1: 20 },
                confidence: 80,
                words: [
                  { text: 'good', bbox: { x0: 0, y0: 0, x1: 40, y1: 20 }, confidence: 90 },
                  { text: 'bad', bbox: { x0: 50, y0: 0, x1: 100, y1: 20 }, confidence: 30 },
                ],
              }],
            }],
          }],
        },
      }),
    };

    const { createWorker } = require('tesseract.js');
    createWorker.mockResolvedValue(mockWorker);

    const { buildOCRMap } = require('../src/ocr-map');
    const map = await buildOCRMap(Buffer.from('fake'));

    // "good" passes confidence filter, "bad" does not (as individual word)
    expect(map['good']).toBeDefined();
    expect(map['bad']).toBeUndefined();
    // Line "good bad" still indexed (lines don't filter by confidence)
    expect(map['good bad']).toBeDefined();
  });

  test('skips single-character words', async () => {
    const mockWorker = {
      setParameters: jest.fn(),
      recognize: jest.fn().mockResolvedValue({
        data: {
          blocks: [{
            paragraphs: [{
              lines: [{
                text: 'X',
                bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
                confidence: 99,
                words: [
                  { text: 'X', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, confidence: 99 },
                ],
              }],
            }],
          }],
        },
      }),
    };

    const { createWorker } = require('tesseract.js');
    createWorker.mockResolvedValue(mockWorker);

    const { buildOCRMap } = require('../src/ocr-map');
    const map = await buildOCRMap(Buffer.from('fake'));

    expect(map['x']).toBeUndefined();
  });

  test('handles empty blocks gracefully (no crash)', async () => {
    const mockWorker = {
      setParameters: jest.fn(),
      recognize: jest.fn().mockResolvedValue({ data: { blocks: [] } }),
    };

    const { createWorker } = require('tesseract.js');
    createWorker.mockResolvedValue(mockWorker);

    const { buildOCRMap } = require('../src/ocr-map');
    const map = await buildOCRMap(Buffer.from('fake'));

    expect(map).toEqual({});
  });

  test('handles missing blocks field (undefined) gracefully', async () => {
    const mockWorker = {
      setParameters: jest.fn(),
      recognize: jest.fn().mockResolvedValue({ data: {} }),
    };

    const { createWorker } = require('tesseract.js');
    createWorker.mockResolvedValue(mockWorker);

    const { buildOCRMap } = require('../src/ocr-map');
    const map = await buildOCRMap(Buffer.from('fake'));

    expect(map).toEqual({});
  });

  test('handles multiple blocks and paragraphs', async () => {
    const mockWorker = {
      setParameters: jest.fn(),
      recognize: jest.fn().mockResolvedValue({
        data: {
          blocks: [
            {
              paragraphs: [{
                lines: [{
                  text: 'Header',
                  bbox: { x0: 10, y0: 10, x1: 100, y1: 30 },
                  confidence: 88,
                  words: [
                    { text: 'Header', bbox: { x0: 10, y0: 10, x1: 100, y1: 30 }, confidence: 88 },
                  ],
                }],
              }],
            },
            {
              paragraphs: [{
                lines: [{
                  text: 'Footer',
                  bbox: { x0: 10, y0: 500, x1: 100, y1: 520 },
                  confidence: 85,
                  words: [
                    { text: 'Footer', bbox: { x0: 10, y0: 500, x1: 100, y1: 520 }, confidence: 85 },
                  ],
                }],
              }],
            },
          ],
        },
      }),
    };

    const { createWorker } = require('tesseract.js');
    createWorker.mockResolvedValue(mockWorker);

    const { buildOCRMap } = require('../src/ocr-map');
    const map = await buildOCRMap(Buffer.from('fake'));

    expect(map['header']).toBeDefined();
    expect(map['header'].centerY).toBe(20);
    expect(map['footer']).toBeDefined();
    expect(map['footer'].centerY).toBe(510);
  });

  test('output shape has all required fields', async () => {
    const mockWorker = {
      setParameters: jest.fn(),
      recognize: jest.fn().mockResolvedValue({
        data: {
          blocks: [{
            paragraphs: [{
              lines: [{
                text: 'Test',
                bbox: { x0: 10, y0: 20, x1: 60, y1: 40 },
                confidence: 91,
                words: [
                  { text: 'Test', bbox: { x0: 10, y0: 20, x1: 60, y1: 40 }, confidence: 91 },
                ],
              }],
            }],
          }],
        },
      }),
    };

    const { createWorker } = require('tesseract.js');
    createWorker.mockResolvedValue(mockWorker);

    const { buildOCRMap } = require('../src/ocr-map');
    const map = await buildOCRMap(Buffer.from('fake'));
    const entry = map['test'];

    expect(entry).toEqual({
      x: 10,
      y: 20,
      w: 50,
      h: 20,
      centerX: 35,
      centerY: 30,
      confidence: 91,
      raw: 'Test',
    });
  });
});
