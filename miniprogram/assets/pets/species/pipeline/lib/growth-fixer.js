// Pet Asset Pipeline — Auto Growth Fixer
// ==========================================
// Post-processing: when growth_area_ratio fails quality gate,
// scale the subject up/down to match the target growth ratio.
// This compensates for the AI model's inability to precisely
// control character size during chain editing.
//
// Algorithm:
//   1. Find subject bounding box (non-transparent pixels)
//   2. Calculate current area and target area
//   3. Compute scale factor: sqrt(target / current)
//   4. Extract subject, scale, re-center on 512×512 canvas
//   5. Clamp to prevent edge clipping (subject ≤90% canvas)
//
// Usage:
//   const { fixGrowth } = require('./lib/growth-fixer');
//   const result = await fixGrowth(imagePath, babyArea, targetRatio, outputPath);

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const MAX_FILL_RATIO = 0.94;  // subject must not exceed 94% of canvas (allows near-full for large growth)
const MIN_FILL_RATIO = 0.15;  // subject must fill at least 15%

/**
 * Find the bounding box of non-transparent pixels.
 * Returns null if no subject found.
 */
async function findSubjectBounds(imagePath) {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const px = data;

  let minX = width, minY = height, maxX = 0, maxY = 0;
  let alphaCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      // Skip transparent AND white background pixels
      if (px[i + 3] < 30) continue;
      const maxRGB = Math.max(px[i], px[i + 1], px[i + 2]);
      if (maxRGB >= 230) continue; // white background
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      alphaCount++;
    }
  }

  if (alphaCount === 0) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    area: (maxX - minX + 1) * (maxY - minY + 1),
    pixelCount: alphaCount,
    canvasWidth: width,
    canvasHeight: height,
  };
}

/**
 * Scale the subject within the image to match the target growth ratio.
 *
 * Growth ratio = current_subject_area / baby_subject_area
 * We scale the subject by: sqrt(targetRatio / currentRatio)
 *
 * @param {string} imagePath   - Path to stage image (512×512 RGBA)
 * @param {number} babyArea    - Baby subject bounding box area (at 512×512)
 * @param {number} targetRatio - Desired growth ratio (e.g. 1.15 for youth)
 * @param {string} outputPath  - Where to save the fixed image
 * @returns {Promise<object>}
 */
async function fixGrowth(imagePath, babyArea, targetRatio, outputPath) {
  // 1. Find subject bounds
  const bounds = await findSubjectBounds(imagePath);
  if (!bounds) {
    return { fixed: false, error: 'No subject found in image', scaleFactor: 0 };
  }

  const currentArea = bounds.area;

  // 2. Calculate target area and scale factor
  const targetArea = babyArea * targetRatio;
  const scaleFactor = Math.sqrt(targetArea / currentArea);

  // 3. Clamp scale factor
  // Use actual canvas size from the source image
  const canvasSize = bounds.canvasWidth; // source image dimension (same for w/h, square)
  const currentFillW = bounds.width / canvasSize;
  const currentFillH = bounds.height / canvasSize;
  const scaledFillW = currentFillW * scaleFactor;
  const scaledFillH = currentFillH * scaleFactor;
  const maxScaledDim = Math.max(scaledFillW, scaledFillH);

  let effectiveScale = scaleFactor;
  let clamped = false;

  if (maxScaledDim > MAX_FILL_RATIO) {
    effectiveScale = MAX_FILL_RATIO / Math.max(currentFillW, currentFillH);
    clamped = true;
  }

  // Don't scale below MIN_FILL_RATIO
  const minScaledDim = Math.min(scaledFillW, scaledFillH);
  if (minScaledDim * effectiveScale < MIN_FILL_RATIO && scaleFactor < 1.0) {
    // If we need to shrink but subject would be too small, keep current
    effectiveScale = Math.max(effectiveScale, MIN_FILL_RATIO / Math.max(currentFillW, currentFillH));
  }

  // If scale factor is very close to 1.0, skip (avoid unnecessary processing)
  if (Math.abs(effectiveScale - 1.0) < 0.01) {
    // Just copy
    fs.copyFileSync(imagePath, outputPath);
    return {
      fixed: true,
      scaleFactor: 1.0,
      currentArea,
      targetArea,
      effectiveScale: 1.0,
      clamped: false,
      message: 'Scale within 1% of target — no fix needed',
    };
  }

  // 4. Extract subject at original resolution
  const extractWidth = bounds.width;
  const extractHeight = bounds.height;

  // Ensure we don't extract outside image bounds
  const extractX = Math.max(0, bounds.x);
  const extractY = Math.max(0, bounds.y);
  const extractW = Math.min(canvasSize - extractX, extractWidth);
  const extractH = Math.min(canvasSize - extractY, extractHeight);

  // 5. Extract and scale the subject
  const subjectBuffer = await sharp(imagePath)
    .extract({ left: extractX, top: extractY, width: extractW, height: extractH })
    .resize(
      Math.round(extractW * effectiveScale),
      Math.round(extractH * effectiveScale),
      { fit: 'fill', kernel: sharp.kernel.lanczos3 }
    )
    .png()
    .toBuffer();

  // 6. Get scaled subject dimensions
  const scaledMeta = await sharp(subjectBuffer).metadata();
  const scaledW = scaledMeta.width;
  const scaledH = scaledMeta.height;

  // 7. Center on 512×512 canvas
  const offsetX = Math.floor((canvasSize - scaledW) / 2);
  const offsetY = Math.floor((canvasSize - scaledH) / 2);

  await sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: subjectBuffer, top: offsetY, left: offsetX }])
    .png({ compressionLevel: 6 })
    .toFile(outputPath);

  return {
    fixed: true,
    scaleFactor: parseFloat(scaleFactor.toFixed(4)),
    effectiveScale: parseFloat(effectiveScale.toFixed(4)),
    currentArea,
    targetArea: parseFloat(targetArea.toFixed(0)),
    clamped,
    newSubjectDims: `${scaledW}×${scaledH}`,
    offset: `${offsetX},${offsetY}`,
    message: clamped
      ? `Scaled by ${(effectiveScale*100).toFixed(1)}% (clamped to fit canvas — ideal was ${(scaleFactor*100).toFixed(1)}%)`
      : `Scaled by ${(effectiveScale*100).toFixed(1)}% — area ${currentArea} → ~${Math.round(currentArea * effectiveScale * effectiveScale)}`,
  };
}

/**
 * Fix a stage image that failed quality gate checks.
 * Handles both growth_area_ratio and foreground_ratio failures.
 *
 * @param {string} imagePath        - Path to selected stage image
 * @param {object} qualityResult    - Quality gate result for this stage
 * @param {number} babyArea         - Baby subject area (for growth checks)
 * @param {string} stage            - 'baby' | 'youth' | 'adult' | 'perfect'
 * @returns {Promise<object>}       - Fix result
 */
async function autoFixStage(imagePath, qualityResult, babyArea, stage) {
  const GATE_FILE = path.join(__dirname, '..', 'quality-gate.json');
  const gate = JSON.parse(fs.readFileSync(GATE_FILE, 'utf-8'));

  // Check what failed and determine the fix target
  const growthCheck = qualityResult.checks.find(c => c.check === 'growth_area_ratio');
  const fgCheck = qualityResult.checks.find(c => c.check === 'foreground_ratio');

  let targetAreaRatio = null;
  let fixReason = '';

  // Priority 1: Fix growth_area_ratio if it failed
  if (growthCheck && !growthCheck.passed) {
    const growthRule = gate.growth_area_ratio[stage];
    if (growthRule && babyArea) {
      targetAreaRatio = growthRule.ideal || ((growthRule.min + growthRule.max) / 2);
      fixReason = `growth_area_ratio ${growthCheck.value.toFixed(2)} → target ${targetAreaRatio.toFixed(2)}`;
    }
  }

  // Priority 2: Fix foreground_ratio if it failed (and not already fixing growth)
  if (!targetAreaRatio && fgCheck && !fgCheck.passed) {
    const fgRule = gate.foreground_ratio[stage];
    if (fgRule) {
      const targetFg = fgRule.ideal || ((fgRule.min + fgRule.max) / 2);
      const currentFg = fgCheck.value;
      // Convert fg ratio target to area scale:
      // targetArea / currentArea = targetFg / currentFg
      targetAreaRatio = targetFg / currentFg;
      fixReason = `foreground_ratio ${(currentFg*100).toFixed(1)}% → target ${(targetFg*100).toFixed(1)}% (scale ${(targetAreaRatio*100).toFixed(1)}%)`;
    }
  }

  if (!targetAreaRatio) {
    return { fixed: false, skipped: true, message: 'No failing visual check to fix' };
  }

  // For growth_area_ratio fix: babyArea is the reference, targetAreaRatio is the growth multiplier
  // For foreground_ratio fix: use current subject area as reference, targetAreaRatio = fg_ideal / fg_current
  let fixBabyArea = babyArea;
  if (!fixBabyArea || fixBabyArea <= 0) {
    // Fall back to current subject area (foreground_ratio fix path)
    const bounds = await findSubjectBounds(imagePath);
    fixBabyArea = bounds ? bounds.area : 1;
  }

  // Apply fix to a temp path first
  const tempPath = imagePath.replace(/\.png$/, '_growthfix_temp.png');

  const result = await fixGrowth(imagePath, fixBabyArea, targetAreaRatio, tempPath);

  if (!result.fixed) {
    return result;
  }

  // Replace original with fixed version
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(imagePath);
    fs.renameSync(tempPath, imagePath);
  }

  return {
    ...result,
    stage,
    fixReason,
    targetAreaRatio: parseFloat(targetAreaRatio.toFixed(3)),
    imagePath,
  };
}

module.exports = { fixGrowth, autoFixStage, findSubjectBounds };
