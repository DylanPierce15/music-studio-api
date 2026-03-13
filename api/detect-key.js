// api/detect-key.js
// Drop this in your api/ folder alongside detect-bpm.js
//
// MONOREPO TODO: Replace multipart branch with R2 URL-only path.
// Worker reads directly from R2 (no size limits, no timeout issues).

import formidable from "formidable";
import { readFileSync } from "fs";
import audioDecode from "audio-decode";

export const config = {
  api: {
    bodyParser: false, // required for formidable
  },
};

// ---------------------------------------------------------------------------
// Krumhansl-Schmuckler key-finding algorithm
// Correlates the pitch class profile of the audio against major/minor profiles
// Reference: Krumhansl (1990) "Cognitive Foundations of Musical Pitch"
// ---------------------------------------------------------------------------

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function correlation(a, b) {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  return num / Math.sqrt(denomA * denomB);
}

function buildPitchClassProfile(audioBuffer) {
  // Use the first channel only
  const samples = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // Analyze in 4096-sample windows with 50% overlap
  const windowSize = 4096;
  const hop = windowSize / 2;
  const pcp = new Float32Array(12).fill(0);

  for (let start = 0; start + windowSize <= samples.length; start += hop) {
    // Apply Hann window
    const windowed = new Float32Array(windowSize);
    for (let i = 0; i < windowSize; i++) {
      windowed[i] = samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowSize - 1)));
    }

    // Simple DFT magnitude for musical frequency bins
    // Map each semitone across 4 octaves (MIDI 48–95: C3–B6) to a pitch class
    for (let midi = 48; midi < 96; midi++) {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const bin = Math.round((freq * windowSize) / sampleRate);
      if (bin < 1 || bin >= windowSize / 2) continue;

      // Goertzel algorithm for a single frequency — cheaper than full DFT
      const omega = (2 * Math.PI * bin) / windowSize;
      const coeff = 2 * Math.cos(omega);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < windowSize; i++) {
        s0 = windowed[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = s2 * s2 + s1 * s1 - coeff * s1 * s2;
      pcp[midi % 12] += power;
    }
  }

  // Normalize
  const max = Math.max(...pcp);
  if (max > 0) for (let i = 0; i < 12; i++) pcp[i] /= max;

  return Array.from(pcp);
}

function detectKey(pcp) {
  let bestScore = -Infinity;
  let bestKey = "C";
  let bestScale = "major";
  const scores = [];

  for (let root = 0; root < 12; root++) {
    // Rotate PCP so this root is at index 0
    const rotated = [...pcp.slice(root), ...pcp.slice(0, root)];

    const majorScore = correlation(rotated, MAJOR_PROFILE);
    const minorScore = correlation(rotated, MINOR_PROFILE);

    scores.push({ key: NOTE_NAMES[root], scale: "major", score: majorScore });
    scores.push({ key: NOTE_NAMES[root], scale: "minor", score: minorScore });

    if (majorScore > bestScore) { bestScore = majorScore; bestKey = NOTE_NAMES[root]; bestScale = "major"; }
    if (minorScore > bestScore) { bestScore = minorScore; bestKey = NOTE_NAMES[root]; bestScale = "minor"; }
  }

  // Sort for alternates
  scores.sort((a, b) => b.score - a.score);

  // Confidence: gap between top and second score, normalized to 0-100
  const confidence = Math.min(100, Math.round(((scores[0].score - scores[1].score) / (1 - scores[1].score)) * 100));

  // Top 3 alternates (excluding winner)
  const alternates = scores
    .slice(1, 4)
    .map(s => `${s.key} ${s.scale}`);

  return { key: bestKey, scale: bestScale, confidence, alternates };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.json({ status: "detect-key endpoint is running", usage: "POST with audio file (multipart/form-data) or { audioUrl } JSON body" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    let audioBuffer;
    const contentType = req.headers["content-type"] || "";

    if (contentType.includes("multipart/form-data")) {
      // --- Path A: direct file upload ---
      const form = formidable({ maxFileSize: 20 * 1024 * 1024 }); // 20MB limit
      const [, files] = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve([fields, files]);
        });
      });

      const file = Array.isArray(files.audio) ? files.audio[0] : files.audio;
      if (!file) return res.status(400).json({ error: "No audio file found. Send file as field name 'audio'" });

      const fileBuffer = readFileSync(file.filepath);
      audioBuffer = await audioDecode(fileBuffer);

    } else {
      // --- Path B: JSON body with audioUrl ---
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (!body.audioUrl) {
        return res.status(400).json({ error: "Provide either a multipart audio file or JSON { audioUrl }" });
      }

      const response = await fetch(body.audioUrl);
      if (!response.ok) throw new Error(`Failed to fetch audio from URL: ${response.statusText}`);

      const arrayBuffer = await response.arrayBuffer();
      audioBuffer = await audioDecode(Buffer.from(arrayBuffer));
    }

    // Analyze
    const pcp = buildPitchClassProfile(audioBuffer);
    const { key, scale, confidence, alternates } = detectKey(pcp);

    return res.json({
      key,
      scale,
      keyString: `${key} ${scale}`,    // e.g. "A minor"
      confidence,                        // 0-100
      alternates,                        // e.g. ["C major", "E minor", "G major"]
      durationSeconds: Math.round(audioBuffer.duration),
      sampleRate: audioBuffer.sampleRate,
    });

  } catch (err) {
    console.error("detect-key error:", err);
    return res.status(500).json({ error: err.message });
  }
}