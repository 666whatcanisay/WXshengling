// Pet Asset Pipeline — Step 5: Compress
// ==========================================
// Resizes to 512×512 and compresses to ≤300KB.
//
// Usage: node pipeline/scripts/compress.js <species_id>

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const logger = require('../lib/logger');
const { loadImage, resizeTo, compressToTarget } = require('../lib/image-utils');
const config = require('../config');

async function main() {
  const speciesId = process.argv[2];
  if (!speciesId) {
    logger.error('Usage: node compress.js <species_id>');
    process.exit(1);
  }

  const speciesData = JSON.parse(fs.readFileSync(config.SPECIES_FILE, 'utf-8'));
  const species = speciesData[speciesId];
  if (!species) {
    logger.error(`Unknown species: "${speciesId}"`);
    process.exit(1);
  }

  const processedDir = path.join(config.WORK_DIR, speciesId, 'processed');
  const outputDir = path.join(config.ASSETS_DIR, speciesId);
  fs.mkdirSync(outputDir, { recursive: true });

  logger.step(5, 6, `Compressing to ${config.FINAL_SIZE}×${config.FINAL_SIZE} ≤${config.FINAL_MAX_KB}KB for ${species.name_zh}`);

  const results = {};

  for (const stage of config.STAGES) {
    const inputPath = path.join(processedDir, `${stage}_rgba.png`);

    if (!fs.existsSync(inputPath)) {
      // Try fallback: selected dir
      const fallbackPath = path.join(config.WORK_DIR, speciesId, 'selected', `${stage}.png`);
      if (fs.existsSync(fallbackPath)) {
        logger.warn(`${stage}: no RGBA version, using selected/ as fallback`);
      } else {
        logger.warn(`${stage}: input not found, skipping.`);
        continue;
      }
    }

    const outputPath = path.join(outputDir, `${stage}.png`);
    const srcPath = fs.existsSync(inputPath) ? inputPath
      : path.join(config.WORK_DIR, speciesId, 'selected', `${stage}.png`);

    logger.info(`Compressing ${stage}...`);

    try {
      let img = loadImage(srcPath);

      // Resize to target size
      img = resizeTo(img, config.FINAL_SIZE);

      // Compress to target file size
      const buffer = await compressToTarget(img, config.FINAL_MAX_KB, config.FINAL_SIZE);
      fs.writeFileSync(outputPath, buffer);

      const sizeKB = (buffer.length / 1024).toFixed(1);
      const meta = await sharp(buffer).metadata();
      const status = buffer.length / 1024 <= config.FINAL_MAX_KB ? '✓' : '⚠';

      results[stage] = {
        output: outputPath,
        sizeKB: parseFloat(sizeKB),
        dimensions: `${meta.width}x${meta.height}`,
        withinLimit: buffer.length / 1024 <= config.FINAL_MAX_KB,
        channels: meta.channels,
        hasAlpha: meta.hasAlpha,
      };

      logger.success(`${stage}: ${meta.width}x${meta.height}, ${sizeKB}KB, alpha=${meta.hasAlpha} ${status}`);

    } catch (err) {
      logger.error(`${stage}: compress failed — ${err.message}`);
      results[stage] = { error: err.message };
    }
  }

  // Write compression report
  const reportPath = path.join(outputDir, 'compress_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    speciesId,
    compressedAt: new Date().toISOString(),
    target: { size: config.FINAL_SIZE, maxKB: config.FINAL_MAX_KB },
    results,
  }, null, 2));

  const allWithinLimit = Object.values(results)
    .filter(r => !r.error)
    .every(r => r.withinLimit);

  process.stdout.write(JSON.stringify({
    success: Object.values(results).some(r => !r.error),
    allWithinLimit,
    results,
  }) + '\n');
}

main();
