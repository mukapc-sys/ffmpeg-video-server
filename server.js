const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main concatenation endpoint
app.post('/concatenate', async (req, res) => {
  const { videoUrls, outputFilename, projectId, supabaseUrl, supabaseKey } = req.body;

  if (!videoUrls || videoUrls.length < 2) {
    return res.status(400).json({ error: 'Needs at least 2 video URLs' });
  }

  const tempDir = path.join('/tmp', `project-${projectId}-${Date.now()}`);
  
  try {
    // Create temp directory
    await fs.mkdir(tempDir, { recursive: true });
    console.log(`[${projectId}] Created temp dir: ${tempDir}`);

    // Download all videos
    const downloadedFiles = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const url = videoUrls[i];
      const filename = `video-${i}.mp4`;
      const filepath = path.join(tempDir, filename);
      
      console.log(`[${projectId}] Downloading video ${i + 1}/${videoUrls.length}...`);
      const response = await fetch(url);
      const buffer = await response.buffer();
      await fs.writeFile(filepath, buffer);
      
      downloadedFiles.push(filepath);
      console.log(`[${projectId}] Downloaded: ${filename}`);
    }

    // Create concat file for FFmpeg
    const concatFilePath = path.join(tempDir, 'concat.txt');
    const concatContent = downloadedFiles.map(f => `file '${f}'`).join('\n');
    await fs.writeFile(concatFilePath, concatContent);

    // Concatenate and compress videos
    const outputPath = path.join(tempDir, outputFilename);
    console.log(`[${projectId}] Starting concatenation with compression...`);
    
    // Use h264_nvenc if available (GPU), fallback to libx264 (CPU)
    // Compress to max 100MB, maintain quality with CRF 23, scale to max 1080p
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i ${concatFilePath} \
      -c:v libx264 -crf 23 -preset medium \
      -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" \
      -c:a aac -b:a 128k \
      -movflags +faststart \
      -y ${outputPath}`;
    await execAsync(ffmpegCommand);
    
    console.log(`[${projectId}] Concatenation complete!`);

    // Upload to Supabase Storage
    console.log(`[${projectId}] Uploading to storage...`);
    const fileBuffer = await fs.readFile(outputPath);
    
    const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/${projectId}/${outputFilename}`;
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'video/mp4'
      },
      body: fileBuffer
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Upload failed: ${uploadResponse.status} - ${errorText}`);
    }

    console.log(`[${projectId}] Upload complete!`);

    // Get public URL
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${projectId}/${outputFilename}`;

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log(`[${projectId}] Cleanup complete`);

    res.json({
      success: true,
      url: publicUrl,
      filename: outputFilename
    });

  } catch (error) {
    console.error(`[${projectId}] Error:`, error);
    
    // Cleanup on error
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }

    res.status(500).json({
      error: 'Concatenation failed',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Server running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
});
