import MusicTempo from 'music-tempo'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { audioUrl } = req.body

  if (!audioUrl) {
    return res.status(400).json({ error: 'No audioUrl provided' })
  }

  try {
    // Fetch the audio file from R2
    const response = await fetch(audioUrl)
    const buffer = await response.arrayBuffer()
    const audioData = new Float32Array(buffer)

    const mt = new MusicTempo(audioData)

    res.json({
      bpm: Math.round(mt.tempo),
      confidence: mt.beats.length,
    })
  } catch (e) {
    res.status(500).json({ error: 'BPM detection failed', detail: e.message })
  }
}