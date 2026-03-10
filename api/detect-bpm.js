import multer from 'multer'

const upload = multer({ storage: multer.memoryStorage() })

export const config = {
  api: {
    bodyParser: false, // required for multer to work
  },
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  upload.single('audio')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' })

    res.json({
      bpm: 120,
      message: 'BPM detection coming soon'
    })
  })
}