// Pet Asset Pipeline — Central Configuration
// =============================================
// MODE: PRODUCTION — prioritize output quantity over art perfection.

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

module.exports = {
  // ---- Mode ----
  PRODUCTION_MODE: true,

  // ---- Paths ----
  ROOT,
  WORK_DIR: path.join(ROOT, 'work'),
  ASSETS_DIR: path.join(ROOT, 'assets', 'pets'),
  SPECIES_FILE: path.join(__dirname, 'species.json'),

  // ---- Quota (SHARED POOL) ----
  // ALL Bailian image generation models share ONE free pool of 100 images.
  // Switching models does NOT give you more free quota.
  // Strategy: use the BEST model consistently, not rotate.
  FREE_POOL_LIMIT: 100,

  // Never set to true unless explicitly authorized.
  ALLOW_PAID_MODEL: false,

  // Best quality model for image generation (baby stage).
  // Used for all bl image generate calls.
  GENERATE_MODEL: 'wan2.7-image-pro',

  // Best edit-capable model for chain growth (youth/adult/perfect).
  // MUST be a Qwen-Image model (bl image edit requires Qwen-Image).
  EDIT_MODEL: 'qwen-image-2.0-pro',

  // Fallback models if primary is unavailable (same shared pool).
  // Only used if primary model returns an unexpected error (not Arrearage).
  GENERATE_FALLBACKS: [
    'wan2.7-image',
    'wan2.6-image',
    'qwen-image-2.0-pro',
    'qwen-image-2.0',
    'wan2.6-t2i',
  ],

  EDIT_FALLBACKS: [
    'qwen-image-2.0',
  ],

  // ---- Generation (Production Mode) ----
  CANDIDATES_PER_STAGE: 1,
  RETRY_MAX: 0,
  RETRY_BACKOFF_MS: [5000, 15000],
  IMAGE_SIZE: '2048*2048',
  GENERATE_SIZE: '1:1',
  WATERMARK: false,

  // ---- Quality Gate (Production Mode) ----
  QUALITY_CRITICAL_CHECKS: ['file_size', 'file_dimensions', 'file_alpha'],

  // ---- Scoring (Production Mode: DISABLED) ----
  SCORE_ENABLED: false,

  SCORE_WEIGHTS: {
    characterConsistency: 0.35,
    colorRichness: 0.20,
    composition: 0.25,
    foregroundRatio: 0.20,
  },

  TARGET_FG_RATIO: 0.45,
  MIN_ACCEPTABLE_SCORE: 0,

  // ---- Debackground ----
  WHITE_THRESHOLD_MIN: 230,
  WHITE_THRESHOLD_MAX: 248,
  TRANSITION_ZONE: [230, 248],
  MORPH_RADIUS: 1,
  TRIM_PADDING: 8,

  // ---- Compress ----
  FINAL_SIZE: 512,
  FINAL_MAX_KB: 300,
  THUMB_SIZE: 128,

  // ---- Stages ----
  STAGES: ['baby', 'youth', 'adult', 'perfect'],
  GROW_TRANSITIONS: [
    { from: 'baby', to: 'youth', promptKey: 'grow_youth' },
    { from: 'youth', to: 'adult', promptKey: 'grow_adult' },
    { from: 'adult', to: 'perfect', promptKey: 'grow_perfect' },
  ],

  // ---- Growth Fixer (Production Mode: minimal) ----
  GROWTH_FIXER_MIN_FG: 0.15,
  GROWTH_FIXER_MAX_FG: 0.95,

  // ---- Cost Estimate ----
  // Used by --estimate flag
  SPECIES_COUNT: 15,
  STAGES_PER_SPECIES: 4,
  // Per species API calls: 1 generate (baby) + 3 edit (grow)
  API_CALLS_PER_SPECIES: 4,
};
