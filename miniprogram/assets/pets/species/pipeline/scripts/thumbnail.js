// Pet Asset Pipeline — Step 6: Thumbnails
// ===========================================
// Generates 128×128 thumbnails from final compressed images.
//
// Usage: node pipeline/scripts/thumbnail.js <species_id>

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const logger = require('../lib/logger');
const config = require('../config');

async function main() {
  const speciesId = process.argv[2];
  if (!speciesId) {
    logger.error('Usage: node thumbnail.js <species_id>');
    process.exit(1);
  }

  const speciesData = JSON.parse(fs.readFileSync(config.SPECIES_FILE, 'utf-8'));
  const species = speciesData[speciesId];
  if (!species) {
    logger.error(`Unknown species: "${speciesId}"`);
    process.exit(1);
  }

  const inputDir = path.join(config.ASSETS_DIR, speciesId);
  const outputDir = inputDir; // Thumbnails go alongside main images

  logger.step(6, 6, `Generating ${config.THUMB_SIZE}×${config.THUMB_SIZE} thumbnails for ${species.name_zh}`);

  const results = {};

  for (const stage of config.STAGES) {
    const inputPath = path.join(inputDir, `${stage}.png`);
    const outputPath = path.join(outputDir, `${stage}_thumb.png`);

    if (!fs.existsSync(inputPath)) {
      logger.warn(`${stage}: main image not found at ${inputPath}, skipping.`);
      continue;
    }

    logger.info(`Thumbnailing ${stage}...`);

    try {
      await sharp(inputPath)
        .resize(config.THUMB_SIZE, config.THUMB_SIZE, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
          kernel: sharp.kernel.lanczos3,
        })
        .png({ compressionLevel: 9 })
        .toFile(outputPath);

      const stat = fs.statSync(outputPath);
      const meta = await sharp(outputPath).metadata();

      results[stage] = {
        output: outputPath,
        sizeKB: parseFloat((stat.size / 1024).toFixed(1)),
        dimensions: `${meta.width}x${meta.height}`,
        channels: meta.channels,
      };

      logger.success(`${stage}_thumb: ${meta.width}x${meta.height}, ${(stat.size / 1024).toFixed(1)}KB`);

    } catch (err) {
      logger.error(`${stage}: thumbnail failed — ${err.message}`);
      results[stage] = { error: err.message };
    }
  }

  process.stdout.write(JSON.stringify({
    success: Object.values(results).some(r => !r.error),
    results,
  }) + '\n');
}

main();
