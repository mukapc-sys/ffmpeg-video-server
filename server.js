const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main concatenation endpoint
app.post('/concatenate', async (req, res) => {
  const { videoUrls, outputFilename, projectId } = req.body;

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

    // Concatenate videos
    const outputPath = path.join(tempDir, outputFilename);
    console.log(`[${projectId}] Starting concatenation...`);
    
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i ${concatFilePath} -c copy ${outputPath}`;
    await execAsync(ffmpegCommand);
    
    console.log(`[${projectId}] Concatenation complete!`);

    // Upload to Supabase Storage
    console.log(`[${projectId}] Uploading to storage...`);
    const fileBuffer = await fs.readFile(outputPath);
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('videos')
      .upload(`${projectId}/${outputFilename}`, fileBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('videos')
      .getPublicUrl(`${projectId}/${outputFilename}`);

    console.log(`[${projectId}] Upload complete!`);

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log(`[${projectId}] Cleanup complete`);

    res.json({
      success: true,
      url: urlData.publicUrl,
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
