const OpenAI = require('openai')

const reka = new OpenAI({
  apiKey: process.env.REKA_API_KEY,
  baseURL: 'https://api.reka.ai/v1'
})

async function generatePackingList({ destination, duration, occasions, catalog }) {
  const catalogSummary = catalog.map(item =>
    `- ${item.itemId}: ${item.colour} ${item.type} (${item.formality})`
  ).join('\n')

  const prompt = `
You are a smart wardrobe assistant. A user is travelling to ${destination} for ${duration} days.
Their occasions include: ${occasions.join(', ')}.

Here is their wardrobe catalog:
${catalogSummary}

Select the best items from the catalog that:
1. Cover all occasions
2. Mix and match well together
3. Are not too many items (aim for ${Math.ceil(duration * 1.5)} items max)

Return ONLY a JSON array of itemIds like this: ["001", "002", "003"]
`

  const response = await reka.chat.completions.create({
    model: 'reka-flash',
    messages: [{ role: 'user', content: prompt }]
  })

  const raw = response.choices[0].message.content
  const itemIds = JSON.parse(raw.replace(/```json|```/g, '').trim())

  const selectedItems = catalog.filter(item => itemIds.includes(item.itemId))

  return {
    destination,
    duration,
    occasions,
    packingList: selectedItems
  }
}

module.exports = { generatePackingList }
