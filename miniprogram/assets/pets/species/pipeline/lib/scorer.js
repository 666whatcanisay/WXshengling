// Pet Asset Pipeline — Candidate Scorer
// ========================================
// 4-dimension image quality scoring for candidate selection.

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// Configuration
const WHITE_THRESHOLD = 230;
const TARGET_FG_RATIO = 0.45;
const SCORE_WEIGHTS = {
  characterConsistency: 0.35,
  colorRichness: 0.20,
  composition: 0.25,
  foregroundRatio: 0.20,
};

/**
 * Main scoring function for a single candidate image.
 *
 * @param {string} candidatePath - Path to candidate image
 * @param {string|null} referencePath - Path to baby reference (null for baby stage)
 * @param {string} stage - Stage name ('baby', 'youth', 'adult', 'perfect')
 * @returns {Promise<{ totalScore: number, dimensions: object, warnings: string[] }>}
 */
async function scoreCandidate(candidatePath, referencePath = null, stage = 'baby') {
  if (!fs.existsSync(candidatePath)) {
    throw new Error(`Candidate not found: ${candidatePath}`);
  }

  const warnings = [];
  const dimensions = {};

  // Load candidate at analysis resolution (256x256 for speed)
  const candidate = sharp(candidatePath).resize(256, 256, { fit: 'fill' }).ensureAlpha();
  const candData = await candidate.raw().toBuffer({ resolveWithObject: true });

  let refData = null;
  if (referencePath && stage !== 'baby') {
    const reference = sharp(referencePath).resize(256, 256, { fit: 'fill' }).ensureAlpha();
    refData = await reference.raw().toBuffer({ resolveWithObject: true });
  }

  // ---- Dimension 1: Character Consistency (35%) ----
  if (refData && stage !== 'baby') {
    dimensions.characterConsistency = computeConsistency(candData, refData);
  } else {
    dimensions.characterConsistency = 0.5; // neutral
  }

  // ---- Dimension 2: Color Richness (20%) ----
  dimensions.colorRichness = computeColorRichness(candData);
  if (dimensions.colorRichness < 0.3) {
    warnings.push('Low color saturation — image may appear gray/washed-out');
  }

  // ---- Dimension 3: Composition (25%) ----
  dimensions.composition = computeComposition(candData);

  // ---- Dimension 4: Foreground Ratio (20%) ----
  dimensions.foregroundRatio = computeForegroundScore(candData);
  if (dimensions.foregroundRatio < 0.3) {
    warnings.push('Subject may be too small in frame');
  }

  // ---- Aggregate ----
  let totalScore = 0;
  let totalWeight = 0;

  const weights = { ...SCORE_WEIGHTS };

  if (stage === 'baby' || !refData) {
    // Without consistency dimension, re-normalize
    weights.characterConsistency = 0;
  }

  for (const [dim, weight] of Object.entries(weights)) {
    if (weight > 0 && dimensions[dim] !== undefined) {
      totalScore += dimensions[dim] * weight;
      totalWeight += weight;
    }
  }

  // Normalize
  const normalizedScore = totalWeight > 0 ? (totalScore / totalWeight) * 100 : 50;

  return {
    totalScore: Math.round(normalizedScore),
    dimensions: {
      characterConsistency: round(dimensions.characterConsistency),
      colorRichness: round(dimensions.colorRichness),
      composition: round(dimensions.composition),
      foregroundRatio: round(dimensions.foregroundRatio),
    },
    warnings,
  };
}

/**
 * Dimension 1: Character Consistency
 * Compare inner-region RGB histograms using Bhattacharyya coefficient.
 */
function computeConsistency(candData, refData) {
  const candHist = buildHistogram(candData, { x: 0.15, y: 0.15, w: 0.70, h: 0.70 });
  const refHist = buildHistogram(refData, { x: 0.15, y: 0.15, w: 0.70, h: 0.70 });
  return bhattacharyyaCoefficient(candHist, refHist);
}

/**
 * Build a 64-bin RGB histogram (4 bins per channel = 4×4×4 = 64).
 * Only samples foreground pixels (non-white).
 */
function buildHistogram(imgData, region) {
  const { data, info } = imgData;
  const { width, height } = info;
  const ch = info.channels;

  const bins = new Array(64).fill(0);
  let totalPixels = 0;

  const startX = Math.floor(region.x * width);
  const startY = Math.floor(region.y * height);
  const endX = Math.floor((region.x + region.w) * width);
  const endY = Math.floor((region.y + region.h) * height);

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * width + x) * ch;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];

      // Skip white background pixels
      if (Math.max(r, g, b) >= WHITE_THRESHOLD) continue;

      // Quantize: 4 bins per channel (0-63, 64-127, 128-191, 192-255)
      const rBin = Math.min(3, r >> 6);
      const gBin = Math.min(3, g >> 6);
      const bBin = Math.min(3, b >> 6);
      const binIndex = (rBin << 4) | (gBin << 2) | bBin;

      bins[binIndex]++;
      totalPixels++;
    }
  }

  // Normalize
  if (totalPixels > 0) {
    for (let i = 0; i < 64; i++) {
      bins[i] /= totalPixels;
    }
  }

  return bins;
}

/**
 * Bhattacharyya coefficient: sum(sqrt(p_i * q_i))
 * Range [0, 1], where 1 = identical histograms.
 */
function bhattacharyyaCoefficient(histA, histB) {
  let sum = 0;
  for (let i = 0; i < histA.length; i++) {
    sum += Math.sqrt(histA[i] * histB[i]);
  }
  // Clamp to [0, 1], though mathematically it should be in range
  return Math.min(1, Math.max(0, sum));
}

/**
 * Dimension 2: Color Richness
 * HSL saturation in center region — penalizes gray/washed-out images.
 */
function computeColorRichness(imgData) {
  const { data, info } = imgData;
  const { width, height } = info;
  const ch = info.channels;

  // Sample center 60% region
  const cx = Math.floor(width * 0.2);
  const cy = Math.floor(height * 0.2);
  const cw = Math.floor(width * 0.6);
  const ch_ = Math.floor(height * 0.6);

  const saturations = [];
  let count = 0;

  for (let y = cy; y < cy + ch_; y += 3) {
    for (let x = cx; x < cx + cw; x += 3) {
      const idx = (y * width + x) * ch;
      const r = data[idx] / 255, g = data[idx + 1] / 255, b = data[idx + 2] / 255;

      // Skip background pixels
      if (Math.max(data[idx], data[idx + 1], data[idx + 2]) >= WHITE_THRESHOLD) continue;

      const { s } = rgbToHsl(r, g, b);
      saturations.push(s);
      count++;
    }
  }

  if (count < 50) return 0.3; // not enough foreground pixels

  const meanSat = saturations.reduce((a, b) => a + b, 0) / count;
  const variance = saturations.reduce((sum, s) => sum + (s - meanSat) ** 2, 0) / count;

  // Score: higher mean sat + some variance = better
  const satScore = clamp(meanSat / 0.35, 0, 1);
  const varScore = clamp(Math.sqrt(variance) / 0.15, 0, 1);

  return satScore * 0.5 + varScore * 0.5;
}

/**
 * Convert RGB to HSL.
 */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let h = 0, s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h, s, l };
}

/**
 * Dimension 3: Composition
 * 3×3 grid analysis — subject should be centered, not touch edges.
 */
function computeComposition(imgData) {
  const { data, info } = imgData;
  const { width, height } = info;
  const ch = info.channels;

  const cellW = Math.floor(width / 3);
  const cellH = Math.floor(height / 3);

  const cellRatios = [];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const cx = col * cellW;
      const cy = row * cellH;

      let fg = 0, total = 0;
      for (let y = cy; y < cy + cellH; y += 2) {
        for (let x = cx; x < cx + cellW; x += 2) {
          const idx = (y * width + x) * ch;
          if (Math.max(data[idx], data[idx + 1], data[idx + 2]) < WHITE_THRESHOLD) fg++;
          total++;
        }
      }

      cellRatios.push(total > 0 ? fg / total : 0);
    }
  }

  // cellRatios indexed: [0左上, 1中上, 2右上, 3左中, 4中心, 5右中, 6左下, 7中下, 8右下]
  const centerRatio = cellRatios[4];
  const edgeIndices = [0, 1, 2, 3, 5, 6, 7, 8];
  const edgeAvg = edgeIndices.reduce((sum, i) => sum + cellRatios[i], 0) / edgeIndices.length;

  // Center should be dense, edges should be sparse
  return centerRatio * 0.6 + (1 - edgeAvg) * 0.4;
}

/**
 * Dimension 4: Foreground Ratio
 * Overall subject coverage — target is ~45% of canvas.
 */
function computeForegroundScore(imgData) {
  const { data, info } = imgData;
  const { width, height } = info;
  const ch = info.channels;

  let fg = 0, total = 0;
  for (let i = 0; i < data.length; i += ch * 4) { // sample every 4th pixel
    if (Math.max(data[i], data[i + 1], data[i + 2]) < WHITE_THRESHOLD) fg++;
    total++;
  }

  const ratio = total > 0 ? fg / total : 0;
  const score = 1.0 - Math.abs(ratio - TARGET_FG_RATIO) / 0.45;
  return clamp(score, 0, 1);
}

/**
 * Score all candidates for a stage and return sorted results.
 *
 * @param {string[]} candidatePaths
 * @param {string|null} referencePath
 * @param {string} stage
 * @returns {Promise<Array<{ path: string, totalScore: number, dimensions: object, warnings: string[] }>>}
 */
async function scoreCandidates(candidatePaths, referencePath = null, stage = 'baby') {
  const results = [];

  for (const cp of candidatePaths) {
    if (!fs.existsSync(cp)) {
      results.push({
        path: cp,
        totalScore: 0,
        error: 'File not found',
        dimensions: {},
        warnings: ['File not found'],
      });
      continue;
    }

    try {
      const result = await scoreCandidate(cp, referencePath, stage);
      results.push({ path: cp, ...result });
    } catch (err) {
      results.push({
        path: cp,
        totalScore: 0,
        error: err.message,
        dimensions: {},
        warnings: [err.message],
      });
    }
  }

  // Sort descending by totalScore
  results.sort((a, b) => b.totalScore - a.totalScore);

  return results;
}

// ---- Helpers ----

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function round(val, decimals = 3) {
  return Math.round(val * (10 ** decimals)) / (10 ** decimals);
}

module.exports = { scoreCandidate, scoreCandidates };
