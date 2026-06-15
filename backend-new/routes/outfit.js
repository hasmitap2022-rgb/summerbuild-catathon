const express = require('express')
const { suggestOutfits } = require('../backend/outfitEngine')
const { chat } = require('../reka/chat')
const { getWeatherContext } = require('../backend/weather')
const Item = require('../models/item')
const Wear = require('../models/wear')

const router = express.Router()

// Helper: fetch catalog from MongoDB
async function fetchCatalog(userId) {
  return await Item.find({ userId })
}

// Helper: fetch item IDs worn in the last 7 days
async function fetchRecentItemIds(userId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const recent = await Wear.find({ userId, wornOn: { $gte: since } })
  return [...new Set(recent.map(w => w.itemId))]
}

// POST /api/outfit/suggest
// Body: { userId, mood?, plans? }
router.post('/suggest', async (req, res) => {
  try {
    const { userId, mood, plans } = req.body
    if (!userId) return res.status(400).json({ error: 'userId is required.' })

    const [catalog, recentOutfitIds] = await Promise.all([
      fetchCatalog(userId),
      fetchRecentItemIds(userId)
    ])

    if (catalog.length < 2) {
      return res.json({ success: true, suggestions: [], message: 'Complete a video sweep first.' })
    }

    const suggestions = await suggestOutfits({
      catalog,
      mood,
      plans,
      recentOutfitIds,
      topN: 3,
      withRationale: true
    })

    res.json({ success: true, suggestions })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/outfit/chat
// Body: { userId, message, history[] }
router.post('/chat', async (req, res) => {
  try {
    const { userId, message, history = [] } = req.body
    if (!userId || !message) return res.status(400).json({ error: 'userId and message are required.' })

    const [catalog, weatherContext] = await Promise.all([
      fetchCatalog(userId),
      getWeatherContext()
    ])

    const { reply, intent, updatedHistory } = await chat({
      userMessage: message,
      history: history.slice(-20),
      catalog,
      weatherContext
    })

    res.json({ success: true, reply, intent, updatedHistory })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/outfit/weather
router.get('/weather', async (req, res) => {
  try {
    const weather = await getWeatherContext()
    res.json({ success: true, weather })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
