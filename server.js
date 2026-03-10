const express = require('express')
const cors = require('cors')
const multer = require('multer')

const app = express()
const upload = multer({ storage: multer.memoryStorage() })

app.use(cors({ origin: '*' }))
app.use(express.json())

// Health check — confirms the server is running
app.get('/', (req, res) => {
  res.json({ status: 'Music Studio API is running' })
})

// BPM Detection placeholder
app.post('/api/detect-bpm', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }
  // placeholder — returns a mock BPM for now
  res.json({ 
    bpm: 120,
    message: 'BPM detection coming soon'
  })
})

// Transcode placeholder
app.post('/api/transcode', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }
  // placeholder — echoes back file info for now
  res.json({
    filename: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
    message: 'Transcoding coming soon'
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})