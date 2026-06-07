/**
 * backend/weather.js
 * NEA (National Environment Agency) Singapore weather integration.
 *
 * Person 1 owns this file (Vib).
 *
 * Uses the free NEA Data.gov.sg APIs — no API key required.
 * Docs: https://data.gov.sg/datasets/d_1efe4728b2dad26fd7729c5e4eff7802/view
 *
 * Exports:
 *   getWeatherContext() → { forecast, tempC, humidity, isRainy, isHot }
 *
 * The outfit engine and chat module both consume this.
 */

import axios from 'axios';

// NEA free endpoints (no auth)
const NEA_2H_FORECAST_URL   = 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast';
const NEA_24H_FORECAST_URL  = 'https://api-open.data.gov.sg/v2/real-time/api/twenty-four-hr-forecast';
const NEA_TEMPERATURE_URL   = 'https://api-open.data.gov.sg/v2/real-time/api/air-temperature';
const NEA_HUMIDITY_URL      = 'https://api-open.data.gov.sg/v2/real-time/api/relative-humidity';

// We default to a central Singapore location when we can't detect the user's exact area
const DEFAULT_AREA = 'Bishan';

// Cache weather for 15 minutes to avoid hammering the API on every request
let weatherCache = null;
let cacheExpiry  = 0;
const CACHE_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeFetch(url) {
  try {
    const response = await axios.get(url, { timeout: 8000 });
    return response.data;
  } catch (err) {
    console.warn(`[weather] Failed to fetch ${url}:`, err.message);
    return null;
  }
}

/**
 * Finds the forecast for the closest NEA area to our default.
 */
function extractForecast(data, areaName = DEFAULT_AREA) {
  try {
    const periods = data?.data?.items?.[0]?.forecasts;
    if (!periods) return null;

    // Try to find our target area, fall back to first available
    const match = periods.find(p =>
      p.area?.toLowerCase().includes(areaName.toLowerCase())
    ) ?? periods[0];

    return match?.forecast ?? null;
  } catch {
    return null;
  }
}

function extractTemperature(data) {
  try {
    const readings = data?.data?.readings?.[0]?.data;
    if (!readings?.length) return null;
    const values = readings.map(r => r.value).filter(v => typeof v === 'number');
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.round(avg * 10) / 10; // one decimal place
  } catch {
    return null;
  }
}

function extractHumidity(data) {
  try {
    const readings = data?.data?.readings?.[0]?.data;
    if (!readings?.length) return null;
    const values = readings.map(r => r.value).filter(v => typeof v === 'number');
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.round(avg);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classify weather into outfit-relevant flags
// ---------------------------------------------------------------------------

const RAINY_KEYWORDS = ['rain', 'shower', 'thunder', 'drizzle', 'storm'];
const CLOUDY_KEYWORDS = ['cloudy', 'overcast', 'hazy'];

function classifyWeather(forecast = '', tempC = 30, humidity = 80) {
  const f = forecast.toLowerCase();
  const isRainy  = RAINY_KEYWORDS.some(k => f.includes(k));
  const isCloudy = CLOUDY_KEYWORDS.some(k => f.includes(k));
  const isHot    = tempC >= 32;
  const isHumid  = humidity >= 80;

  // Outfit engine readable label
  let label = 'warm and sunny';
  if (isRainy)       label = 'rainy';
  else if (isHot && isHumid) label = 'hot and humid';
  else if (isHot)    label = 'hot';
  else if (isCloudy) label = 'cloudy and mild';

  return { isRainy, isCloudy, isHot, isHumid, label };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns current Singapore weather context for use in outfit suggestions.
 *
 * @returns {Promise<{
 *   forecast: string,       Raw NEA forecast string
 *   tempC: number,          Current temperature in Celsius
 *   humidity: number,       Relative humidity %
 *   isRainy: boolean,
 *   isHot: boolean,
 *   isHumid: boolean,
 *   label: string           Human-readable label: "hot and humid", "rainy", etc.
 * }>}
 */
export async function getWeatherContext() {
  const now = Date.now();

  // Return cached result if still fresh
  if (weatherCache && now < cacheExpiry) {
    console.log('[weather] Returning cached weather');
    return weatherCache;
  }

  console.log('[weather] Fetching fresh weather data from NEA...');

  // Fire all requests in parallel
  const [forecastData, tempData, humidityData] = await Promise.all([
    safeFetch(NEA_2H_FORECAST_URL),
    safeFetch(NEA_TEMPERATURE_URL),
    safeFetch(NEA_HUMIDITY_URL)
  ]);

  const forecast  = extractForecast(forecastData) ?? 'Partly cloudy';
  const tempC     = extractTemperature(tempData) ?? 30;    // Singapore average fallback
  const humidity  = extractHumidity(humidityData) ?? 80;

  const classification = classifyWeather(forecast, tempC, humidity);

  const context = {
    forecast,
    tempC,
    humidity,
    ...classification
  };

  // Cache it
  weatherCache = context;
  cacheExpiry  = now + CACHE_TTL_MS;

  console.log(`[weather] forecast="${forecast}" temp=${tempC}°C humidity=${humidity}% label="${classification.label}"`);
  return context;
}

/**
 * Returns a plain English string suitable for passing to the LLM.
 * e.g. "Rainy, 28°C, 88% humidity"
 */
export async function getWeatherString() {
  const ctx = await getWeatherContext();
  return `${ctx.forecast}, ${ctx.tempC}°C, ${ctx.humidity}% humidity`;
}
