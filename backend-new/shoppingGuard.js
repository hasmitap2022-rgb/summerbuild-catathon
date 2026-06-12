const OpenAI = require('openai')
const fs = require('fs')

const reka = new OpenAI({
  apiKey: process.env.REKA_API_KEY,
  baseURL: 'https://api.reka.ai/v1'
})

async function analyseItem(imagePath, catalog, userBodyType) {
  // Read image and convert to base64
  const imageData = fs.readFileSync(imagePath)
  const base64Image = imageData.toString('base64')

  // Step 1: Send image to Reka Vision to extract item details
  const response = await reka.chat.completions.create({
    model: 'reka-flash',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64Image}` }
          },
          {
            type: 'text',
            text: 'Analyse this clothing item. Return ONLY a JSON object with these fields: { "type": "...", "colour": "...", "pattern": "...", "formality": "casual/smart-casual/business/formal/activewear" }'
          }
        ]
      }
    ]
  })

  // Parse Reka's response
  const raw = response.choices[0].message.content
  const extracted = JSON.parse(raw.replace(/```json|```/g, '').trim())

  // Step 2: Compare against catalog
  const similar = catalog.filter(item =>
    item.type?.toLowerCase() === extracted.type?.toLowerCase() ||
    item.colour?.toLowerCase() === extracted.colour?.toLowerCase()
  )

  const pairs = catalog.filter(item =>
    item.formality?.toLowerCase() === extracted.formality?.toLowerCase() &&
    item.type?.toLowerCase() !== extracted.type?.toLowerCase()
  )

  // Step 3: Build verdict
  const verdict = similar.length >= 2
    ? `You already own ${similar.length} similar items!`
    : `You own ${similar.length} similar item(s). This could be a good addition.`

  return {
    extracted,
    similarItems: similar,
    pairingItems: pairs.slice(0, 3),
    verdict,
    bodyType: userBodyType
  }
}

module.exports = { analyseItem }
