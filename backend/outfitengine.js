/**
 * backend/outfitEngine.js
 * Daily outfit suggestion engine.
 *
 * Person 1 owns this file (Vib).
 *
 * Takes: mood + plans + weather + catalog → ranked outfit suggestions.
 * Does NOT use Reka for the core ranking (pure logic + scoring).
 * Optionally calls Reka LLM to generate a natural-language rationale.
 *
 * An "outfit" is a combination of catalog items that:
 *   - Are formality-compatible
 *   - Are colour-compatible
 *   - Cover all required clothing categories (top + bottom OR dress, + optional footwear/outerwear)
 *   - Haven't been worn together recently (blocks repeats — Person 3's calendar feeds into this)
 *   - Are weather-appropriate
 */

import { chat } from '../reka/chat.js';
import { getWeatherContext } from './weather.js';

// ---------------------------------------------------------------------------
// Formality compatibility matrix
// Adjacent levels are compatible; two+ levels apart are not.
// ---------------------------------------------------------------------------
const FORMALITY_LEVELS = {
  'activewear': 0,
  'casual': 1,
  'smart-casual': 2,
  'business': 3,
  'formal': 4
};

function formalityScore(a, b) {
  const la = FORMALITY_LEVELS[a?.toLowerCase()] ?? 1;
  const lb = FORMALITY_LEVELS[b?.toLowerCase()] ?? 1;
  const diff = Math.abs(la - lb);
  if (diff === 0) return 1.0;
  if (diff === 1) return 0.7;
  return 0; // incompatible
}

// ---------------------------------------------------------------------------
// Colour compatibility (simple rules — good enough for MVP)
// ---------------------------------------------------------------------------
const NEUTRAL_COLOURS = ['white', 'black', 'grey', 'gray', 'beige', 'navy', 'cream', 'khaki', 'brown'];
const WARM_COLOURS    = ['red', 'orange', 'yellow', 'coral', 'pink', 'burgundy', 'rust'];
const COOL_COLOURS    = ['blue', 'green', 'purple', 'teal', 'mint', 'lilac', 'olive'];

function colourFamily(colour) {
  const c = colour?.toLowerCase() ?? '';
  if (NEUTRAL_COLOURS.some(n => c.includes(n))) return 'neutral';
  if (WARM_COLOURS.some(n => c.includes(n))) return 'warm';
  if (COOL_COLOURS.some(n => c.includes(n))) return 'cool';
  return 'unknown';
}

function colourCompatibility(colourA, colourB) {
  const fa = colourFamily(colourA);
  const fb = colourFamily(colourB);
  if (fa === 'neutral' || fb === 'neutral') return 1.0; // neutrals go with everything
  if (fa === fb) return 0.85;                           // same family works
  if (fa === 'unknown' || fb === 'unknown') return 0.6; // can't tell, assume ok-ish
  return 0.5;                                           // warm + cool clash slightly
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------
const CATEGORY_MAP = {
  top:       ['t-shirt', 'shirt', 'blouse', 'top', 'sweater', 'hoodie', 'jumper', 'polo', 'tank'],
  bottom:    ['jeans', 'trousers', 'pants', 'shorts', 'skirt', 'chinos', 'leggings'],
  dress:     ['dress', 'jumpsuit', 'romper', 'playsuit'],
  outerwear: ['jacket', 'blazer', 'coat', 'cardigan', 'vest', 'waistcoat'],
  footwear:  ['shoes', 'sneakers', 'boots', 'sandals', 'loafers', 'heels', 'trainers'],
  accessory: ['belt', 'scarf', 'bag', 'hat', 'cap', 'watch']
};

function getCategory(type) {
  const t = type?.toLowerCase() ?? '';
  for (const [cat, keywords] of Object.entries(CATEGORY_MAP)) {
    if (keywords.some(k => t.includes(k))) return cat;
  }
  return 'other';
}

/**
 * Checks if a set of items forms a "complete" outfit.
 * Complete = (top + bottom) OR (dress) — with optional footwear/outerwear.
 */
function isCompleteOutfit(items) {
  const cats = items.map(i => getCategory(i.type));
  const hasDress = cats.includes('dress');
  const hasTop = cats.includes('top');
  const hasBottom = cats.includes('bottom');
  return hasDress || (hasTop && hasBottom);
}

// ---------------------------------------------------------------------------
// Weather filtering
// ---------------------------------------------------------------------------

/**
 * Returns true if an item is appropriate for current weather.
 */
function isWeatherAppropriate(item, weatherCtx) {
  const type = item.type?.toLowerCase() ?? '';
  const { isRainy, isHot } = weatherCtx;

  if (isHot) {
    // Avoid heavy outerwear in heat
    if (['coat', 'heavy jacket'].some(k => type.includes(k))) return false;
  }
  if (isRainy) {
    // Open-toe footwear not ideal in rain
    if (['sandals', 'flip flop'].some(k => type.includes(k))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mood / plans → target formality
// ---------------------------------------------------------------------------

const MOOD_FORMALITY = {
  relaxed: 'casual',
  chill: 'casual',
  casual: 'casual',
  comfortable: 'casual',
  active: 'activewear',
  sporty: 'activewear',
  gym: 'activewear',
  professional: 'business',
  work: 'business',
  office: 'business',
  meeting: 'business',
  smart: 'smart-casual',
  date: 'smart-casual',
  dinner: 'smart-casual',
  party: 'smart-casual',
  formal: 'formal',
  wedding: 'formal',
  interview: 'formal'
};

function inferTargetFormality(mood = '', plans = '') {
  const combined = `${mood} ${plans}`.toLowerCase();
  for (const [keyword, formality] of Object.entries(MOOD_FORMALITY)) {
    if (combined.includes(keyword)) return formality;
  }
  return 'casual'; // default for Singapore daily life
}

// ---------------------------------------------------------------------------
// Outfit scoring
// ---------------------------------------------------------------------------

/**
 * Scores a candidate outfit (array of items) against context.
 * Returns a score between 0 and 1.
 */
function scoreOutfit(items, { targetFormality, weatherCtx, recentOutfitIds = [] }) {
  let score = 1.0;

  // 1. Completeness check (hard filter handled upstream, but penalise incomplete)
  if (!isCompleteOutfit(items)) score *= 0.1;

  // 2. Formality alignment
  const formalityScores = items.map(i => formalityScore(i.formality, targetFormality));
  const avgFormality = formalityScores.reduce((a, b) => a + b, 0) / formalityScores.length;
  score *= avgFormality;

  // 3. Colour compatibility (check all pairs)
  const pairs = [];
  for (let i = 0; i < items.length - 1; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push(colourCompatibility(items[i].colour, items[j].colour));
    }
  }
  if (pairs.length > 0) {
    const avgColour = pairs.reduce((a, b) => a + b, 0) / pairs.length;
    score *= avgColour;
  }

  // 4. Prioritise less-worn items (freshness bonus)
  const avgWearCount = items.reduce((a, i) => a + (i.wearCount ?? 0), 0) / items.length;
  const freshnessBonus = Math.max(0, 1 - avgWearCount / 20); // fades after 20 wears
  score *= (0.7 + 0.3 * freshnessBonus);

  // 5. Weather penalty for inappropriate items
  const weatherPenalty = items.filter(i => !isWeatherAppropriate(i, weatherCtx)).length;
  score *= Math.pow(0.5, weatherPenalty);

  // 6. Penalise if any item was worn recently
  const recentSet = new Set(recentOutfitIds);
  const recentOverlap = items.filter(i => i.id && recentSet.has(i.id)).length;
  score *= Math.pow(0.3, recentOverlap);

  return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// Outfit generation (combinatorial)
// ---------------------------------------------------------------------------

/**
 * Generates candidate outfits from the catalog.
 * Tries all valid top+bottom+optional footwear/outerwear combinations.
 * Caps at maxCandidates to keep it fast.
 */
function generateCandidates(catalog, { maxCandidates = 200 } = {}) {
  const tops      = catalog.filter(i => getCategory(i.type) === 'top');
  const bottoms   = catalog.filter(i => getCategory(i.type) === 'bottom');
  const dresses   = catalog.filter(i => getCategory(i.type) === 'dress');
  const footwear  = catalog.filter(i => getCategory(i.type) === 'footwear');
  const outerwear = catalog.filter(i => getCategory(i.type) === 'outerwear');

  const candidates = [];

  // Top + bottom combinations
  for (const top of tops) {
    for (const bottom of bottoms) {
      candidates.push([top, bottom]);
      // Add footwear if available
      for (const shoe of footwear) {
        candidates.push([top, bottom, shoe]);
        // Add outerwear
        for (const outer of outerwear) {
          candidates.push([top, bottom, shoe, outer]);
          if (candidates.length >= maxCandidates) break;
        }
        if (candidates.length >= maxCandidates) break;
      }
      if (candidates.length >= maxCandidates) break;
    }
    if (candidates.length >= maxCandidates) break;
  }

  // Dress combinations
  for (const dress of dresses) {
    candidates.push([dress]);
    for (const shoe of footwear) {
      candidates.push([dress, shoe]);
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generates ranked outfit suggestions.
 *
 * @param {Object} params
 * @param {Array}  params.catalog          Full wardrobe catalog from Supabase
 * @param {string} [params.mood]           e.g. "relaxed", "professional"
 * @param {string} [params.plans]          e.g. "office meeting then dinner"
 * @param {Array}  [params.recentOutfitIds] IDs of items worn recently (from Person 3's calendar)
 * @param {Object} [params.userProfile]    { bodyType, preferredFormality }
 * @param {number} [params.topN]           How many suggestions to return (default 3)
 * @param {boolean} [params.withRationale] Call Reka to generate a natural-language reason (default true)
 *
 * @returns {Promise<Array<{items: Array, score: number, rationale?: string}>>}
 */
export async function suggestOutfits({
  catalog,
  mood = '',
  plans = '',
  recentOutfitIds = [],
  userProfile = {},
  topN = 3,
  withRationale = true
}) {
  // 1. Get weather
  const weatherCtx = await getWeatherContext();
  console.log(`[outfitEngine] Weather: ${weatherCtx.label}`);

  // 2. Infer target formality from mood + plans
  const targetFormality = userProfile.preferredFormality || inferTargetFormality(mood, plans);
  console.log(`[outfitEngine] Target formality: ${targetFormality}`);

  // 3. Filter catalog for weather-appropriate items
  const suitableItems = catalog.filter(i => isWeatherAppropriate(i, weatherCtx));
  if (suitableItems.length < 2) {
    throw new Error('Not enough suitable items in catalog for current weather.');
  }

  // 4. Generate and score candidates
  const candidates = generateCandidates(suitableItems);
  console.log(`[outfitEngine] Scoring ${candidates.length} outfit candidates...`);

  const scored = candidates
    .map(items => ({
      items,
      score: scoreOutfit(items, { targetFormality, weatherCtx, recentOutfitIds })
    }))
    .filter(o => o.score > 0.1)
    .sort((a, b) => b.score - a.score);

  // 5. De-duplicate results (ensure different top picks don't share main items)
  const results = [];
  const usedItemIds = new Set();

  for (const outfit of scored) {
    if (results.length >= topN) break;
    const ids = outfit.items.map(i => i.id).filter(Boolean);
    const overlap = ids.filter(id => usedItemIds.has(id)).length;
    if (overlap <= 1) { // allow max 1 shared item between suggestions
      results.push(outfit);
      ids.forEach(id => usedItemIds.add(id));
    }
  }

  // 6. Optionally generate Reka rationale for each outfit
  if (withRationale && results.length > 0) {
    console.log('[outfitEngine] Generating rationales via Reka...');
    for (const outfit of results) {
      try {
        const itemList = outfit.items.map(i => `${i.colour} ${i.type}`).join(', ');
        const { reply } = await chat({
          userMessage: `In one sentence, explain why "${itemList}" works as an outfit for someone with mood "${mood || 'casual'}" and plans "${plans || 'a regular day'}" in ${weatherCtx.label} weather.`,
          history: [],
          catalog,
          userProfile,
          weatherContext: weatherCtx
        });
        outfit.rationale = reply;
      } catch {
        outfit.rationale = null;
      }
    }
  }

  return results.map(o => ({
    items: o.items,
    score: Math.round(o.score * 100) / 100,
    rationale: o.rationale ?? null,
    weatherContext: {
      label: weatherCtx.label,
      tempC: weatherCtx.tempC
    }
  }));
}
