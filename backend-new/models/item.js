const itemSchema = new mongoose.Schema({
  itemId: String,
  itemName: String,
  price: Number,
  wearCount: { type: Number, default: 0 },
  // ADD THESE ↓
  type: String,
  colour: String,
  pattern: String,
  formality: String,
  occurrences: { type: Number, default: 1 }
})
