// src/grid-overlay.js — Screenshot grid overlay for accurate click targeting
// Divides the screen into labeled cells (A1-L8) so Claude picks cells, not raw pixels.
// Uses Electron's nativeImage for zero-dependency image manipulation.

const { nativeImage } = require('electron');

// Grid dimensions — 12 columns × 8 rows = 96 cells
const GRID_COLS = 12;
const GRID_ROWS = 8;

// Column labels A-L, Row labels 1-8
const COL_LABELS = 'ABCDEFGHIJKL'.split('');
const ROW_LABELS = '12345678'.split('');

/**
 * Build a mapping of grid cell labels → physical pixel coordinates.
 * Screenshot pixels = physical pixels = SetPhysicalCursorPos coordinates (1:1).
 * @param {number} imgWidth  - screenshot width in physical pixels
 * @param {number} imgHeight - screenshot height in physical pixels
 * @returns {Object} { cellMap, cols, rows, cellW, cellH }
 *   cellMap values have x,y,cx,cy,w,h in physical pixel coordinates
 */
function buildGridMap(imgWidth, imgHeight) {
  const cellW = Math.floor(imgWidth / GRID_COLS);
  const cellH = Math.floor(imgHeight / GRID_ROWS);
  const cellMap = {};

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const label = `${COL_LABELS[col]}${ROW_LABELS[row]}`;
      const imgX = col * cellW;
      const imgY = row * cellH;
      cellMap[label] = {
        x: imgX,
        y: imgY,
        cx: Math.round(imgX + cellW / 2),
        cy: Math.round(imgY + cellH / 2),
        w: cellW,
        h: cellH,
      };
    }
  }

  return { cellMap, cols: GRID_COLS, rows: GRID_ROWS, cellW, cellH };
}

/**
 * Overlay a labeled grid onto a screenshot.
 * Draws grid lines and cell labels directly onto the image bitmap.
 * Cell coordinates are in physical pixels (1:1 with SetPhysicalCursorPos).
 *
 * @param {Buffer} screenshotBuffer - JPEG or PNG buffer (physical pixel resolution)
 * @returns {{ annotatedBase64: string, gridMap: Object, mediaType: string }}
 */
function overlayGrid(screenshotBuffer) {
  const img = nativeImage.createFromBuffer(screenshotBuffer);
  const size = img.getSize();
  const { width, height } = size;

  // Get raw RGBA bitmap
  const bitmap = img.toBitmap();
  const bitmapCopy = Buffer.from(bitmap); // work on a copy

  const grid = buildGridMap(width, height);
  const { cellMap, cellW, cellH } = grid;

  // --- Draw grid lines (semi-transparent red, 3px thick) ---
  const lineColor = { r: 255, g: 50, b: 50, a: 200 };
  const LINE_THICKNESS = 3;

  // Vertical lines
  for (let col = 0; col <= GRID_COLS; col++) {
    const x = Math.min(col * cellW, width - 1);
    for (let y = 0; y < height; y++) {
      for (let t = 0; t < LINE_THICKNESS && (x + t) < width; t++) {
        _setPixel(bitmapCopy, width, x + t, y, lineColor);
      }
    }
  }

  // Horizontal lines
  for (let row = 0; row <= GRID_ROWS; row++) {
    const y = Math.min(row * cellH, height - 1);
    for (let x = 0; x < width; x++) {
      for (let t = 0; t < LINE_THICKNESS && (y + t) < height; t++) {
        _setPixel(bitmapCopy, width, x, y + t, lineColor);
      }
    }
  }

  // --- Draw cell labels ---
  // Render simple block-letter labels in top-left corner of each cell
  for (const [label, cell] of Object.entries(cellMap)) {
    _drawLabel(bitmapCopy, width, height, cell.x + 4, cell.y + 4, label);
  }

  // Convert back to nativeImage and then to JPEG base64
  const annotatedImg = nativeImage.createFromBitmap(bitmapCopy, { width, height });
  const jpegBuffer = annotatedImg.toJPEG(70);

  return {
    annotatedBase64: jpegBuffer.toString('base64'),
    gridMap: cellMap,
    mediaType: 'image/jpeg',
  };
}

/**
 * Resolve a grid cell label to click coordinates.
 * Supports sub-cell targeting: "A1" = center, "A1-tl" = top-left quarter, etc.
 *
 * @param {Object} gridMap - from overlayGrid result
 * @param {string} cellLabel - e.g. "A1", "F4", "B2-br"
 * @returns {{ x: number, y: number } | null}
 */
function resolveCell(gridMap, cellLabel) {
  const clean = cellLabel.trim().toUpperCase();

  // Check for sub-cell targeting: "A1-tl", "A1-tr", "A1-bl", "A1-br"
  const parts = clean.split('-');
  const baseLabel = parts[0];
  const quadrant = parts[1] || null;

  const cell = gridMap[baseLabel];
  if (!cell) return null;

  if (!quadrant) {
    return { x: cell.cx, y: cell.cy };
  }

  const qx = quadrant.includes('L') ? cell.x + cell.w * 0.25 : cell.x + cell.w * 0.75;
  const qy = quadrant.includes('T') ? cell.y + cell.h * 0.25 : cell.y + cell.h * 0.75;
  return { x: Math.round(qx), y: Math.round(qy) };
}

// ---------------------------------------------------------------------------
// Pixel helpers — draw directly into RGBA bitmap buffer
// ---------------------------------------------------------------------------

function _setPixel(bitmap, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width) return;
  const offset = (y * width + x) * 4;
  if (offset + 3 >= bitmap.length) return;

  // Alpha blend
  const a = color.a / 255;
  bitmap[offset] = Math.round(bitmap[offset] * (1 - a) + color.r * a);
  bitmap[offset + 1] = Math.round(bitmap[offset + 1] * (1 - a) + color.g * a);
  bitmap[offset + 2] = Math.round(bitmap[offset + 2] * (1 - a) + color.b * a);
  bitmap[offset + 3] = 255;
}

// Simple 5×7 pixel font for labels (A-L, 0-9)
const MINI_FONT = {
  'A': [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  'B': [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  'C': [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  'D': [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  'E': [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  'F': [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  'G': [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  'H': [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  'I': [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  'J': [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  'K': [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  'L': [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
};

function _drawLabel(bitmap, imgW, imgH, startX, startY, label) {
  // Draw at 2x scale so labels are readable in compressed JPEG screenshots
  const SCALE = 2;
  const charW = 5 * SCALE;
  const charH = 7 * SCALE;
  const bgW = label.length * (charW + SCALE) + 6;
  const bgH = charH + 6;
  const bgColor = { r: 0, g: 0, b: 0, a: 220 };
  const textColor = { r: 255, g: 255, b: 50, a: 255 }; // bright yellow

  for (let dy = 0; dy < bgH && (startY + dy) < imgH; dy++) {
    for (let dx = 0; dx < bgW && (startX + dx) < imgW; dx++) {
      _setPixel(bitmap, imgW, startX + dx, startY + dy, bgColor);
    }
  }

  // Render each character at 2x scale
  let charX = startX + 3;
  for (const ch of label) {
    const glyph = MINI_FONT[ch];
    if (!glyph) { charX += charW + SCALE; continue; }
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row] & (1 << (4 - col))) {
          // Draw a SCALE×SCALE block for each pixel
          for (let sy = 0; sy < SCALE; sy++) {
            for (let sx = 0; sx < SCALE; sx++) {
              const px = charX + col * SCALE + sx;
              const py = startY + 3 + row * SCALE + sy;
              if (px < imgW && py < imgH) {
                _setPixel(bitmap, imgW, px, py, textColor);
              }
            }
          }
        }
      }
    }
    charX += charW + SCALE;
  }
}

module.exports = {
  buildGridMap,
  overlayGrid,
  resolveCell,
  GRID_COLS,
  GRID_ROWS,
};
