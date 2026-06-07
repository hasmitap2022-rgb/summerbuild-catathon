/**
 * routes/outfit.js
 * Express routes for outfit suggestions and wardrobe chat.
 *
 * Person 1 owns this file (Vib).
 *
 * Routes:
 *   POST /api/outfit/suggest   → Daily outfit suggestions (mood + plans + weather)
 *   POST /api/outfit/chat      → Natural language wardrobe chat (multi-turn)
 *   GET  /api/outfit/weather   → Current Singapore weather context
 *
 * Register in your main Express app:
 *   import outfitRouter from './routes/outfit.js';
 *   app.use('/api/outfit', outfitRouter);
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { suggestOutfits } from '../backend/outfitEngine.js';
import { chat } from '../reka/chat.js';
import { getWeatherContext } from '../backend/weather.js';

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------------------------------------------------------------------------
// Helper: fetch catalog from Supabase
// ---------------------------------------------------------------------------

async function fetchCatalog(userId) {
  const { data, error } = await supabase
    .from('wardrobe_items')
    .select('*')
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to fetch catalog: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Helper: fetch recent outfit item IDs (last 7 days) from Person 2's wear_logs
// This stops the engine repeating outfits worn recently.
// Table: wear_logs { id, user_id, item_ids: text[], worn_at: timestamptz }
// ---------------------------------------------------------------------------

async function fetchRecentItemIds(userId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('wear_logs')
    .select('item_ids')
    .eq('user_id', userId)
    .gte('worn_at', since);

  if (!data) return [];
  return [...new Set(data.flatMap(row => row.item_ids ?? []))];
}

// ---------------------------------------------------------------------------
// POST /api/outfit/suggest
// ---------------------------------------------------------------------------
// Body: { userId, mood?, plans? }
//
// Response:
// {
//   success: true,
//   suggestions: [
//     {
//       items: [{type, colour, pattern, formality, ...}],
//       score: 0.87,
//       rationale: "Great smart-casual look for a warm day.",
//       weatherContext: { label: "hot and humid", tempC: 33 }
//     },
//     ...
//   ]
// }

router.post('/suggest', async (req, res) => {
  try {
    const { userId, mood, plans } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required.' });
    }

    const [catalog, recentOutfitIds] = await Promise.all([
      fetchCatalog(userId),
      fetchRecentItemIds(userId)
    ]);

    if (catalog.length < 2) {
      return res.status(200).json({
        success: true,
        suggestions: [],
        message: 'Wardrobe is empty or too small. Complete a video sweep first.'
      });
    }

    const suggestions = await suggestOutfits({
      catalog,
      mood,
      plans,
      recentOutfitIds,
      topN: 3,
      withRationale: true
    });

    return res.status(200).json({ success: true, suggestions });

  } catch (err) {
    console.error('[POST /outfit/suggest]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/outfit/chat
// ---------------------------------------------------------------------------
// Multi-turn wardrobe chat. Caller is responsible for storing and sending history.
//
// Body:
// {
//   userId: "string",
//   message: "What haven't I worn in a while?",
//   history: [{ role: "user"|"assistant", content: "..." }]   // prior turns
// }
//
// Response:
// {
//   success: true,
//   reply: "You haven't worn your olive chinos in 3 weeks...",
//   intent: "unworn",
//   updatedHistory: [...]   // send this back on the next turn
// }

router.post('/chat', async (req, res) => {
  try {
    const { userId, message, history = [] } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ success: false, error: 'userId and message are required.' });
    }

    // Cap history at last 20 turns to avoid token bloat
    const trimmedHistory = history.slice(-20);

    const [catalog, weatherContext] = await Promise.all([
      fetchCatalog(userId),
      getWeatherContext()
    ]);

    const { reply, intent, updatedHistory } = await chat({
      userMessage: message,
      history: trimmedHistory,
      catalog,
      weatherContext
    });

    return res.status(200).json({
      success: true,
      reply,
      intent,
      updatedHistory
    });

  } catch (err) {
    console.error('[POST /outfit/chat]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/outfit/weather
// Returns current Singapore weather (useful for the frontend to display)
// ---------------------------------------------------------------------------

router.get('/weather', async (req, res) => {
  try {
    const weather = await getWeatherContext();
    return res.status(200).json({ success: true, weather });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
