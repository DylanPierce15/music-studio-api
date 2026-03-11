import MusicTempo from 'music-tempo'
import audioDecode from 'audio-decode'
import formidable from 'formidable'
import fs from 'fs'

// Disable Next.js body parsing — required for multipart/form-data
export const config = {
  api: { bodyParser: false }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    let arrayBuffer

    const contentType = req.headers['content-type'] ?? ''

    if (contentType.includes('multipart/form-data')) {
      // File uploaded directly from the widget
      const form = formidable({ maxFileSize: 10 * 1024 * 1024 })
      const [, files] = await form.parse(req)
      const file = files.file?.[0]
      if (!file) return res.status(400).json({ error: 'No file provided' })
      const buffer = fs.readFileSync(file.filepath)
      arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)

    } else {
      // Fallback: JSON body with audioUrl (original behaviour)
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const { audioUrl } = body
      if (!audioUrl) return res.status(400).json({ error: 'No audioUrl or file provided' })
      const response = await fetch(audioUrl)
      arrayBuffer = await response.arrayBuffer()
    }

    // Decode and detect BPM — same as before
    const audioBuffer = await audioDecode(arrayBuffer)
    const audioData = audioBuffer.getChannelData(0)
    const mt = new MusicTempo(audioData)

    res.json({
      bpm: Math.round(mt.tempo),
      confidence: Math.min(mt.beats.length / 100, 1), // normalise to 0–1
      beatsDetected: mt.beats.length,
    })
  } catch (e) {
    res.status(500).json({ error: 'BPM detection failed', detail: e.message })
  }
}