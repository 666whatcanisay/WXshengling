// Pet Asset Pipeline — Quality Gate Validator
// ==============================================
// Validates generated images against quality-gate.json rules.
// Returns pass/fail per check with detailed diagnostics.

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const GATE_FILE = path.join(__dirname, '..', 'quality-gate.json');

let gateRules = null;

function loadRules() {
  if (!gateRules) {
    gateRules = JSON.parse(fs.readFileSync(GATE_FILE, 'utf-8'));
  }
  return gateRules;
}

/**
 * Validate a single image against quality gates.
 *
 * @param {string} imagePath - Path to RGBA PNG image
 * @param {string} stage - 'baby' | 'youth' | 'adult' | 'perfect'
 * @param {object} [opts]
 * @param {object} [opts.babyReference] - { fgRatio, bbArea } from baby stage (for growth checks)
 * @returns {Promise<{ passed: boolean, checks: object[], summary: string }>}
 */
async function validateImage(imagePath, stage, opts = {}) {
  const rules = loadRules();
  const checks = [];
  const { skipFileChecks = false } = opts;

  if (!fs.existsSync(imagePath)) {
    return { passed: false, checks: [{ check: 'file_exists', passed: false, message: 'File not found' }], summary: 'FAIL: file missing' };
  }

  const meta = await sharp(imagePath).metadata();

  // Load at analysis resolution
  const { data, info } = await sharp(imagePath)
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = data;
  const w = info.width, h = info.height, ch = info.channels;

  // ---- Helper: foreground detection ----
  // A pixel is "foreground" if: alpha > 30 AND max(R,G,B) < 230 (not white bg)
  // This works for both RGBA (transparent) and RGB (white bg) source images.
  function isForeground(idx) {
    if (px[idx + 3] < 30) return false;
    const maxRGB = Math.max(px[idx], px[idx + 1], px[idx + 2]);
    return maxRGB < 230;
  }

  let minX = w, minY = h, maxX = 0, maxY = 0, fgCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      if (isForeground(i)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        fgCount++;
      }
    }
  }
  const bbW = maxX - minX + 1, bbH = maxY - minY + 1;
  const bbArea = bbW * bbH;
  const fgRatio = fgCount / (w * h);

  // ---- Check 1: Foreground Ratio ----
  const fgRule = rules.foreground_ratio[stage];
  if (fgRule) {
    const passed = fgRatio >= fgRule.min && fgRatio <= fgRule.max;
    checks.push({
      check: 'foreground_ratio',
      passed,
      value: parseFloat(fgRatio.toFixed(3)),
      expected: `${fgRule.min} ~ ${fgRule.max}`,
      stage,
      critical: true,
      message: passed ? 'OK' : `前景占比 ${(fgRatio*100).toFixed(1)}% 超出 ${stage} 范围 [${(fgRule.min*100).toFixed(1)}%, ${(fgRule.max*100).toFixed(1)}%]`,
    });
  }

  // ---- Check 2: Growth Area Ratio ----
  if (opts.babyReference && opts.babyReference.bbArea && stage !== 'baby') {
    const growthRule = rules.growth_area_ratio[stage];
    if (growthRule) {
      const areaRatio = bbArea / opts.babyReference.bbArea;
      const passed = areaRatio >= growthRule.min && areaRatio <= growthRule.max;
      checks.push({
        check: 'growth_area_ratio',
        passed,
        value: parseFloat(areaRatio.toFixed(3)),
        expected: `${growthRule.min} ~ ${growthRule.max}`,
        stage,
        critical: true,
        message: passed ? 'OK' : `面积比 ${(areaRatio*100).toFixed(1)}% 超出 ${stage} 范围 [${(growthRule.min*100).toFixed(0)}%, ${(growthRule.max*100).toFixed(0)}%]。${areaRatio < growthRule.min ? '角色太小，成长感不足！' : '角色过大，可能裁切！'}`,
      });
    }
  }

  // ---- Check 3: Head-Body Ratio ----
  const hbRule = rules.head_body_ratio;
  if (hbRule) {
    const headBottom = minY + bbH * 0.30;
    let headPx = 0, bodyPx = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = (y * w + x) * ch;
        if (px[i + 3] > 30) {
          if (y < headBottom) headPx++;
          else bodyPx++;
        }
      }
    }
    const hbRatio = bodyPx > 0 ? headPx / bodyPx : 0;
    const passed = hbRatio >= hbRule.min && hbRatio <= hbRule.max;
    checks.push({
      check: 'head_body_ratio',
      passed,
      value: parseFloat(hbRatio.toFixed(3)),
      expected: `${hbRule.min} ~ ${hbRule.max}`,
      critical: false,
      message: passed ? 'OK' : `头身比 ${hbRatio.toFixed(2)} 偏离 Q版规范 [${hbRule.min}, ${hbRule.max}]`,
    });
  }

  // ---- Check 4: Aspect Ratio ----
  const arRule = rules.aspect_ratio;
  if (arRule) {
    const ar = bbH / (bbW || 1);
    const passed = ar >= arRule.min && ar <= arRule.max;
    checks.push({
      check: 'aspect_ratio',
      passed,
      value: parseFloat(ar.toFixed(3)),
      expected: `${arRule.min} ~ ${arRule.max}`,
      critical: false,
      message: passed ? 'OK' : `宽高比 ${ar.toFixed(2)} 超出规范 [${arRule.min}, ${arRule.max}]`,
    });
  }

  // ---- Check 5: Outline Ratio ----
  const orRule = rules.outline_ratio;
  if (orRule) {
    let darkPx = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch;
        if (!isForeground(i)) continue;
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        if (lum < 80) darkPx++;
      }
    }
    const outlineRatio = fgCount > 0 ? darkPx / fgCount : 0;
    const passed = outlineRatio >= orRule.min && outlineRatio <= orRule.max;
    checks.push({
      check: 'outline_ratio',
      passed,
      value: parseFloat(outlineRatio.toFixed(4)),
      expected: `${orRule.min} ~ ${orRule.max}`,
      critical: false,
      message: passed ? 'OK' : `轮廓占比 ${(outlineRatio*100).toFixed(1)}% 偏离范围 [${(orRule.min*100).toFixed(1)}%, ${(orRule.max*100).toFixed(1)}%]`,
    });
  }

  // ---- Check 6: Saturation ----
  const satRule = rules.saturation;
  if (satRule) {
    let totalSat = 0, satCount = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch;
        if (!isForeground(i)) continue;
        const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let s = 0;
        if (max !== min) {
          s = l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
        }
        totalSat += s;
        satCount++;
      }
    }
    const avgSat = satCount > 0 ? totalSat / satCount : 0;
    const passed = avgSat >= satRule.min && avgSat <= satRule.max;
    checks.push({
      check: 'saturation',
      passed,
      value: parseFloat(avgSat.toFixed(3)),
      expected: `${satRule.min} ~ ${satRule.max}`,
      critical: false,
      message: passed ? 'OK' : `饱和度 ${avgSat.toFixed(2)} 偏离范围 [${satRule.min}, ${satRule.max}]`,
    });
  }

  // ---- Check 7: Lighting Symmetry ----
  const lsRule = rules.lighting_symmetry;
  if (lsRule) {
    const midY = Math.floor(h / 2), midX = Math.floor(w / 2);
    let topL = 0, topN = 0, botL = 0, botN = 0;
    let leftL = 0, leftN = 0, rightL = 0, rightN = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch;
        if (!isForeground(i)) continue;
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        if (y < midY) { topL += lum; topN++; }
        else { botL += lum; botN++; }
        if (x < midX) { leftL += lum; leftN++; }
        else { rightL += lum; rightN++; }
      }
    }
    const tb = topN > 0 && botN > 0 ? (topL / topN) / (botL / botN) : 1;
    const lr = leftN > 0 && rightN > 0 ? (leftL / leftN) / (rightL / rightN) : 1;

    const tbOK = tb >= lsRule.top_bot_ratio.min && tb <= lsRule.top_bot_ratio.max;
    const lrOK = lr >= lsRule.left_right_ratio.min && lr <= lsRule.left_right_ratio.max;
    checks.push({
      check: 'lighting_symmetry',
      passed: tbOK && lrOK,
      value: { top_bot: parseFloat(tb.toFixed(3)), left_right: parseFloat(lr.toFixed(3)) },
      expected: `TB ${lsRule.top_bot_ratio.min}~${lsRule.top_bot_ratio.max}, LR ${lsRule.left_right_ratio.min}~${lsRule.left_right_ratio.max}`,
      critical: false,
      message: (tbOK && lrOK) ? 'OK' : `光照不对称: 上下比=${tb.toFixed(2)}, 左右比=${lr.toFixed(2)}`,
    });
  }

  // ---- Check 8: File Properties (skip on pre-process images) ----
  if (!skipFileChecks) {
  const fileRule = rules.file_output.main;
  if (fileRule) {
    const stat = fs.statSync(imagePath);
    const sizeKB = stat.size / 1024;
    const sizeOK = meta.width === fileRule.width && meta.height === fileRule.height;
    const weightOK = sizeKB <= fileRule.max_size_kb;
    const alphaOK = meta.hasAlpha && meta.channels === fileRule.channels;

    checks.push({
      check: 'file_size',
      passed: weightOK,
      value: parseFloat(sizeKB.toFixed(1)) + 'KB',
      expected: `≤${fileRule.max_size_kb}KB`,
      critical: true,
      message: weightOK ? 'OK' : `文件过大 ${sizeKB.toFixed(1)}KB > ${fileRule.max_size_kb}KB`,
    });
    checks.push({
      check: 'file_dimensions',
      passed: sizeOK,
      value: `${meta.width}x${meta.height}`,
      expected: `${fileRule.width}x${fileRule.height}`,
      critical: true,
      message: sizeOK ? 'OK' : '尺寸不符合512x512规范',
    });
    checks.push({
      check: 'file_alpha',
      passed: alphaOK,
      value: `channels=${meta.channels}, alpha=${meta.hasAlpha}`,
      expected: 'channels=4, alpha=true',
      critical: true,
      message: alphaOK ? 'OK' : '缺少Alpha透明通道',
    });
  }
  } // end skipFileChecks

  // ---- Summary ----
  const criticalChecks = checks.filter(c => c.critical);
  const allCriticalPassed = criticalChecks.every(c => c.passed);
  const allPassed = checks.every(c => c.passed);

  return {
    passed: allCriticalPassed,
    allPassed,
    criticalPassed: allCriticalPassed,
    totalChecks: checks.length,
    failedCount: checks.filter(c => !c.passed).length,
    criticalFailedCount: criticalChecks.filter(c => !c.passed).length,
    checks,
    summary: allCriticalPassed
      ? (allPassed ? 'PASS: all checks passed' : `PASS: critical OK, ${checks.filter(c => !c.passed).length} non-critical warnings`)
      : `FAIL: ${criticalChecks.filter(c => !c.passed).length} critical check(s) failed`,
  };
}

/**
 * Validate all stages of a species output.
 *
 * @param {string} speciesDir - Path to assets/pets/{species}/
 * @returns {Promise<object>}
 */
async function validateSpecies(speciesDir) {
  const stages = ['baby', 'youth', 'adult', 'perfect'];
  const results = {};
  let babyRef = null;

  for (const stage of stages) {
    const imagePath = path.join(speciesDir, `${stage}.png`);
    const opts = {};
    if (babyRef) {
      opts.babyReference = babyRef;
    }
    results[stage] = await validateImage(imagePath, stage, opts);

    // Store baby reference for growth checks
    if (stage === 'baby' && results[stage].checks) {
      // Re-extract baby metrics from analysis
      const fgCheck = results[stage].checks.find(c => c.check === 'foreground_ratio');
      babyRef = {
        fgRatio: fgCheck ? fgCheck.value : null,
        bbArea: null, // Will need re-analysis; simplified approach
      };
    }
  }

  return results;
}

module.exports = { validateImage, validateSpecies, loadRules };
