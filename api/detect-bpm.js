import multer from 'multer'
import MusicTempo from 'music-tempo'

const upload = multer({ storage: multer.memoryStorage() })

export const config = {
  api: {
    bodyParser: false,
  },
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  upload.single('audio')(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' })

    try {
      // Convert buffer to float32 array for music-tempo
      const audioData = new Float32Array(req.file.buffer)
      const mt = new MusicTempo(audioData)

      res.json({
        bpm: Math.round(mt.tempo),
        confidence: mt.beats.length,
      })
    } catch (e) {
      res.status(500).json({ error: 'BPM detection failed', detail: e.message })
    }
  })
}