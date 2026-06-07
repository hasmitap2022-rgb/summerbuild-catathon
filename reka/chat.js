/**
 * reka/chat.js
 * Natural-language wardrobe chat powered by Reka LLM.
 *
 * Person 1 owns this file (Vib).
 *
 * Handles three core query types:
 *   1. "What haven't I worn in a while?"
 *   2. "Suggest an outfit for [occasion/weather/mood]"
 *   3. "What matches [specific item]?"
 *
 * The full wardrobe catalog is passed in as context on every request.
 * Conversation history is maintained by the caller and passed in each time
 * (Reka has no session memory — we manage it).
 */

import axios from 'axios';

const REKA_API_KEY = process.env.REKA_API_KEY;
const REKA_CHAT_URL = 'https://api.reka.ai/v1/chat';

// ---------------------------------------------------------------------------
// System prompt — injected on every request
// ---------------------------------------------------------------------------

/**
 * Builds the system prompt with the live wardrobe catalog injected.
 * @param {Array<Object>} catalog  Array of wardrobe items from the database
 * @param {Object} [userProfile]   Optional: { bodyType, preferredFormality }
 * @returns {string}
 */
function buildSystemPrompt(catalog, userProfile = {}) {
  const catalogJson = JSON.stringify(catalog, null, 2);
  const profileNote = userProfile.bodyType
    ? `The user's body type is: ${userProfile.bodyType}.`
    : '';
  const formalityNote = userProfile.preferredFormality
    ? `Their preferred formality level is: ${userProfile.preferredFormality}.`
    : '';

  return `You are ClosetOS, a personal wardrobe assistant. You are helpful, concise, and stylish.

You have full knowledge of the user's wardrobe. Here is their current catalog:
${catalogJson}

Each item has: type, colour, pattern, formality, occurrences (how many times seen in their sweep video), and wearCount (how many times they've actually worn it, tracked by the app).

${profileNote} ${formalityNote}

Rules:
- Only suggest outfits using items from the catalog above. Never make up items.
- When suggesting outfits, name items specifically (e.g. "your white solid t-shirt" not "a white shirt").
- For "unworn" queries, focus on items where wearCount is 0 or very low.
- For outfit matching, consider colour harmony, pattern mixing rules, and formality consistency.
- Keep responses short and practical. Use bullet points for outfit suggestions.
- If the user asks something unrelated to clothing or their wardrobe, politely redirect.`;
}

// ---------------------------------------------------------------------------
// Intent detection (lightweight, no extra API call needed)
// ---------------------------------------------------------------------------

const INTENT_PATTERNS = {
  unworn: /haven't worn|not worn|forgotten|least worn|neglected|ignored/i,
  outfit: /outfit|wear|suggest|recommend|what should|what can i wear|dress/i,
  matching: /match|go with|pair with|combine|what goes|coordinates/i,
  general: /.*/  // fallback
};

/**
 * Detects the rough intent of a user message.
 * @param {string} message
 * @returns {'unworn'|'outfit'|'matching'|'general'}
 */
export function detectIntent(message) {
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(message)) return intent;
  }
  return 'general';
}

// ---------------------------------------------------------------------------
// Core chat function
// ---------------------------------------------------------------------------

/**
 * Sends a message to the Reka LLM with full wardrobe context.
 *
 * @param {Object} params
 * @param {string}   params.userMessage       The user's latest message
 * @param {Array}    params.history           Prior conversation turns: [{role, content}]
 * @param {Array}    params.catalog           Full wardrobe catalog from Supabase
 * @param {Object}   [params.userProfile]     Optional user profile data
 * @param {Object}   [params.weatherContext]  Optional: { forecast, tempC } from NEA
 *
 * @returns {Promise<{reply: string, intent: string, updatedHistory: Array}>}
 */
export async function chat({ userMessage, history = [], catalog, userProfile = {}, weatherContext = null }) {
  const intent = detectIntent(userMessage);

  // Augment the user message with weather context if available and relevant
  let augmentedMessage = userMessage;
  if (weatherContext && intent === 'outfit') {
    augmentedMessage = `${userMessage}\n\n[Current Singapore weather: ${weatherContext.forecast}, ${weatherContext.tempC}°C. Factor this into your suggestion.]`;
  }

  const systemPrompt = buildSystemPrompt(catalog, userProfile);

  // Build the messages array: system prompt + history + new user message
  const messages = [
    ...history,
    { role: 'user', content: augmentedMessage }
  ];

  const payload = {
    model: 'reka-core',
    system_prompt: systemPrompt,
    messages,
    temperature: 0.7,     // Slight creativity for outfit suggestions
    max_tokens: 600       // Keep responses concise
  };

  const response = await axios.post(REKA_CHAT_URL, payload, {
    headers: {
      'X-Api-Key': REKA_API_KEY,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });

  const reply = response.data?.responses?.[0]?.message?.content
    ?? response.data?.choices?.[0]?.message?.content
    ?? 'Sorry, I could not generate a response.';

  // Return updated history so the caller can persist it in session/DB
  const updatedHistory = [
    ...history,
    { role: 'user', content: augmentedMessage },
    { role: 'assistant', content: reply }
  ];

  return { reply, intent, updatedHistory };
}

// ---------------------------------------------------------------------------
// Convenience wrappers for the three core query types
// (These just call chat() with pre-seeded messages for a better first response)
// ---------------------------------------------------------------------------

/**
 * Asks about unworn/forgotten items specifically.
 * Useful for a "Rediscover your wardrobe" button on the frontend.
 */
export async function askAboutUnwornItems(catalog, userProfile = {}) {
  return chat({
    userMessage: "Which items in my wardrobe haven't I worn recently? Give me a short list and a reason to try each one.",
    history: [],
    catalog,
    userProfile
  });
}

/**
 * Asks for a daily outfit suggestion given context.
 * @param {Object} context  { mood, plans, weatherContext, catalog, userProfile }
 */
export async function suggestOutfit({ mood, plans, weatherContext, catalog, userProfile }) {
  const message = [
    `Suggest a complete outfit for today.`,
    mood ? `My mood is: ${mood}.` : '',
    plans ? `My plans are: ${plans}.` : '',
  ].filter(Boolean).join(' ');

  return chat({ userMessage: message, history: [], catalog, userProfile, weatherContext });
}
