const { createWorker } = require('tesseract.js');

let workerPromise = null;

async function getWorker() {
    if (!workerPromise) {
        workerPromise = (async () => {
            const w = await createWorker('eng');
            // Set parameters for better UI text recognition
            await w.setParameters({
                tessedit_pageseg_mode: '11', // Sparse text (find as much text as possible in no particular order)
            });
            console.log('[ocr] Tesseract worker ready');
            return w;
        })();
    }
    return workerPromise;
}

/**
 * Runs OCR on a screenshot buffer and returns a map of text labels to their physical coordinates.
 * @param {Buffer} imgBuffer - The screenshot image buffer
 * @returns {Promise<Object>} Map of lowercase labels to { centerX, centerY, w, h, confidence, raw }
 */
async function buildOCRMap(imgBuffer) {
    try {
        const worker = await getWorker();
        const result = await worker.recognize(imgBuffer, {}, { blocks: true });

        // Build hashmap: { "send": {centerX, centerY, w, h, raw}, ... }
        const map = {};
        const blocks = result.data.blocks || [];

        // Index by individual words (tesseract.js v7: blocks → paragraphs → lines → words)
        for (const block of blocks) {
            for (const paragraph of block.paragraphs || []) {
                for (const line of paragraph.lines || []) {
                    for (const word of line.words || []) {
                        if (word.confidence < 50) continue;
                        if (word.text.trim().length < 2) continue;

                        const label = word.text.trim().toLowerCase();
                        map[label] = {
                            x: word.bbox.x0,
                            y: word.bbox.y0,
                            w: word.bbox.x1 - word.bbox.x0,
                            h: word.bbox.y1 - word.bbox.y0,
                            centerX: Math.round((word.bbox.x0 + word.bbox.x1) / 2),
                            centerY: Math.round((word.bbox.y0 + word.bbox.y1) / 2),
                            confidence: word.confidence,
                            raw: word.text.trim()
                        };
                    }
                }
            }
        }

        // Also index by whole lines (for multi-word labels like "New Message")
        for (const block of blocks) {
            for (const paragraph of block.paragraphs || []) {
                for (const line of paragraph.lines || []) {
                    const text = line.text.trim().toLowerCase();
                    if (text.length < 3) continue;

                    map[text] = {
                        x: line.bbox.x0,
                        y: line.bbox.y0,
                        w: line.bbox.x1 - line.bbox.x0,
                        h: line.bbox.y1 - line.bbox.y0,
                        centerX: Math.round((line.bbox.x0 + line.bbox.x1) / 2),
                        centerY: Math.round((line.bbox.y0 + line.bbox.y1) / 2),
                        confidence: line.confidence,
                        raw: line.text.trim()
                    };
                }
            }
        }

        return map;
    } catch (err) {
        console.error('[ocr] Error building map:', err.message);
        return {};
    }
}

/**
 * Finds the closest matching element in the OCR map for a given search text.
 */
function findInMap(ocrMap, searchText) {
    if (!ocrMap || !searchText) return null;

    const search = searchText.toLowerCase().trim();

    // 1. Exact match
    if (ocrMap[search]) return ocrMap[search];

    // 2. Contains match (e.g. searching "send" matches "send message")
    for (const [label, data] of Object.entries(ocrMap)) {
        if (label.includes(search) || search.includes(label)) {
            return data;
        }
    }

    // 3. Fuzzy match (useful for OCR typos like "Sern" instead of "Send")
    let best = null;
    let bestScore = 0;

    for (const [label, data] of Object.entries(ocrMap)) {
        const score = stringSimilarity(search, label);
        if (score > bestScore && score > 0.6) {
            bestScore = score;
            best = data;
        }
    }

    return best;
}

// Simple Dice coefficient for string similarity
function stringSimilarity(a, b) {
    if (a === b) return 1.0;
    if (a.length < 2 || b.length < 2) return 0.0;

    const bigrams = (str) => {
        const s = new Set();
        for (let i = 0; i < str.length - 1; i++) {
            s.add(str.slice(i, i + 2));
        }
        return s;
    };

    const aSet = bigrams(a);
    const bSet = bigrams(b);
    let intersectionSize = 0;

    for (const x of aSet) {
        if (bSet.has(x)) intersectionSize++;
    }

    return (2.0 * intersectionSize) / (aSet.size + bSet.size);
}

module.exports = {
    getWorker,
    buildOCRMap,
    findInMap
};
