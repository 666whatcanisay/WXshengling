// Pet Asset Pipeline — Step 2: Chain Grow (Production Mode)
// =============================================================
// PRODUCTION MODE: Generate 1 candidate per stage. No comparison.
// No scoring. Use first result directly. Fail → skip and continue.
//
// Usage: node pipeline/scripts/chain_grow.js <species_id>

const path = require('path');
const fs = require('fs');
const logger = require('../lib/logger');
const bl = require('../lib/bl-wrapper');
const config = require('../config');

async function main() {
  const speciesId = process.argv[2];
  if (!speciesId) {
    logger.error('Usage: node chain_grow.js <species_id>');
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

  // Find baby — first candidate or already selected
  const babyWinnerPath = path.join(selectedDir, 'baby.png');
  let currentBasePath;

  if (fs.existsSync(babyWinnerPath)) {
    currentBasePath = babyWinnerPath;
    logger.info(`Using baby: ${babyWinnerPath}`);
  } else {
    // Find any baby candidate
    const babyManifestPath = path.join(candidatesDir, 'baby_manifest.json');
    let babyFile = null;

    if (fs.existsSync(babyManifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(babyManifestPath, 'utf-8'));
      babyFile = (manifest.files || []).find(f => fs.existsSync(f));
    }
    if (!babyFile) {
      // Try direct search
      const files = fs.readdirSync(candidatesDir).filter(f => f.startsWith('baby') && f.endsWith('.png'));
      if (files.length > 0) babyFile = path.join(candidatesDir, files[0]);
    }
    if (!babyFile) {
      logger.error('No baby candidate found. Run generate_baby.js first.');
      process.exit(1);
    }

    fs.copyFileSync(babyFile, babyWinnerPath);
    currentBasePath = babyWinnerPath;
    logger.info(`Using baby candidate: ${path.basename(babyFile)}`);
  }

  const stageResults = { baby: currentBasePath };

  logger.step(2, 6, `Chain-growing ${species.name_zh} (production mode)`);

  for (const transition of config.GROW_TRANSITIONS) {
    const { from, to, promptKey } = transition;
    const growPrompt = species.prompts[promptKey];

    if (!growPrompt) {
      logger.warn(`${from}→${to}: no prompt, skipping.`);
      stageResults[to] = null;
      continue;
    }

    const fromPath = stageResults[from];
    if (!fromPath || !fs.existsSync(fromPath)) {
      logger.warn(`${from}→${to}: source missing, skipping.`);
      stageResults[to] = null;
      continue;
    }

    logger.info(`--- ${from} → ${to} ---`);

    try {
      const result = bl.edit({
        image: fromPath,
        prompt: growPrompt,
        n: config.CANDIDATES_PER_STAGE, // Production: 1
        size: config.GENERATE_SIZE,
        outDir: candidatesDir,
        outPrefix: `${to}_from_${from}`,
        negativePrompt: '改变毛色，改变品种，改变面部特征，不同角色，写实风格，场景背景，文字水印',
        retries: config.RETRY_MAX, // Production: 0
      });

      // Production: take the first saved file
      const savedFiles = result.saved || [];
      if (savedFiles.length === 0) {
        logger.warn(`${from}→${to}: no output files, skipping.`);
        stageResults[to] = null;
        continue;
      }

      const sourceFile = savedFiles[0];
      const canonicalPath = path.join(candidatesDir, `${to}_candidate_01.png`);

      if (path.resolve(sourceFile) !== path.resolve(canonicalPath)) {
        if (fs.existsSync(canonicalPath)) fs.unlinkSync(canonicalPath);
        fs.renameSync(sourceFile, canonicalPath);
      }

      // Copy directly to selected/
      const selectedPath = path.join(selectedDir, `${to}.png`);
      fs.copyFileSync(canonicalPath, selectedPath);

      stageResults[to] = selectedPath;

      // Write manifest
      const manifest = {
        speciesId,
        stage: to,
        transition: `${from}→${to}`,
        generatedAt: new Date().toISOString(),
        mode: 'production',
        count: 1,
        files: [canonicalPath],
        urls: result.urls || [],
      };
      fs.writeFileSync(
        path.join(candidatesDir, `${to}_manifest.json`),
        JSON.stringify(manifest, null, 2)
      );

      logger.success(`${to}: generated ✓`);

    } catch (err) {
      logger.error(`${from}→${to}: FAILED — ${err.message}`);
      stageResults[to] = null;
      // Production: continue to next stage despite failure
    }
  }

  const successCount = Object.values(stageResults).filter(r => r !== null && r !== undefined).length;
  const allStages = ['baby', 'youth', 'adult', 'perfect'];
  const failedStages = allStages.filter(s => !stageResults[s]);

  if (failedStages.length > 0) {
    logger.warn(`Missing stages: ${failedStages.join(', ')}`);
  }

  process.stdout.write(JSON.stringify({
    success: successCount >= 2, // at least baby + one more = acceptable
    speciesId,
    completedStages: successCount,
    totalStages: allStages.length,
    failedStages,
    stages: Object.fromEntries(
      Object.entries(stageResults).map(([k, v]) => [k, v ? path.basename(v) : null])
    ),
  }) + '\n');
}

main();
