import MusicTempo from 'music-tempo'
import audioDecode from 'audio-decode'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { audioUrl } = req.body

  if (!audioUrl) {
    return res.status(400).json({ error: 'No audioUrl provided' })
  }

  try {
    // Fetch the audio file
    const response = await fetch(audioUrl)
    const arrayBuffer = await response.arrayBuffer()

    // Decode MP3 into raw audio samples
    const audioBuffer = await audioDecode(arrayBuffer)

    // Get the first channel's float32 data
    const audioData = audioBuffer.getChannelData(0)

    const mt = new MusicTempo(audioData)

    res.json({
      bpm: Math.round(mt.tempo),
      beatsDetected: mt.beats.length,
    })
  } catch (e) {
    res.status(500).json({ error: 'BPM detection failed', detail: e.message })
  }
}