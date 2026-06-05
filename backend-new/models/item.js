const mongoose = require('mongoose')

const itemSchema = new mongoose.Schema({
  itemId: String,
  itemName: String,
  price: Number,
  wearCount: { type: Number, default: 0 }
})

module.exports = mongoose.model('Item', itemSchema)