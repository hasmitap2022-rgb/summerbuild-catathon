const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
const { runSweep } = require('../reka/sweep')
const Item = require('../models/item')

const router = express.Router()

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.webm', '.mkv']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) cb(null, true)
    else cb(new Error(`Unsupported file type: ${ext}`))
  }
})

// POST /api/sweep
// Body: multipart/form-data — fields: video (file), userId (string)
router.post('/sweep', upload.single('video'), async (req, res) => {
  const videoPath = req.file?.path
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' })

    const userId = req.body.userId
    if (!userId) return res.status(400).json({ error: 'userId is required.' })

    const { items, frameCount, durationSeconds } = await runSweep(videoPath)

    if (items.length === 0) {
      return res.json({ success: true, catalogItems: [], frameCount, durationSeconds })
    }

    // Save each item to MongoDB
    const docs = items.map(item => ({
      itemId: uuidv4(),
      itemName: `${item.colour} ${item.type}`,
      userId,
      type: item.type,
      colour: item.colour,
      pattern: item.pattern,
      formality: item.formality,
      occurrences: item.occurrences,
      wearCount: 0
    }))

    const inserted = await Item.insertMany(docs)

    res.json({ success: true, catalogItems: inserted, frameCount, durationSeconds })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath)
  }
})

// GET /api/sweep/catalog?userId=xxx
router.get('/sweep/catalog', async (req, res) => {
  try {
    const { userId } = req.query
    if (!userId) return res.status(400).json({ error: 'userId is required.' })

    const catalog = await Item.find({ userId }).sort({ wearCount: 1 })
    res.json({ success: true, catalog })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
