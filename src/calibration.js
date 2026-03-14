// src/calibration.js — Physical coordinate verification
// Verifies that SetPhysicalCursorPos works correctly by moving cursor to screen corners.
// With physical coordinates, no scale math is needed — screenshot pixels = cursor pixels.

const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

const CALIBRATION_FILE = path.join(__dirname, '..', 'data', 'screen-calibration.json');

function loadCalibration() {
  try {
    if (!fs.existsSync(CALIBRATION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
    if (!data || data.version !== 6) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCalibration(data) {
  const dir = path.dirname(CALIBRATION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(data, null, 2));
  console.log('[calibration] Saved to', CALIBRATION_FILE);
}

/**
 * Run physical coordinate verification.
 * Moves cursor to 4 corners using SetPhysicalCursorPos,
 * reads back with GetPhysicalCursorPos to verify accuracy.
 * Takes a screenshot to get physical pixel dimensions.
 */
async function runCalibration({ screenshotFn }) {
  console.time('[calibration] total');

  const user32 = koffi.load('user32.dll');
  const SetPhysicalCursorPos = user32.func('bool __stdcall SetPhysicalCursorPos(int x, int y)');
  const GetPhysicalCursorPos = user32.func('bool __stdcall GetPhysicalCursorPos(void *lpPoint)');

  // Take a screenshot to determine physical pixel dimensions
  const ss = await screenshotFn();
  if (!ss || !ss.ok) throw new Error('Cannot take screenshot for calibration');

  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(Buffer.from(ss.data, 'base64'));
  const ssWidth = img.getSize().width;
  const ssHeight = img.getSize().height;

  console.log(`[calibration] Screenshot dimensions: ${ssWidth}x${ssHeight} physical pixels`);

  const readPos = () => {
    const buf = Buffer.alloc(8);
    GetPhysicalCursorPos(buf);
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
  };

  const sleep = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
  };

  // Verify physical cursor positioning at 4 corners
  const corners = [
    { label: 'TL', x: 0, y: 0 },
    { label: 'TR', x: ssWidth - 1, y: 0 },
    { label: 'BR', x: ssWidth - 1, y: ssHeight - 1 },
    { label: 'BL', x: 0, y: ssHeight - 1 },
  ];

  const results = [];
  for (const corner of corners) {
    SetPhysicalCursorPos(corner.x, corner.y);
    sleep(50);
    const actual = readPos();
    const error = Math.sqrt((actual.x - corner.x) ** 2 + (actual.y - corner.y) ** 2);
    results.push({ ...corner, actual, error });
    console.log(`[calibration] ${corner.label}: target(${corner.x},${corner.y}) actual(${actual.x},${actual.y}) error=${error.toFixed(1)}px`);
  }

  // Restore cursor to center
  SetPhysicalCursorPos(Math.round(ssWidth / 2), Math.round(ssHeight / 2));

  const maxError = Math.max(...results.map(r => r.error));
  const meanError = results.reduce((a, r) => a + r.error, 0) / results.length;

  if (maxError > 5) {
    console.warn(`[calibration] WARNING: Max corner error ${maxError.toFixed(1)}px — physical cursor may not match screenshot pixels`);
  }

  const calibration = {
    version: 6,
    calibrated_at: new Date().toISOString(),
    screenshot_width: ssWidth,
    screenshot_height: ssHeight,
    coordinate_system: 'physical',
    corners: results,
    accuracy: {
      mean_error_px: Math.round(meanError * 10) / 10,
      max_error_px: Math.round(maxError * 10) / 10,
    },
  };

  saveCalibration(calibration);
  console.timeEnd('[calibration] total');
  return calibration;
}

function validateCalibration(calibration, display) {
  if (!calibration) return null;
  if (calibration.version !== 6) return null;
  const { size, scaleFactor } = display;
  const expectedWidth = Math.round(size.width * scaleFactor);
  const expectedHeight = Math.round(size.height * scaleFactor);
  if (calibration.screenshot_width !== expectedWidth || calibration.screenshot_height !== expectedHeight) {
    console.log(`[calibration] Display changed: expected ${expectedWidth}x${expectedHeight}, stored ${calibration.screenshot_width}x${calibration.screenshot_height}`);
    return null;
  }
  return calibration;
}

module.exports = { loadCalibration, saveCalibration, runCalibration, validateCalibration };
