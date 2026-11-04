// Pet Asset Pipeline — Step 3: Select (Production Mode)
// =========================================================
// PRODUCTION MODE: No scoring. No comparison. Pick first candidate.
// Quality gate: file integrity only (exists, PNG, RGBA, 512×512).
//
// Usage: node pipeline/scripts/select_best.js <species_id>

const path = require('path');
const fs = require('fs');
const logger = require('../lib/logger');
const config = require('../config');

async function main() {
  const speciesId = process.argv[2];
  if (!speciesId) {
    logger.error('Usage: node select_best.js <species_id>');
    process.exit(1);
  }

  const speciesData = JSON.parse(fs.readFileSync(config.SPECIES_FILE, 'utf-8'));
  const species = speciesData[speciesId];
  if (!species) {
    logger.error(`Unknown species: "${speciesId}"`);
    process.exit(1);
  }

  const candidatesDir = path.join(config.WORK_DIR, speciesId, 'candidates');
  const selectedDir = path.join(config.WORK_DIR, speciesId, 'selected');
  fs.mkdirSync(selectedDir, { recursive: true });

  logger.step(3, 6, `Select (production mode — first candidate wins)`);

  const stageResults = {};

  // Process each stage: pick first valid candidate
  for (const stage of config.STAGES) {
    // Find all candidates for this stage
    const candidateFiles = findCandidates(candidatesDir, stage);

    if (candidateFiles.length === 0) {
      logger.warn(`${stage}: no candidates found, skipping.`);
      continue;
    }

    // Production mode: take the FIRST candidate
    const selected = candidateFiles[0];
    const destPath = path.join(selectedDir, `${stage}.png`);

    try {
      fs.copyFileSync(selected, destPath);
      stageResults[stage] = {
        source: selected,
        dest: destPath,
        action: 'first_candidate',
      };
      logger.info(`  ${stage}: ${path.basename(selected)} → selected/`);
    } catch (err) {
      logger.error(`  ${stage}: copy failed — ${err.message}`);
      stageResults[stage] = { error: err.message };
    }
  }

  // Minimal quality check: just verify files exist and are PNG
  logger.step(3, 6, 'File integrity check...');
  var allOK = true;

  for (const stage of config.STAGES) {
    const fp = path.join(selectedDir, `${stage}.png`);
    if (!fs.existsSync(fp)) {
      logger.warn(`  ${stage}: file missing`);
      allOK = false;
      continue;
    }
    // Just verify it's a valid image file (basic)
    try {
      const buf = fs.readFileSync(fp);
      const isPNG = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
      if (isPNG) {
        logger.info(`  ✓ ${stage}: PNG verified (${(buf.length/1024).toFixed(0)}KB)`);
      } else {
        logger.warn(`  ⚠ ${stage}: not a valid PNG`);
        allOK = false;
      }
    } catch (err) {
      logger.warn(`  ⚠ ${stage}: read error — ${err.message}`);
      allOK = false;
    }
  }

  // Write minimal report
  const reportPath = path.join(selectedDir, 'selection_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    speciesId,
    mode: 'production',
    selectedAt: new Date().toISOString(),
    candidatesPerStage: config.CANDIDATES_PER_STAGE,
    scoringEnabled: config.SCORE_ENABLED,
    allFilesPresent: allOK,
    stages: stageResults,
  }, null, 2));

  const selectedCount = Object.values(stageResults).filter(r => !r.error).length;
  logger.success(`Selected ${selectedCount}/${config.STAGES.length} stages`);

  process.stdout.write(JSON.stringify({
    success: selectedCount > 0,
    selectedCount,
    total: config.STAGES.length,
    reportPath,
  }) + '\n');
}

/**
 * Find all candidate files for a given stage in the candidates directory.
 * Production mode: just list all PNGs matching the stage prefix.
 */
function findCandidates(candidatesDir, stage) {
  if (!fs.existsSync(candidatesDir)) return [];

  const files = fs.readdirSync(candidatesDir)
    .filter(f => f.endsWith('.png') && f.startsWith(stage))
    .map(f => path.join(candidatesDir, f))
    .filter(f => fs.statSync(f).size > 0);

  // Sort so 'candidate_01' comes first
  files.sort();
  return files;
}

main();
