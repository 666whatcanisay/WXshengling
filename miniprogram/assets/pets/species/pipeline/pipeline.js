// Pet Asset Pipeline — Master Orchestrator (Production Mode)
// ==============================================================
// PRODUCTION MODE: Generate all 15 species. Fail fast, skip errors.
// No retry. No scoring. No quality gate blocking.
//
// Usage:
//   node pipeline/pipeline.js <species_id>
//   node pipeline/pipeline.js --all          # All 15 species
//   node pipeline/pipeline.js --list         # List species
//   node pipeline/pipeline.js --dry-run      # Validate config

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('./lib/logger');
const quota = require('./lib/quota-manager');
const config = require('./config');

const SCRIPTS_DIR = path.join(__dirname, 'scripts');

// ---- Production statistics ----
const stats = {
  startedAt: new Date().toISOString(),
  species: {},
  totalGenerated: 0,
  totalFailed: 0,
  modelUsage: {},
};

function runScript(scriptName, speciesId) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }

  const stdout = execSync(`node "${scriptPath}" ${speciesId}`, {
    encoding: 'utf-8',
    timeout: 300000,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: config.ROOT,
  });

  // Parse last JSON line as result
  const lines = stdout.trim().split('\n');
  let result = { success: true };
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      result = JSON.parse(lines[i]);
      break;
    } catch (e) { /* continue */ }
  }
  return result;
}

async function runPipeline(speciesId) {
  const speciesData = JSON.parse(fs.readFileSync(config.SPECIES_FILE, 'utf-8'));
  const species = speciesData[speciesId];
  if (!species) {
    logger.error(`Unknown species: "${speciesId}"`);
    return { speciesId, success: false, error: 'unknown_species' };
  }

  const startTime = Date.now();
  const speciesStats = { speciesId, name: species.name_zh, category: species.category, stages: {}, errors: [] };

  // Setup directories
  const workDir = path.join(config.WORK_DIR, speciesId);
  for (const sub of ['candidates', 'selected', 'processed']) {
    fs.mkdirSync(path.join(workDir, sub), { recursive: true });
  }
  fs.mkdirSync(path.join(config.ASSETS_DIR, speciesId), { recursive: true });

  logger.info(`\n${'─'.repeat(50)}`);
  logger.info(`  ${species.name_zh} (${speciesId})  [${species.category}]`);
  logger.info(`${'─'.repeat(50)}`);

  // ---- Step 1: Generate Baby ----
  try {
    const t0 = Date.now();
    const result = runScript('generate_baby.js', speciesId);
    speciesStats.stages.baby = result.success ? 'ok' : 'failed';
    if (!result.success) speciesStats.errors.push('baby: ' + (result.error || 'unknown'));
    logger.info(`  Step1 baby: ${(Date.now() - t0) / 1000}s ${result.success ? '✓' : '✗'}`);
  } catch (err) {
    speciesStats.stages.baby = 'error';
    speciesStats.errors.push('baby: ' + err.message);
    logger.error(`  Step1 baby: ERROR — ${err.message}`);
  }

  // ---- Step 2: Chain Grow ----
  try {
    const t0 = Date.now();
    const result = runScript('chain_grow.js', speciesId);
    for (const st of ['youth', 'adult', 'perfect']) {
      speciesStats.stages[st] = result.stages?.[st] ? 'ok' : (result.failedStages?.includes(st) ? 'failed' : 'ok');
    }
    if (!result.success) speciesStats.errors.push('grow: ' + (result.error || 'partial failure'));
    logger.info(`  Step2 grow: ${(Date.now() - t0) / 1000}s ${result.success ? '✓' : '⚠ partial'}`);
  } catch (err) {
    for (const st of ['youth', 'adult', 'perfect']) speciesStats.stages[st] = 'error';
    speciesStats.errors.push('grow: ' + err.message);
    logger.error(`  Step2 grow: ERROR — ${err.message}`);
  }

  // ---- Step 3: Select (production: first candidate) ----
  try {
    const t0 = Date.now();
    const result = runScript('select_best.js', speciesId);
    logger.info(`  Step3 select: ${(Date.now() - t0) / 1000}s ${result.success ? '✓' : '⚠'}`);
  } catch (err) {
    speciesStats.errors.push('select: ' + err.message);
    logger.error(`  Step3 select: ERROR — ${err.message}`);
  }

  // ---- Step 4: De-background ----
  try {
    const t0 = Date.now();
    const result = runScript('debackground.js', speciesId);
    logger.info(`  Step4 debackground: ${(Date.now() - t0) / 1000}s processed=${result.processed || 0}`);
  } catch (err) {
    speciesStats.errors.push('debackground: ' + err.message);
    logger.error(`  Step4 debackground: ERROR — ${err.message}`);
  }

  // ---- Step 5: Compress ----
  try {
    const t0 = Date.now();
    const result = runScript('compress.js', speciesId);
    logger.info(`  Step5 compress: ${(Date.now() - t0) / 1000}s`);
  } catch (err) {
    speciesStats.errors.push('compress: ' + err.message);
    logger.error(`  Step5 compress: ERROR — ${err.message}`);
  }

  // ---- Step 6: Thumbnails ----
  try {
    const t0 = Date.now();
    const result = runScript('thumbnail.js', speciesId);
    logger.info(`  Step6 thumbnail: ${(Date.now() - t0) / 1000}s`);
  } catch (err) {
    speciesStats.errors.push('thumbnail: ' + err.message);
    logger.error(`  Step6 thumbnail: ERROR — ${err.message}`);
  }

  // ---- Count output files ----
  const outputDir = path.join(config.ASSETS_DIR, speciesId);
  if (fs.existsSync(outputDir)) {
    const pngs = fs.readdirSync(outputDir).filter(f => f.endsWith('.png'));
    speciesStats.outputFiles = pngs.length;
    speciesStats.outputSizeKB = pngs.reduce((sum, f) => sum + fs.statSync(path.join(outputDir, f)).size, 0) / 1024;
  }

  speciesStats.durationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
  speciesStats.success = speciesStats.errors.length === 0;

  // Count success
  const stageOK = Object.values(speciesStats.stages).filter(s => s === 'ok').length;
  stats.totalGenerated += stageOK;
  stats.totalFailed += 4 - stageOK;
  stats.species[speciesId] = speciesStats;

  const icon = speciesStats.success ? '✅' : '⚠️';
  logger.info(`  ${icon} ${species.name_zh}: ${stageOK}/4 stages, ${speciesStats.outputFiles || 0} files, ${speciesStats.durationSec}s`);

  return speciesStats;
}

// ---- Entry ----
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Pet Asset Pipeline — Production Mode');
    console.log('');
    console.log('Usage:');
    console.log('  node pipeline/pipeline.js <species_id>       Single species');
    console.log('  node pipeline/pipeline.js --all               All 15 species');
    console.log('  node pipeline/pipeline.js --list              List species');
    console.log('  node pipeline/pipeline.js --dry-run           Validate config');
    console.log('  node pipeline/pipeline.js --estimate          Cost forecast (normal only)');
    console.log('  node pipeline/pipeline.js --estimate --with-rarity  Cost forecast (all variants)');
    process.exit(0);
  }

  if (args.includes('--list')) {
    const speciesData = JSON.parse(fs.readFileSync(config.SPECIES_FILE, 'utf-8'));
    const speciesKeys = Object.keys(speciesData).filter(k => !k.startsWith('_'));
    console.log(`${speciesKeys.length} species:`);
    for (const id of speciesKeys) {
      console.log(`  ${id.padEnd(22)} ${speciesData[id].name_zh.padEnd(6)} ${speciesData[id].category}`);
    }
    process.exit(0);
  }

  if (args.includes('--dry-run')) {
    logger.info('PRODUCTION MODE — dry run');
    logger.info(`GENERATE_MODEL: ${config.GENERATE_MODEL}`);
    logger.info(`EDIT_MODEL: ${config.EDIT_MODEL}`);
    logger.info(`FREE_POOL: ${config.FREE_POOL_LIMIT} shared across all image models`);
    logger.info(`ALLOW_PAID_MODEL: ${config.ALLOW_PAID_MODEL}`);
    logger.info(`CANDIDATES_PER_STAGE: ${config.CANDIDATES_PER_STAGE}`);
    logger.info(`RETRY_MAX: ${config.RETRY_MAX}`);
    logger.info(`SCORE_ENABLED: ${config.SCORE_ENABLED}`);
    logger.success('Configuration valid.');
    process.exit(0);
  }

  if (args.includes('--estimate')) {
    const includeRareShiny = args.includes('--with-rarity');
    quota.printEstimate(config.SPECIES_COUNT, config.STAGES_PER_SPECIES, includeRareShiny);
    process.exit(0);
  }

  // ---- Production Mode ----
  logger.info('╔══════════════════════════════════════════╗');
  logger.info('║  Pet V7.1  ASSET PRODUCTION MODE         ║');
  logger.info('║  15 species × 4 stages = 60 images       ║');
  logger.info('╚══════════════════════════════════════════╝');
  logger.info(`  Generate: ${config.GENERATE_MODEL}`);
  logger.info(`  Edit:     ${config.EDIT_MODEL}`);
  logger.info(`  Paid models: ${config.ALLOW_PAID_MODEL ? 'ALLOWED ⚠' : 'BLOCKED ✓'}`);
  logger.info(`  Retry: ${config.RETRY_MAX > 0 ? config.RETRY_MAX : 'DISABLED'}`);
  logger.info(`  Scoring: ${config.SCORE_ENABLED ? 'enabled' : 'DISABLED'}`);
  logger.info('');

  // Determine which species to run
  const speciesData = JSON.parse(fs.readFileSync(config.SPECIES_FILE, 'utf-8'));
  const allSpecies = Object.keys(speciesData).filter(k => !k.startsWith('_'));

  let targets;
  if (args.includes('--all')) {
    targets = allSpecies;
  } else {
    targets = [args[0]];
    if (!allSpecies.includes(args[0])) {
      logger.error(`Unknown species: "${args[0]}"`);
      logger.info(`Use --list to see all ${allSpecies.length} species.`);
      process.exit(1);
    }
  }

  logger.info(`Targets: ${targets.length} species`);
  logger.info('');

  // Run pipeline for each species
  for (let i = 0; i < targets.length; i++) {
    const speciesId = targets[i];
    logger.info(`[${i + 1}/${targets.length}] ${speciesId}`);
    try {
      await runPipeline(speciesId);
    } catch (err) {
      logger.error(`Pipeline crashed for ${speciesId}: ${err.message}`);
      stats.species[speciesId] = { speciesId, success: false, error: err.message };
    }
  }

  // ---- Final Statistics ----
  logger.info('\n' + '═'.repeat(55));
  logger.info('  PRODUCTION COMPLETE');
  logger.info('═'.repeat(55));

  const speciesOK = Object.values(stats.species).filter(s => s.success).length;
  const speciesFail = Object.values(stats.species).filter(s => !s.success).length;

  logger.info(`  Species: ${speciesOK} ok, ${speciesFail} failed`);
  logger.info(`  Stages:  ${stats.totalGenerated} generated, ${stats.totalFailed} failed`);
  logger.info(`  Duration: ${((Date.now() - new Date(stats.startedAt).getTime()) / 1000).toFixed(0)}s`);

  // Per-species breakdown
  logger.info('');
  for (const [id, s] of Object.entries(stats.species)) {
    const icon = s.success ? '✅' : '⚠️';
    const stageDetail = ['baby', 'youth', 'adult', 'perfect']
      .map(st => s.stages[st] === 'ok' ? st : '--')
      .join(' | ');
    logger.info(`  ${icon} ${id.padEnd(20)} [${stageDetail}]  ${s.outputFiles || 0} files`);
  }

  // Model usage report
  logger.info('');
  logger.info('  Model usage:');
  const report = quota.getReport();
  for (const [model, info] of Object.entries(report)) {
    logger.info(`    ${model}: ${info.callsUsed} calls, ${info.status}`);
  }

  // Final JSON
  logger.summary({
    mode: 'production',
    completedAt: new Date().toISOString(),
    speciesTotal: targets.length,
    speciesOK,
    speciesFail,
    stagesGenerated: stats.totalGenerated,
    stagesFailed: stats.totalFailed,
    durationSec: Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
    modelUsage: report,
    species: stats.species,
  });

  process.exit(speciesFail > 0 ? 1 : 0);
}

main();
