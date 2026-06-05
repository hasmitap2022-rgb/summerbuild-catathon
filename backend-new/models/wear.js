const mongoose = require('mongoose')

const wearSchema = new mongoose.Schema({
  itemId: String,
  itemName: String,
  wornOn: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Wear', wearSchema)
