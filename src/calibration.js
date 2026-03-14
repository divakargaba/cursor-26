// src/calibration.js — Display config storage for computer-use coordinate scaling
// Stores physical screen dimensions and scale factors for API↔physical coordinate mapping.

const fs = require('fs');
const path = require('path');

const CALIBRATION_FILE = path.join(__dirname, '..', 'data', 'screen-calibration.json');

function loadCalibration() {
  try {
    if (!fs.existsSync(CALIBRATION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
    if (!data || data.version !== 7) return null;
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
 * Save display config as calibration data.
 * @param {Object} displayConfig - { physicalWidth, physicalHeight, displayWidth, displayHeight, scaleX, scaleY }
 */
function saveDisplayConfig(displayConfig) {
  const data = {
    version: 7,
    calibrated_at: new Date().toISOString(),
    coordinate_system: 'computer-use',
    ...displayConfig,
  };
  saveCalibration(data);
  return data;
}

/**
 * Validate stored calibration against current display.
 * Returns calibration if still valid, null if display changed.
 */
function validateCalibration(calibration, display) {
  if (!calibration) return null;
  if (calibration.version !== 7) return null;
  const { size, scaleFactor } = display;
  const expectedWidth = Math.round(size.width * scaleFactor);
  const expectedHeight = Math.round(size.height * scaleFactor);
  if (calibration.physicalWidth !== expectedWidth || calibration.physicalHeight !== expectedHeight) {
    console.log(`[calibration] Display changed: expected ${expectedWidth}x${expectedHeight}, stored ${calibration.physicalWidth}x${calibration.physicalHeight}`);
    return null;
  }
  return calibration;
}

module.exports = { loadCalibration, saveCalibration, saveDisplayConfig, validateCalibration };
