require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const multer = require('multer')
const { analyseItem } = require('./shoppingGuard')
const { generatePackingList } = require('./packingList')
const Wear = require('./models/wear')
const Item = require('./models/item')
const User = require('./models/user')
const sweepRouter = require('./routes/sweep')
const outfitRouter = require('./routes/outfit')

const app = express()
app.use(express.json())
app.use('/api', sweepRouter)
app.use('/api/outfit', outfitRouter)

mongoose.connect(process.env.DB_CONNECTION)
  .then(() => console.log('Connected to MongoDB!'))
  .catch((err) => console.log('MongoDB connection error:', err))

app.post('/api/wear', async (req, res) => {
  const wear = new Wear({ itemId: req.body.itemId, itemName: req.body.itemName })
  await wear.save()
  res.json({ message: 'Wear logged!', wear })
})

app.get('/api/forgotten', async (req, res) => {
  const sixtyDaysAgo = new Date()
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)
  const forgotten = await Wear.find({ wornOn: { $lt: sixtyDaysAgo } })
  res.json(forgotten)
})

app.post('/api/item', async (req, res) => {
  const item = new Item({ itemId: req.body.itemId, itemName: req.body.itemName, price: req.body.price })
  await item.save()
  res.json({ message: 'Item added!', item })
})

app.get('/api/costperwear/:itemId', async (req, res) => {
  const item = await Item.findOne({ itemId: req.params.itemId })
  if (!item) return res.json({ message: 'Item not found' })
  const wears = await Wear.countDocuments({ itemId: req.params.itemId })
  const costPerWear = wears === 0 ? item.price : (item.price / wears).toFixed(2)
  res.json({ itemName: item.itemName, price: item.price, wearCount: wears, costPerWear })
})

app.post('/api/user', async (req, res) => {
  const user = new User({ userId: req.body.userId, name: req.body.name, bodyType: req.body.bodyType, height: req.body.height, weight: req.body.weight })
  await user.save()
  res.json({ message: 'User saved!', user })
})

app.get('/api/user/:userId', async (req, res) => {
  const user = await User.findOne({ userId: req.params.userId })
  if (!user) return res.json({ message: 'User not found' })
  res.json(user)
})

const upload = multer({ dest: 'uploads/' })
app.post('/api/shopping-guard', upload.single('image'), async (req, res) => {
  try {
    const catalog = JSON.parse(req.body.catalog || '[]')
    const userBodyType = req.body.bodyType || 'unknown'
    const result = await analyseItem(req.file.path, catalog, userBodyType)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/packing-list', async (req, res) => {
  try {
    const { destination, duration, occasions, catalog } = req.body
    const result = await generatePackingList({ destination, duration, occasions, catalog })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/', (req, res) => {
  res.send('Closetos backend is running!')
})

const PORT = 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
