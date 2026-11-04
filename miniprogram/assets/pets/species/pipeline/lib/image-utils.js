// Pet Asset Pipeline — Image Utilities (sharp-based)
// =====================================================

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

/**
 * Open an image and ensure RGBA colorspace.
 * @param {string} filePath
 * @returns {sharp.Sharp}
 */
function loadImage(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Image not found: ${filePath}`);
  }
  return sharp(filePath).ensureAlpha();
}

/**
 * Get image metadata.
 * @param {string} filePath
 * @returns {Promise<sharp.Metadata>}
 */
async function getMetadata(filePath) {
  return sharp(filePath).metadata();
}

/**
 * Flood-fill debackground: removes white background by flood-filling
 * from image edges, preserving interior white regions (fur, highlights).
 *
 * Algorithm:
 * 1. Mark pixels where max(R,G,B) >= threshold as "background candidates"
 * 2. Flood-fill from all 4 edges through background candidates → alpha=0
 * 3. For remaining interior background candidates, apply soft alpha transition
 * 4. Morphological close on alpha channel (1px)
 *
 * @param {sharp.Sharp} img - Input image pipeline
 * @param {object} opts
 * @param {number} [opts.thresholdMin=230] - Below: fully opaque
 * @param {number} [opts.thresholdMax=248] - Above: fully transparent
 * @param {number} [opts.morphRadius=1] - Morph close radius
 * @returns {sharp.Sharp} - Pipeline with alpha channel applied
 */
async function whiteToAlpha(img, opts = {}) {
  const {
    thresholdMin = 230,
    thresholdMax = 248,
    morphRadius = 1,
  } = opts;

  // Get raw RGBA pixel data at working resolution
  // Use 1024x1024 for processing speed, then scale back up
  const meta = await img.metadata();
  const workSize = Math.min(1024, meta.width || 2048);

  const { data, info } = await img
    .clone()
    .resize(workSize, workSize, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = new Uint8Array(data); // RGBA

  // Step 1: Identify background candidates
  const isBgCandidate = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const whiteness = Math.max(r, g, b);
    if (whiteness >= thresholdMin) {
      isBgCandidate[i / 4] = 1;
    }
  }

  // Step 2: Flood-fill from edges
  const visited = new Uint8Array(width * height);
  const queue = [];

  function enqueueEdge(x, y) {
    const idx = y * width + x;
    if (!visited[idx] && isBgCandidate[idx]) {
      visited[idx] = 1;
      queue.push([x, y]);
    }
  }

  // Seed from all 4 edges
  for (let x = 0; x < width; x++) {
    enqueueEdge(x, 0);
    enqueueEdge(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqueueEdge(0, y);
    enqueueEdge(width - 1, y);
  }

  // BFS flood fill
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    // Set alpha to 0 for edge-connected background
    const pidx = (cy * width + cx) * 4;
    pixels[pidx + 3] = 0;

    // 4-connected neighbors
    if (cx > 0) enqueueEdge(cx - 1, cy);
    if (cx < width - 1) enqueueEdge(cx + 1, cy);
    if (cy > 0) enqueueEdge(cx, cy - 1);
    if (cy < height - 1) enqueueEdge(cx, cy + 1);
  }

  // Step 3: Handle interior background candidates (soft threshold)
  for (let i = 0; i < pixels.length; i += 4) {
    const idx = i / 4;
    if (isBgCandidate[idx] && !visited[idx]) {
      // Interior white — apply soft transition
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const whiteness = Math.max(r, g, b);

      if (whiteness >= thresholdMax) {
        pixels[i + 3] = 0;
      } else if (whiteness >= thresholdMin) {
        const t = (whiteness - thresholdMin) / (thresholdMax - thresholdMin);
        pixels[i + 3] = Math.round(255 * (1 - t));
      }
      // else: keep opaque (already at 255)
    }
  }

  // Step 4: Morphological close on alpha channel (1px)
  if (morphRadius > 0) {
    const alphaDilated = new Uint8Array(width * height);
    // Dilate: for each pixel, if any neighbor is opaque, mark as opaque
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let maxAlpha = 0;
        for (let dy = -morphRadius; dy <= morphRadius; dy++) {
          for (let dx = -morphRadius; dx <= morphRadius; dx++) {
            const a = pixels[((y + dy) * width + (x + dx)) * 4 + 3];
            if (a > maxAlpha) maxAlpha = a;
          }
        }
        alphaDilated[y * width + x] = maxAlpha;
      }
    }

    // Erode: for each pixel, if any neighbor is transparent, mark as transparent
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let minAlpha = 255;
        for (let dy = -morphRadius; dy <= morphRadius; dy++) {
          for (let dx = -morphRadius; dx <= morphRadius; dx++) {
            const a = alphaDilated[(y + dy) * width + (x + dx)];
            if (a < minAlpha) minAlpha = a;
          }
        }
        pixels[(y * width + x) * 4 + 3] = minAlpha;
      }
    }
  }

  // Return as sharp pipeline with the processed pixel data
  return sharp(pixels, {
    raw: { width, height, channels: 4 },
  });
}

/**
 * Trim transparent padding and center the subject.
 *
 * @param {sharp.Sharp} img - RGBA image
 * @param {number} [padding=8] - Padding around subject
 * @returns {sharp.Sharp}
 */
async function trimAndCenter(img, padding = 8) {
  const { data, info } = await img
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const pixels = data;

  // Find bounding box of non-transparent pixels
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Apply padding
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  if (cropW <= 0 || cropH <= 0) {
    // No content found — return as-is
    return img;
  }

  // Extract and place on a new transparent canvas of original size
  const extracted = await img
    .clone()
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .png()
    .toBuffer();

  // Center on original-size canvas
  const canvasSize = Math.max(width, cropW, cropH);
  const offsetX = Math.floor((canvasSize - cropW) / 2);
  const offsetY = Math.floor((canvasSize - cropH) / 2);

  return sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: extracted, top: offsetY, left: offsetX }]);
}

/**
 * Resize image to exact square dimensions.
 *
 * @param {sharp.Sharp} img
 * @param {number} size - Target width and height in px
 * @returns {sharp.Sharp}
 */
function resizeTo(img, size) {
  return img.clone().resize(size, size, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    kernel: sharp.kernel.lanczos3,
  });
}

/**
 * Compress PNG to fit within a target file size.
 * Tries: compression level → palette → size reduction.
 *
 * @param {sharp.Sharp} img
 * @param {number} maxKB - Maximum file size in KB
 * @param {number} [size=512] - Current pixel dimensions
 * @returns {Promise<Buffer>} - Compressed PNG buffer
 */
async function compressToTarget(img, maxKB, size = 512) {
  let buffer;
  let currentSize = size;

  // Strategy 1: Standard compression levels
  for (const level of [6, 9]) {
    buffer = await img.clone().png({ compressionLevel: level, quality: 90 }).toBuffer();
    if (buffer.length / 1024 <= maxKB) return buffer;
  }

  // Strategy 2: Palette PNG with 256 colors
  buffer = await img.clone().png({
    compressionLevel: 9,
    palette: true,
    colours: 256,
    quality: 90,
  }).toBuffer();
  if (buffer.length / 1024 <= maxKB) return buffer;

  // Strategy 3: Palette PNG with 128 colors
  buffer = await img.clone().png({
    compressionLevel: 9,
    palette: true,
    colours: 128,
    quality: 85,
  }).toBuffer();
  if (buffer.length / 1024 <= maxKB) return buffer;

  // Strategy 4: Reduce physical size by 10% and retry
  if (currentSize > 256) {
    currentSize = Math.floor(currentSize * 0.9);
    const smaller = resizeTo(img, currentSize);
    return compressToTarget(smaller, maxKB, currentSize);
  }

  // Last resort: return at minimum quality
  return img.clone().png({
    compressionLevel: 9,
    palette: true,
    colours: 64,
    quality: 75,
  }).toBuffer();
}

/**
 * Compute foreground pixel ratio for a region.
 * A pixel is "foreground" if max(R,G,B) < threshold.
 *
 * @param {sharp.Sharp} img
 * @param {number} [threshold=230]
 * @returns {Promise<number>} - Ratio [0, 1]
 */
async function foregroundRatio(img, threshold = 230) {
  // Downscale for performance
  const resized = img.clone().resize(256, 256, { fit: 'fill' }).ensureAlpha();
  const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true });

  let fgCount = 0;
  const totalPx = info.width * info.height;

  for (let i = 0; i < data.length; i += info.channels) {
    const maxRGB = Math.max(data[i], data[i + 1], data[i + 2]);
    if (maxRGB < threshold) fgCount++;
  }

  return fgCount / totalPx;
}

module.exports = {
  loadImage,
  getMetadata,
  whiteToAlpha,
  trimAndCenter,
  resizeTo,
  compressToTarget,
  foregroundRatio,
};
