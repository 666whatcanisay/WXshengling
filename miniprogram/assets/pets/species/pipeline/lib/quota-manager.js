// Pet Asset Pipeline — Quota Manager v2
// =========================================
// SHARED POOL MODEL: All Bailian image generation models share
// ONE free pool of 100 images. Switching models does NOT give
// you more free quota.
//
// Strategy:
//   - Use BEST quality model consistently (wan2.7-image-pro)
//   - Track total calls against shared 100-image pool
//   - Warn when approaching limit
//   - When pool exhausted → FREE_QUOTA_EXHAUSTED
//
// CRITICAL: ALLOW_PAID_MODEL=false guarantees no paid usage.

const path = require('path');
const fs = require('fs');
const config = require('../config');

// ---- State ----
let state = {
  totalCalls: 0,        // total API calls made across ALL image models
  poolLimit: config.FREE_POOL_LIMIT,
  poolExhausted: false,
  callsByModel: {},     // per-model call count for reporting
  startedAt: null,
};

const STATE_FILE = path.join(config.ROOT, '.claude', 'quota-state.json');

// ---- Error ----
class FreeQuotaExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FREE_QUOTA_EXHAUSTED';
  }
}

// ---- Init ----
function init() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      state.totalCalls = saved.totalCalls || 0;
      state.poolExhausted = saved.poolExhausted || false;
      state.callsByModel = saved.callsByModel || {};
    } catch (e) {
      // reset
    }
  }
  if (!state.startedAt) {
    state.startedAt = new Date().toISOString();
  }
}

function save() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    totalCalls: state.totalCalls,
    poolExhausted: state.poolExhausted,
    callsByModel: state.callsByModel,
    startedAt: state.startedAt,
    poolLimit: state.poolLimit,
  }, null, 2));
}

// ---- Pool checks ----

/**
 * Get remaining free calls in the shared pool.
 */
function remaining() {
  init();
  return Math.max(0, state.poolLimit - state.totalCalls);
}

/**
 * Check if the shared free pool still has quota.
 */
function isAvailable() {
  init();
  if (state.poolExhausted) return false;
  return remaining() > 0;
}

/**
 * Get the best available model for image generation.
 * Does NOT switch models — uses the primary quality model.
 * Only falls back if primary has a non-quota error.
 *
 * @param {'generate'|'edit'} purpose
 * @returns {string} model name
 */
function getModel(purpose = 'generate') {
  init();

  const remainingCalls = remaining();

  if (remainingCalls <= 0) {
    const msg = [
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      ' FREE_QUOTA_EXHAUSTED',
      ` All ${state.poolLimit} free image generations used.`,
      '',
      ` Total calls made: ${state.totalCalls}`,
      ` ALLOW_PAID_MODEL = ${config.ALLOW_PAID_MODEL}`,
      ' Pipeline stopped. No paid models will be used.',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
    console.error(msg);
    throw new FreeQuotaExhaustedError(msg);
  }

  const model = purpose === 'edit' ? config.EDIT_MODEL : config.GENERATE_MODEL;
  console.error(`[Quota] Pool: ${remainingCalls}/${state.poolLimit} free remaining | Model: ${model}`);

  if (remainingCalls <= 10) {
    console.error(`[Quota] ⚠ WARNING: Only ${remainingCalls} free calls left!`);
  }

  return model;
}

/**
 * Record an API call against the shared pool.
 */
function recordCall(modelName) {
  init();
  state.totalCalls++;
  if (!state.callsByModel[modelName]) {
    state.callsByModel[modelName] = 0;
  }
  state.callsByModel[modelName]++;

  const rem = remaining();
  console.error(`[Quota] Call recorded: ${modelName} | Pool: ${rem}/${state.poolLimit} remaining`);

  if (rem <= 0) {
    state.poolExhausted = true;
    console.error(`[Quota] Pool EXHAUSTED after ${state.totalCalls} calls.`);
  }

  save();
}

/**
 * Mark the shared pool as exhausted (e.g., Arrearage from API).
 */
function markExhausted(reason = 'API Arrearage') {
  init();
  state.poolExhausted = true;
  console.error(`[Quota] Pool marked EXHAUSTED: ${reason}`);
  save();
}

/**
 * Reset all state.
 */
function resetAll() {
  state = {
    totalCalls: 0,
    poolLimit: config.FREE_POOL_LIMIT,
    poolExhausted: false,
    callsByModel: {},
    startedAt: new Date().toISOString(),
  };
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  console.error('[Quota] State reset.');
}

/**
 * Get full report.
 */
function getReport() {
  init();
  return {
    poolLimit: state.poolLimit,
    totalCalls: state.totalCalls,
    remaining: remaining(),
    exhausted: state.poolExhausted,
    startedAt: state.startedAt,
    callsByModel: { ...state.callsByModel },
  };
}

/**
 * Print cost estimate for a production run.
 */
function printEstimate(speciesCount, stagesPerSpecies, includeRareShiny) {
  init(); // ensure state is loaded from disk
  const report = getReport();

  const genCalls = speciesCount;           // 1 generate per species (baby)
  const editCalls = speciesCount * 3;      // 3 edits per species (youth/adult/perfect)
  const normalTotal = genCalls + editCalls;

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  COST ESTIMATE — Bailian Free Pool    ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Free pool limit:    ${report.poolLimit} images`);
  console.log(`  Generate model:     ${config.GENERATE_MODEL}`);
  console.log(`  Edit model:         ${config.EDIT_MODEL}`);
  console.log('');
  console.log('  ── Normal Only ──');
  console.log(`  Species:            ${speciesCount}`);
  console.log(`  Baby (generate):    ${genCalls} calls`);
  console.log(`  Grow (edit):        ${editCalls} calls`);
  console.log(`  Total API calls:    ${normalTotal}`);
  console.log(`  Pool after run:     ${report.remaining - normalTotal}/${report.poolLimit}`);
  console.log(`  Within limit:       ${normalTotal <= report.remaining ? '✅ YES' : '❌ NO (short by ' + (normalTotal - report.remaining) + ')'}`);
  console.log('');

  if (includeRareShiny) {
    // rare + shiny = 2 additional variants per stage per species
    // Each variant: 1 edit call (from normal base) × 4 stages = 4 edits per variant
    // Total: 15 species × 2 variants × 4 edits = 120 additional edits
    const rareShinyCalls = speciesCount * 2 * stagesPerSpecies;
    const grandTotal = normalTotal + rareShinyCalls;

    console.log('  ── Normal + Rare + Shiny ──');
    console.log(`  Rare variants:      ${speciesCount * stagesPerSpecies} calls (edit)`);
    console.log(`  Shiny variants:     ${speciesCount * stagesPerSpecies} calls (edit)`);
    console.log(`  Rare/Shiny total:   ${rareShinyCalls} calls`);
    console.log(`  Grand total:        ${grandTotal}`);
    console.log(`  Free remaining:     ${state.poolLimit - grandTotal}/${state.poolLimit}`);
    console.log(`  Within limit:       ${grandTotal <= state.poolLimit ? '⚠ TIGHT' : '❌ EXCEEDS by ' + (grandTotal - state.poolLimit)}`);
    console.log('');

    if (grandTotal > state.poolLimit) {
      console.log('  ⚠ RECOMMENDATION:');
      console.log('     Normal only (60 calls) fits within free pool.');
      console.log('     Rare + Shiny adds 120 calls, exceeding by ' + (grandTotal - state.poolLimit) + '.');
      console.log('     Options:');
      console.log('       A) Generate normal only first (60 calls)');
      console.log('       B) Generate rare/shiny for MVP species only');
      console.log('       C) Wait for free pool reset (monthly?)');
    }
  }

  console.log('');
  console.log('  Current usage:');
  console.log(`    Already consumed: ${state.totalCalls} calls`);
  console.log(`    Remaining now:    ${remaining()}`);
  console.log('');
}

module.exports = {
  init,
  remaining,
  isAvailable,
  getModel,
  recordCall,
  markExhausted,
  resetAll,
  getReport,
  printEstimate,
  FreeQuotaExhaustedError,
};
