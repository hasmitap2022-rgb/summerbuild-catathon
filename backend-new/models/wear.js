const mongoose = require('mongoose')

const wearSchema = new mongoose.Schema({
  userId: String,
  itemId: String,
  itemName: String,
  wornOn: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Wear', wearSchema)
