/**
 * reka/sweep.js
 * Video sweep pipeline: extract frames → Reka Vision → structured catalog items → deduplicate
 *
 * Person 1 owns this file (Vib).
 *
 * Flow:
 *   1. Receive a video file path (already uploaded to local tmp by the route)
 *   2. Use ffmpeg to extract one frame per second as JPEG
 *   3. Send each frame to Reka Vision with a structured extraction prompt
 *   4. Parse the JSON response: { type, colour, pattern, formality }
 *   5. Deduplicate across frames (same item appearing in multiple frames → one catalog entry)
 *   6. Return the final deduplicated array of clothing items
 *
 * Dependencies (add to package.json):
 *   npm install fluent-ffmpeg @anthropic-ai/sdk axios form-data sharp uuid
 *   System: ffmpeg must be installed (apt install ffmpeg / brew install ffmpeg)
 */

const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REKA_API_KEY = process.env.REKA_API_KEY;
const REKA_VISION_URL = 'https://api.reka.ai/v1/chat';

// How many frames to extract per second of video.
// 0.5 = one frame every 2 seconds (good balance of coverage vs API cost)
const FRAMES_PER_SECOND = 0.5;

// Similarity threshold for deduplication (0–1). Items with cosine similarity
// above this are considered the same garment.
const DEDUP_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Step 1 — Extract frames from video using ffmpeg
// ---------------------------------------------------------------------------

/**
 * Extracts frames from a video file.
 * @param {string} videoPath  Absolute path to the video file
 * @param {string} outputDir  Directory to write JPEG frames into
 * @returns {Promise<string[]>} Sorted list of absolute frame file paths
 */
async function extractFrames(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    const pattern = path.join(outputDir, 'frame-%04d.jpg');

    ffmpeg(videoPath)
      .outputOptions([
        `-vf fps=${FRAMES_PER_SECOND}`,
        '-q:v 3',          // JPEG quality (1=best, 31=worst). 3 is high quality.
        '-vf scale=1280:-1' // Normalise width to 1280px, preserve aspect ratio
      ])
      .output(pattern)
      .on('end', () => {
        const frames = fs
          .readdirSync(outputDir)
          .filter(f => f.endsWith('.jpg'))
          .sort()
          .map(f => path.join(outputDir, f));
        resolve(frames);
      })
      .on('error', reject)
      .run();
  });
}

// ---------------------------------------------------------------------------
// Step 2 — Send a frame to Reka Vision and parse clothing items
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a wardrobe cataloguing assistant.
Look at this image and identify every distinct clothing item visible on the person.
For EACH item, return a JSON object with exactly these fields:
  - type: string  (e.g. "t-shirt", "jeans", "blazer", "dress", "sneakers", "belt")
  - colour: string  (primary colour, e.g. "navy blue", "white", "olive green")
  - pattern: string  (e.g. "solid", "striped", "checked", "floral", "graphic print")
  - formality: string  (one of: "casual", "smart-casual", "business", "formal", "activewear")

Return ONLY a valid JSON array. No prose, no markdown fences. Example:
[
  {"type":"t-shirt","colour":"white","pattern":"solid","formality":"casual"},
  {"type":"chino trousers","colour":"beige","pattern":"solid","formality":"smart-casual"}
]
If no clothing is visible, return an empty array: []`;

/**
 * Sends one frame to Reka Vision and returns parsed clothing items.
 * @param {string} framePath  Absolute path to a JPEG frame
 * @returns {Promise<Array<{type,colour,pattern,formality}>>}
 */
export async function analyseFrame(framePath) {
  // Convert image to base64
  const imageBuffer = await sharp(framePath)
    .jpeg({ quality: 85 })
    .toBuffer();
  const base64Image = imageBuffer.toString('base64');

  const payload = {
    model: 'reka-core',   // Use reka-core for best vision quality
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`
            }
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT
          }
        ]
      }
    ]
  };

  try {
    const response = await axios.post(REKA_VISION_URL, payload, {
      headers: {
        'X-Api-Key': REKA_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const rawText = response.data?.responses?.[0]?.message?.content
      ?? response.data?.choices?.[0]?.message?.content
      ?? '[]';

    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const items = JSON.parse(cleaned);

    if (!Array.isArray(items)) return [];

    // Validate shape — drop malformed entries
    return items.filter(
      item =>
        item &&
        typeof item.type === 'string' &&
        typeof item.colour === 'string' &&
        typeof item.pattern === 'string' &&
        typeof item.formality === 'string'
    );
  } catch (err) {
    // Log but don't crash the whole sweep — one bad frame is acceptable
    console.warn(`[sweep] analyseFrame failed for ${path.basename(framePath)}:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Deduplicate items across frames
// ---------------------------------------------------------------------------

/**
 * Turns a clothing item into a simple feature string for comparison.
 * e.g. "t-shirt|white|solid|casual"
 */
function itemSignature(item) {
  return [
    item.type.toLowerCase().trim(),
    item.colour.toLowerCase().trim(),
    item.pattern.toLowerCase().trim(),
    item.formality.toLowerCase().trim()
  ].join('|');
}

/**
 * Deduplicates an array of clothing items found across all frames.
 * Uses exact-match on the signature first, then fuzzy match on type+colour.
 *
 * @param {Array<{type,colour,pattern,formality,_frameCount?}>} allItems
 * @returns {Array<{type,colour,pattern,formality,occurrences}>}
 */
export function deduplicateItems(allItems) {
  const seen = new Map(); // signature → {item, count}

  for (const item of allItems) {
    const sig = itemSignature(item);

    if (seen.has(sig)) {
      seen.get(sig).count += 1;
    } else {
      // Check for near-duplicates: same type + same colour but slightly different pattern/formality label
      let matched = false;
      for (const [existingSig, entry] of seen.entries()) {
        const existing = entry.item;
        if (
          existing.type.toLowerCase() === item.type.toLowerCase() &&
          existing.colour.toLowerCase() === item.colour.toLowerCase()
        ) {
          // Treat as same item — prefer the entry with the higher count
          entry.count += 1;
          matched = true;
          break;
        }
      }
      if (!matched) {
        seen.set(sig, { item: { ...item }, count: 1 });
      }
    }
  }

  // Return sorted by occurrence count descending (most-seen items first)
  return Array.from(seen.values())
    .sort((a, b) => b.count - a.count)
    .map(({ item, count }) => ({
      ...item,
      occurrences: count  // How many frames this item appeared in
    }));
}

// ---------------------------------------------------------------------------
// Step 4 — Main pipeline export
// ---------------------------------------------------------------------------

/**
 * Full sweep pipeline. Call this from the Express route.
 *
 * @param {string} videoPath  Absolute path to the uploaded video file
 * @returns {Promise<{
 *   items: Array<{type,colour,pattern,formality,occurrences}>,
 *   frameCount: number,
 *   durationSeconds: number
 * }>}
 */
export async function runSweep(videoPath) {
  const tmpDir = path.join(os.tmpdir(), `closetos-sweep-${uuidv4()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`[sweep] Starting sweep for: ${path.basename(videoPath)}`);
  console.log(`[sweep] Frame output dir: ${tmpDir}`);

  try {
    // 1. Extract frames
    const frames = await extractFrames(videoPath, tmpDir);
    console.log(`[sweep] Extracted ${frames.length} frames`);

    if (frames.length === 0) {
      throw new Error('No frames could be extracted from the video. Check ffmpeg is installed.');
    }

    // 2. Analyse each frame (sequentially to avoid hammering the API)
    const allItems = [];
    for (let i = 0; i < frames.length; i++) {
      console.log(`[sweep] Analysing frame ${i + 1}/${frames.length}...`);
      const items = await analyseFrame(frames[i]);
      allItems.push(...items);

      // Small delay to be kind to the API rate limit
      if (i < frames.length - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log(`[sweep] Raw items found across all frames: ${allItems.length}`);

    // 3. Deduplicate
    const dedupedItems = deduplicateItems(allItems);
    console.log(`[sweep] Deduplicated catalog size: ${dedupedItems.length}`);

    return {
      items: dedupedItems,
      frameCount: frames.length,
      // Approximate duration: frames / fps
      durationSeconds: Math.round(frames.length / FRAMES_PER_SECOND)
    };
  } finally {
    // Always clean up temp frames
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[sweep] Cleaned up temp dir`);
  }
}
