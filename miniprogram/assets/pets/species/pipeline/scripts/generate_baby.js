// Pet Asset Pipeline — Step 1: Generate Baby
// ==============================================
// Generates baby-stage candidates using bl image generate.
//
// Usage: node pipeline/scripts/generate_baby.js <species_id>

const path = require('path');
const fs = require('fs');
const logger = require('../lib/logger');
const bl = require('../lib/bl-wrapper');
const config = require('../config');

async function main() {
  const speciesId = process.argv[2];
  if (!speciesId) {
    logger.error('Usage: node generate_baby.js <species_id>');
    process.exit(1);
  }

  // Load species definition
  const speciesFile = config.SPECIES_FILE;
  if (!fs.existsSync(speciesFile)) {
    logger.error(`Species file not found: ${speciesFile}`);
    process.exit(1);
  }
  const speciesData = JSON.parse(fs.readFileSync(speciesFile, 'utf-8'));
  const species = speciesData[speciesId];
  if (!species) {
    logger.error(`Unknown species: "${speciesId}". Available: ${Object.keys(speciesData).join(', ')}`);
    process.exit(1);
  }

  const babyPrompt = species.prompts.baby;
  if (!babyPrompt) {
    logger.error(`No baby prompt defined for ${speciesId}`);
    process.exit(1);
  }

  // Setup working directories
  const candidatesDir = path.join(config.WORK_DIR, speciesId, 'candidates');
  fs.mkdirSync(candidatesDir, { recursive: true });

  logger.step(1, 6, `Generating baby candidates for ${species.name_zh} (${speciesId})`);
  logger.info(`Prompt: ${babyPrompt.slice(0, 100)}...`);

  try {
    const result = bl.generate({
      prompt: babyPrompt,
      n: config.CANDIDATES_PER_STAGE,
      size: config.GENERATE_SIZE,
      model: config.GENERATE_MODEL,
      outDir: candidatesDir,
      outPrefix: 'baby_candidate',
      retries: config.RETRY_MAX,
    });

    // Rename saved files to canonical names
    const savedFiles = result.saved || [];
    const canonicalPaths = [];

    for (let i = 0; i < savedFiles.length; i++) {
      const canonicalName = `baby_candidate_${String(i + 1).padStart(2, '0')}.png`;
      const canonicalPath = path.join(candidatesDir, canonicalName);

      // If bl saved with a different name, rename
      if (path.resolve(savedFiles[i]) !== path.resolve(canonicalPath)) {
        if (fs.existsSync(canonicalPath)) {
          fs.unlinkSync(canonicalPath);
        }
        fs.renameSync(savedFiles[i], canonicalPath);
      }
      canonicalPaths.push(canonicalPath);
    }

    // Write manifest
    const manifest = {
      speciesId,
      stage: 'baby',
      generatedAt: new Date().toISOString(),
      count: canonicalPaths.length,
      files: canonicalPaths,
      urls: result.urls || [],
    };
    fs.writeFileSync(
      path.join(candidatesDir, 'baby_manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    logger.success(`Generated ${canonicalPaths.length} baby candidate(s)`);
    canonicalPaths.forEach(p => logger.info(`  ${p}`));

    // Output JSON result for pipeline.js consumption
    process.stdout.write(JSON.stringify({ success: true, files: canonicalPaths }) + '\n');

  } catch (err) {
    logger.error(`Baby generation failed: ${err.message}`);
    process.stdout.write(JSON.stringify({ success: false, error: err.message }) + '\n');
    process.exit(1);
  }
}

main();
