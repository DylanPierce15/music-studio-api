/**
 * transcode.js
 *
 * Converts an uploaded audio file to a normalized, compressed MP3.
 *
 * PROTOTYPE (current) — runs on Vercel serverless using @ffmpeg/ffmpeg
 * (FFmpeg compiled to WebAssembly). Works but has constraints:
 *   - ~30MB cold start overhead
 *   - 4.5MB request body limit on Vercel free tier
 *   - 10 second function timeout on Vercel free tier
 *   - May fail on large files or complex audio
 *
 * MONOREPO (production) — runs on Cloudflare Workers with system FFmpeg
 * available via a Workers binding or a sidecar process. Differences:
 *   - Replace @ffmpeg/ffmpeg with a direct FFmpeg system call (child_process.spawn)
 *   - Remove the WebAssembly loading step entirely
 *   - File comes from R2 directly instead of the request body
 *   - No size or timeout constraints
 *   - See MONOREPO TODO comments throughout this file
 */

import formidable from 'formidable'
import fs from 'fs'
import path from 'path'
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg'

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

export const config = {
  api: {
    // Required for multipart/form-data file uploads
    // MONOREPO TODO: Remove this — in the monorepo the file comes
    // from R2 via a URL, not from the request body
    bodyParser: false,
  },
}

// ─────────────────────────────────────────────────────────────
// FFmpeg setup
//
// PROTOTYPE: Load FFmpeg WebAssembly bundle at runtime.
// This is the slow part — ~30MB download on first cold start.
//
// MONOREPO TODO: Remove this entirely. Replace all ffmpeg.run()
// calls below with direct system FFmpeg invocation:
//
//   import { execFile } from 'child_process'
//   execFile('ffmpeg', ['-i', inputPath, ...args, outputPath])
//
// ─────────────────────────────────────────────────────────────

const ffmpeg = createFFmpeg({
  log: false, // set to true for debugging
  corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
})

// ─────────────────────────────────────────────────────────────
// Target output settings
//
// These settings stay the same in the monorepo —
// only how FFmpeg is invoked changes, not what it produces.
// ─────────────────────────────────────────────────────────────

const OUTPUT_FORMAT = 'mp3'
const OUTPUT_BITRATE = '192k'       // good quality / size balance
const OUTPUT_SAMPLE_RATE = '44100'  // standard for web audio
const OUTPUT_CHANNELS = '2'         // stereo
const TARGET_LUFS = '-14'           // streaming standard (Spotify, Apple Music)

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    let inputBuffer
    let originalFilename = 'audio'

    const contentType = req.headers['content-type'] ?? ''

    if (contentType.includes('multipart/form-data')) {
      // ── PROTOTYPE: Accept file directly from request body ──
      //
      // MONOREPO TODO: Replace this entire block with:
      //
      //   const { audioUrl } = req.body
      //   const response = await fetch(audioUrl) // fetch from R2
      //   inputBuffer = Buffer.from(await response.arrayBuffer())
      //
      // In the monorepo the widget uploads to R2 first via useR2Files,
      // then passes the public URL here. No file upload in the request.

      const form = formidable({
        maxFileSize: 10 * 1024 * 1024, // 10MB
        // MONOREPO TODO: Remove maxFileSize — R2 has no practical limit
      })

      const [, files] = await form.parse(req)
      const file = files.file?.[0]

      if (!file) {
        return res.status(400).json({ error: 'No file provided' })
      }

      inputBuffer = fs.readFileSync(file.filepath)
      originalFilename = path.parse(file.originalFilename ?? 'audio').name

    } else {
      // ── Fallback: JSON body with audioUrl ──
      // Accepts a public URL (e.g. from R2) and fetches the file.
      // This is closer to the monorepo pattern.
      //
      // MONOREPO TODO: This branch becomes the ONLY branch.
      // Remove the multipart/form-data block above entirely.

      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const { audioUrl, filename } = body

      if (!audioUrl) {
        return res.status(400).json({ error: 'No audioUrl or file provided' })
      }

      const response = await fetch(audioUrl)
      inputBuffer = Buffer.from(await response.arrayBuffer())
      originalFilename = filename
        ? path.parse(filename).name
        : 'audio'
    }

    // ─────────────────────────────────────────────────────────
    // Load FFmpeg WebAssembly
    //
    // PROTOTYPE: Must load the WASM bundle before use.
    // Cached after first load within the same function instance.
    //
    // MONOREPO TODO: Remove this — system FFmpeg is always available.
    // ─────────────────────────────────────────────────────────

    if (!ffmpeg.isLoaded()) {
      await ffmpeg.load()
    }

    // ─────────────────────────────────────────────────────────
    // Write input file to FFmpeg virtual filesystem
    //
    // PROTOTYPE: FFmpeg WASM uses an in-memory virtual filesystem.
    //
    // MONOREPO TODO: Write to a real temp path instead:
    //   const inputPath = `/tmp/${originalFilename}_input`
    //   const outputPath = `/tmp/${originalFilename}_output.mp3`
    //   fs.writeFileSync(inputPath, inputBuffer)
    // ─────────────────────────────────────────────────────────

    const inputFilename = `input_${originalFilename}`
    const outputFilename = `output_${originalFilename}.${OUTPUT_FORMAT}`

    ffmpeg.FS('writeFile', inputFilename, await fetchFile(inputBuffer))

    // ─────────────────────────────────────────────────────────
    // Run FFmpeg transcoding + normalization
    //
    // These arguments stay identical in the monorepo.
    // Only the invocation method changes.
    //
    // What each flag does:
    //   -i              input file
    //   -vn             strip any video stream (e.g. from MP4)
    //   -ar             sample rate (44100 Hz)
    //   -ac             channels (2 = stereo)
    //   -b:a            audio bitrate (192kbps)
    //   -af loudnorm    EBU R128 loudness normalization to -14 LUFS
    //                   standard for Spotify, Apple Music, YouTube
    //   -f              output format
    //
    // MONOREPO TODO: Replace ffmpeg.run() with:
    //   await execFileAsync('ffmpeg', [
    //     '-i', inputPath,
    //     '-vn',
    //     '-ar', OUTPUT_SAMPLE_RATE,
    //     '-ac', OUTPUT_CHANNELS,
    //     '-b:a', OUTPUT_BITRATE,
    //     '-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11`,
    //     '-f', OUTPUT_FORMAT,
    //     outputPath
    //   ])
    // ─────────────────────────────────────────────────────────

    await ffmpeg.run(
      '-i', inputFilename,
      '-vn',
      '-ar', OUTPUT_SAMPLE_RATE,
      '-ac', OUTPUT_CHANNELS,
      '-b:a', OUTPUT_BITRATE,
      '-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11`,
      '-f', OUTPUT_FORMAT,
      outputFilename,
    )

    // ─────────────────────────────────────────────────────────
    // Read output from FFmpeg virtual filesystem
    //
    // MONOREPO TODO: Replace with:
    //   const outputBuffer = fs.readFileSync(outputPath)
    //   fs.unlinkSync(inputPath)   // clean up temp files
    //   fs.unlinkSync(outputPath)
    // ─────────────────────────────────────────────────────────

    const outputData = ffmpeg.FS('readFile', outputFilename)
    const outputBuffer = Buffer.from(outputData)

    // Clean up virtual filesystem
    ffmpeg.FS('unlink', inputFilename)
    ffmpeg.FS('unlink', outputFilename)

    // ─────────────────────────────────────────────────────────
    // Return the transcoded file
    //
    // PROTOTYPE: Returns the MP3 as a binary response.
    // The widget receives it as a blob and uploads to R2.
    //
    // MONOREPO TODO: Upload directly to R2 from the Worker here
    // and return the public URL instead of the binary:
    //
    //   const r2Key = `transcoded/${originalFilename}.mp3`
    //   await env.R2.put(r2Key, outputBuffer, {
    //     httpMetadata: { contentType: 'audio/mpeg' }
    //   })
    //   const publicUrl = `${env.R2_PUBLIC_URL}/${r2Key}`
    //   return res.json({ url: publicUrl, size: outputBuffer.length })
    // ─────────────────────────────────────────────────────────

    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Disposition', `attachment; filename="${originalFilename}.mp3"`)
    res.setHeader('Content-Length', outputBuffer.length)
    res.send(outputBuffer)

  } catch (e) {
    // ─────────────────────────────────────────────────────────
    // Error handling
    //
    // Common prototype errors:
    //   - FFmpeg WASM timeout (file too large / complex)
    //   - Vercel 4.5MB payload limit exceeded
    //   - Unsupported input format
    //
    // MONOREPO TODO: Add structured error logging here
    // using the DeepSpace logging infrastructure.
    // ─────────────────────────────────────────────────────────

    console.error('Transcode error:', e)
    res.status(500).json({
      error: 'Transcoding failed',
      detail: e.message,
      // MONOREPO TODO: Remove detail from production response
      // to avoid leaking internal error messages to clients
    })
  }
}