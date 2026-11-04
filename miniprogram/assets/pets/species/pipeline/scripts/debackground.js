// Pet Asset Pipeline — Step 4: De-background
// ==============================================
// Converts white background to transparent (RGB → RGBA).
// Uses flood-fill from edges to distinguish background from
// interior white regions (fur, eye highlights).
//
// Usage: node pipeline/scripts/debackground.js <species_id>

const path = require('path');
const fs = require('fs');
const logger = require('../lib/logger');
const { loadImage, whiteToAlpha, trimAndCenter } = require('../lib/image-utils');
const config = require('../config');

async function main() {
  const speciesId = process.argv[2];
  if (!speciesId) {
    logger.error('Usage: node debackground.js <species_id>');
    process.exit(1);
  }

  const speciesData = JSON.parse(fs.readFileSync(config.SPECIES_FILE, 'utf-8'));
  const species = speciesData[speciesId];
  if (!species) {
    logger.error(`Unknown species: "${speciesId}"`);
    process.exit(1);
  }

  const selectedDir = path.join(config.WORK_DIR, speciesId, 'selected');
  const processedDir = path.join(config.WORK_DIR, speciesId, 'processed');
  fs.mkdirSync(processedDir, { recursive: true });

  logger.step(4, 6, `Removing white background for ${species.name_zh}`);

  const results = {};

  for (const stage of config.STAGES) {
    const inputPath = path.join(selectedDir, `${stage}.png`);
    const outputPath = path.join(processedDir, `${stage}_rgba.png`);

    if (!fs.existsSync(inputPath)) {
      logger.warn(`${stage}: input not found at ${inputPath}, skipping.`);
      continue;
    }

    logger.info(`Processing ${stage}...`);

    try {
      // Load image
      let img = loadImage(inputPath);

      // Apply white-to-alpha
      let processed = await whiteToAlpha(img, {
        thresholdMin: config.WHITE_THRESHOLD_MIN,
        thresholdMax: config.WHITE_THRESHOLD_MAX,
        morphRadius: config.MORPH_RADIUS,
      });

      // Trim and center
      processed = await trimAndCenter(processed, config.TRIM_PADDING);

      // Save RGBA PNG
      await processed.png({ compressionLevel: 6 }).toFile(outputPath);

      // Verify alpha channel
      const meta = await processed.metadata();
      results[stage] = {
        input: inputPath,
        output: outputPath,
        channels: meta.channels,
        hasAlpha: meta.hasAlpha,
        size: `${meta.width}x${meta.height}`,
      };

      logger.success(`${stage}: ${meta.width}x${meta.height}, channels=${meta.channels}, alpha=${meta.hasAlpha}`);

    } catch (err) {
      logger.error(`${stage}: debackground failed — ${err.message}`);
      results[stage] = { error: err.message };
    }
  }

  // Write processing report
  const reportPath = path.join(processedDir, 'debackground_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    speciesId,
    processedAt: new Date().toISOString(),
    config: {
      thresholdMin: config.WHITE_THRESHOLD_MIN,
      thresholdMax: config.WHITE_THRESHOLD_MAX,
      morphRadius: config.MORPH_RADIUS,
    },
    results,
  }, null, 2));

  const successCount = Object.values(results).filter(r => !r.error).length;
  process.stdout.write(JSON.stringify({
    success: successCount > 0,
    processed: successCount,
    total: config.STAGES.length,
    results,
  }) + '\n');
}

main();
