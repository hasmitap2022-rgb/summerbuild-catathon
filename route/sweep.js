/**
 * routes/sweep.js
 * Express route: POST /api/sweep
 *
 * Person 1 owns this file (Vib).
 *
 * Accepts a video upload, runs the sweep pipeline, and saves results to Supabase.
 *
 * Usage:
 *   POST /api/sweep
 *   Content-Type: multipart/form-data
 *   Body: { video: <file>, userId: <string> }
 *
 *   Response:
 *   {
 *     success: true,
 *     catalogItems: [...],    // Newly added items
 *     frameCount: 42,
 *     durationSeconds: 84
 *   }
 *
 * Register in your main Express app:
 *   import sweepRouter from './routes/sweep.js';
 *   app.use('/api', sweepRouter);
 *
 * Dependencies:
 *   npm install multer @supabase/supabase-js
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import { runSweep } from '../reka/sweep.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // Use service key on the backend (bypasses RLS)
);

// ---------------------------------------------------------------------------
// Multer — store uploads in temp directory
// ---------------------------------------------------------------------------

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 500 * 1024 * 1024  // 500MB max video size
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Use MP4, MOV, AVI, WebM, or MKV.`));
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/sweep
// ---------------------------------------------------------------------------

router.post('/sweep', upload.single('video'), async (req, res) => {
  const videoPath = req.file?.path;

  try {
    // -- Validate --
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file uploaded.' });
    }

    const userId = req.body.userId || req.headers['x-user-id'];
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required.' });
    }

    console.log(`[POST /sweep] userId=${userId} file=${req.file.originalname} size=${req.file.size}`);

    // -- Run sweep pipeline --
    const { items, frameCount, durationSeconds } = await runSweep(videoPath);

    if (items.length === 0) {
      return res.status(200).json({
        success: true,
        catalogItems: [],
        frameCount,
        durationSeconds,
        message: 'No clothing items detected in the video. Try a clearer video with better lighting.'
      });
    }

    // -- Save to Supabase --
    // Each item becomes a row in the `wardrobe_items` table.
    // Table schema (create this in Supabase):
    //
    //   id          uuid primary key default gen_random_uuid()
    //   user_id     text not null
    //   type        text not null
    //   colour      text not null
    //   pattern     text not null
    //   formality   text not null
    //   occurrences integer default 1
    //   wear_count  integer default 0
    //   created_at  timestamptz default now()
    //
    // Enable RLS and add policy: allow select/insert/update for authenticated users where user_id = auth.uid()

    const rows = items.map(item => ({
      id: uuidv4(),
      user_id: userId,
      type: item.type,
      colour: item.colour,
      pattern: item.pattern,
      formality: item.formality,
      occurrences: item.occurrences,
      wear_count: 0
    }));

    const { data: insertedItems, error: dbError } = await supabase
      .from('wardrobe_items')
      .insert(rows)
      .select();

    if (dbError) {
      console.error('[POST /sweep] Supabase insert error:', dbError);
      return res.status(500).json({ success: false, error: 'Failed to save catalog to database.' });
    }

    console.log(`[POST /sweep] Saved ${insertedItems.length} items to Supabase for userId=${userId}`);

    return res.status(200).json({
      success: true,
      catalogItems: insertedItems,
      frameCount,
      durationSeconds
    });

  } catch (err) {
    console.error('[POST /sweep] Error:', err);
    return res.status(500).json({
      success: false,
      error: err.message ?? 'Internal server error during sweep.'
    });
  } finally {
    // Clean up the uploaded video file
    if (videoPath && fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/sweep/catalog?userId=xxx
// Returns the full wardrobe catalog for a user
// (Used by the outfit engine, chat, and Person 3's frontend)
// ---------------------------------------------------------------------------

router.get('/sweep/catalog', async (req, res) => {
  const userId = req.query.userId || req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId is required.' });
  }

  const { data, error } = await supabase
    .from('wardrobe_items')
    .select('*')
    .eq('user_id', userId)
    .order('wear_count', { ascending: true }); // least worn first

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

  return res.status(200).json({ success: true, catalog: data });
});

export default router;
