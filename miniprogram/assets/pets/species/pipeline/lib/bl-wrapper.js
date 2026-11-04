// Pet Asset Pipeline — bl CLI Wrapper v2
// ==========================================
// SHARED POOL: All image models share 100 free calls.
// No model switching — use best quality model consistently.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const quota = require('./quota-manager');
const config = require('../config');

// ---- Helpers ----

function parseBlOutput(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch (e) { /* fall through */ }
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch (e) { /* fall through */ }
  }
  return null;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait */ }
}

// ---- Core ----

function runBl(command, modelName, opts = {}) {
  const { retries = 0, backoff = [5000, 15000], label = 'bl' } = opts;

  let cmd = command;
  if (!cmd.includes('--output')) cmd += ' --output json';
  if (!cmd.includes('--watermark')) cmd += ' --watermark false';

  // Inject model
  if (!cmd.includes('--model ')) {
    cmd += ` --model ${modelName}`;
  }

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const attemptLabel = attempt > 0 ? ` (retry ${attempt}/${retries})` : '';
    logger.debug(`${label}: ${modelName}${attemptLabel}`);

    try {
      const stdout = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const result = parseBlOutput(stdout);
      if (!result) throw new Error('Empty output from bl');

      // API error?
      if (result.error) {
        const errMsg = result.error.message || JSON.stringify(result.error);
        const apiCode = result.error.api_code;

        if (apiCode === 'Arrearage') {
          // Shared pool exhausted — all models share the same pool
          quota.markExhausted(`Arrearage on ${modelName}`);
          throw new quota.FreeQuotaExhaustedError(
            `Free pool exhausted on ${modelName}. No model switching can help (shared pool).`
          );
        }

        if (apiCode === 'DataInspectionFailed') {
          throw new Error(`Content moderation: ${errMsg}`);
        }

        throw new Error(`API error [${apiCode}]: ${errMsg}`);
      }

      // Validate saved files
      if (result.saved && result.saved.length > 0) {
        const missing = result.saved.filter(p => !fs.existsSync(p));
        if (missing.length > 0) {
          logger.warn(`${label}: ${missing.length} files missing`);
        }
      }

      // Record call in shared pool
      quota.recordCall(modelName);

      logger.debug(`${label}: success, ${result.total || 0} image(s)`);
      return result;

    } catch (err) {
      // FREE_QUOTA_EXHAUSTED — propagate immediately, no retry
      if (err.name === 'FREE_QUOTA_EXHAUSTED') throw err;

      lastError = err;
      const errMsg = err.stderr ? err.stderr.toString().slice(0, 300) : err.message;

      if (attempt < retries) {
        const delay = backoff[attempt] || backoff[backoff.length - 1];
        logger.warn(`${label}: failed (${errMsg}), retrying in ${delay / 1000}s...`);
        sleepSync(delay);
      } else {
        logger.error(`${label}: FAILED — ${errMsg}`);
      }
    }
  }

  throw new Error(`${label}: failed. Last error: ${lastError.message}`);
}

// ---- Public API ----

/**
 * Generate images from text prompt.
 * Uses best quality model from quota manager.
 */
function generate(params = {}) {
  const {
    prompt, n = 1, size = '1:1',
    outDir, outPrefix = 'image', retries = 0,
  } = params;

  if (!prompt) throw new Error('generate: prompt required');

  const model = quota.getModel('generate');

  if (outDir && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let cmd = `bl image generate --prompt "${prompt.replace(/"/g, '\\"')}"`;
  cmd += ` --size ${size} --n ${n}`;
  if (outDir) cmd += ` --out-dir "${outDir}"`;
  cmd += ` --out-prefix ${outPrefix}`;

  return runBl(cmd, model, { retries, label: `generate:${outPrefix}` });
}

/**
 * Edit an image with text instructions.
 * Uses best edit-capable model from quota manager.
 */
function edit(params = {}) {
  const {
    image, prompt, n = 1, size = '1:1',
    outDir, outPrefix = 'edited', negativePrompt, retries = 0,
  } = params;

  if (!image) throw new Error('edit: image path required');
  if (!prompt) throw new Error('edit: prompt required');

  const model = quota.getModel('edit');

  const imagePath = path.isAbsolute(image) ? image : path.resolve(image);
  if (!fs.existsSync(imagePath) && !image.startsWith('http')) {
    throw new Error(`edit: file not found: ${imagePath}`);
  }

  if (outDir && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let cmd = `bl image edit --image "${imagePath.replace(/\\/g, '/')}"`;
  cmd += ` --prompt "${prompt.replace(/"/g, '\\"')}"`;
  cmd += ` --size ${size} --n ${n}`;
  if (outDir) cmd += ` --out-dir "${outDir}"`;
  cmd += ` --out-prefix ${outPrefix}`;
  if (negativePrompt) cmd += ` --negative-prompt "${negativePrompt.replace(/"/g, '\\"')}"`;

  return runBl(cmd, model, { retries, label: `edit:${outPrefix}` });
}

module.exports = { generate, edit };
