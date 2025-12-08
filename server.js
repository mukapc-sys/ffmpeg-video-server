// === server.js === (arquivo completo com streaming otimizado para baixo consumo de RAM)
const express = require("express");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const archiver = require("archiver");

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const FFMPEG_API_KEY = process.env.FFMPEG_API_KEY;

// API Key authentication middleware
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];

  if (!FFMPEG_API_KEY) {
    console.error("⚠️ WARNING: FFMPEG_API_KEY not configured - running without authentication!");
    return next();
  }

  if (!apiKey || apiKey !== FFMPEG_API_KEY) {
    console.error("❌ Unauthorized request - Invalid or missing API key");
    return res.status(401).json({
      error: "Unauthorized - Invalid or missing API key",
    });
  }

  next();
};

// Health check (public endpoint)
app.get("/health", (req, res) => {
  const version = fsSync.existsSync("./VERSION") ? fsSync.readFileSync("./VERSION", "utf8").trim() : "unknown";

  res.json({
    status: "ok",
    version: version,
    hasAudioFix: version.includes("audio-sync-fix"),
    timestamp: new Date().toISOString(),
    optimizations: "streaming-enabled"
  });
});

// Diagnostic endpoint
app.get("/diagnostics", async (req, res) => {
  try {
    const diagnostics = {
      status: "ok",
      timestamp: new Date().toISOString(),
      memory: {
        used: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + " MB",
        total: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2) + " MB",
        external: (process.memoryUsage().external / 1024 / 1024).toFixed(2) + " MB",
        rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + " MB",
      },
      uptime: (process.uptime() / 60).toFixed(2) + " minutes",
      optimizations: "streaming-enabled"
    };

    // Check FFmpeg availability
    try {
      await execAsync("ffmpeg -version");
      diagnostics.ffmpeg = "available";
    } catch (err) {
      diagnostics.ffmpeg = "not available";
    }

    // Check disk space in /tmp
    try {
      const { stdout } = await execAsync("df -h /tmp | tail -1");
      const parts = stdout.trim().split(/\s+/);
      diagnostics.disk = {
        total: parts[1],
        used: parts[2],
        available: parts[3],
        usage: parts[4],
      };
    } catch (err) {
      diagnostics.disk = "unable to check";
    }

    // Count running FFmpeg processes
    try {
      const { stdout } = await execAsync("pgrep ffmpeg | wc -l");
      diagnostics.ffmpeg_processes = parseInt(stdout.trim());
    } catch (err) {
      diagnostics.ffmpeg_processes = 0;
    }

    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HELPER: Download via streaming (não carrega em RAM)
// ============================================
async function downloadToFile(url, outputPath, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const fileStream = fsSync.createWriteStream(outputPath);
    
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      rejectUnauthorized: false,
      requestCert: false,
      agent: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = protocol.request(options, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fileStream.close();
        fs.unlink(outputPath).catch(() => {});
        return downloadToFile(response.headers.location, outputPath, timeoutMs)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        fileStream.close();
        fs.unlink(outputPath).catch(() => {});
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      
      // Check for HTML response (Google Drive blocking)
      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('text/html')) {
        fileStream.close();
        fs.unlink(outputPath).catch(() => {});
        return reject(new Error('Received HTML instead of video - link may be blocked'));
      }
      
      // STREAMING: Pipe direto para arquivo (não RAM)
      response.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      
      fileStream.on('error', (err) => {
        fileStream.close();
        fs.unlink(outputPath).catch(() => {});
        reject(err);
      });
    });

    req.on('error', (error) => {
      fileStream.close();
      fs.unlink(outputPath).catch(() => {});
      reject(new Error(`Erro de rede: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      fileStream.close();
      fs.unlink(outputPath).catch(() => {});
      reject(new Error('Download timeout'));
    });

    req.end();
  });
}

// ============================================
// HELPER: Upload via streaming para R2
// ============================================
async function uploadFileStreamToR2(signedUrl, filePath, contentType = 'video/mp4') {
  const stats = await fs.stat(filePath);
  
  return new Promise((resolve, reject) => {
    const url = new URL(signedUrl);
    const fileStream = fsSync.createReadStream(filePath);
    
    const options = {
      method: 'PUT',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': contentType,
        'Content-Length': stats.size
      },
      timeout: 600000, // 10 minutos
      rejectUnauthorized: false,
      requestCert: false,
      agent: false
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Upload failed: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', (err) => {
      fileStream.destroy();
      reject(err);
    });
    
    req.on('timeout', () => {
      req.destroy();
      fileStream.destroy();
      reject(new Error('Upload timeout'));
    });
    
    fileStream.pipe(req);
    
    fileStream.on('error', (err) => {
      req.destroy();
      reject(err);
    });
  });
}

// ============================================
// AWS Signature V4 Helper Functions for R2
// ============================================
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac("AWS4" + key, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  const kSigning = hmac(kService, "aws4_request");
  return kSigning;
}

async function generateR2SignedUrl(endpoint, bucket, key, accessKeyId, secretAccessKey, region, method = "PUT") {
  const url = new URL(`${endpoint}/${bucket}/${key}`);
  const date = new Date();
  const dateStamp = date.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");

  const credential = `${accessKeyId}/${dateStamp}/${region}/s3/aws4_request`;
  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": "3600",
    "X-Amz-SignedHeaders": "host",
  });

  url.search = params.toString();

  const canonicalRequest = [
    method,
    `/${bucket}/${key}`,
    params.toString(),
    `host:${url.host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${region}/s3/aws4_request`,
    sha256(canonicalRequest),
  ].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, "s3");
  const signature = hmac(signingKey, stringToSign).toString("hex");

  url.searchParams.append("X-Amz-Signature", signature);

  return url.toString();
}

// ============================================
// ENDPOINT: /concatenate (STREAMING OTIMIZADO)
// ============================================
app.post("/concatenate", authenticateApiKey, async (req, res) => {
  const {
    videoUrls,
    outputFilename,
    projectId,
    format,
    r2AccountId,
    r2AccessKeyId,
    r2SecretAccessKey,
  } = req.body;

  console.log(`[${projectId}] 📥 Received request - Format: ${format}, Videos: ${videoUrls?.length}`);

  if (!videoUrls || videoUrls.length < 2) {
    return res.status(400).json({ error: "Needs at least 2 video URLs" });
  }

  // Definir dimensões baseado no formato
  const formatDimensions = {
    "9:16": { width: 1080, height: 1920 }, // Vertical
    "1:1": { width: 1080, height: 1080 }, // Quadrado
    "16:9": { width: 1920, height: 1080 }, // Horizontal
  };

  const targetDimensions = formatDimensions[format] || formatDimensions["9:16"];
  console.log(`[${projectId}] Target format: ${format} (${targetDimensions.width}x${targetDimensions.height})`);

  const tempDir = path.join("/tmp", `project-${projectId}-${Date.now()}`);

  try {
    // Create temp directory
    await fs.mkdir(tempDir, { recursive: true });
    console.log(`[${projectId}] Created temp dir: ${tempDir}`);

    // STREAMING: Download all videos direto para arquivo (não RAM)
    const downloadedFiles = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const url = videoUrls[i];
      const filename = `video-${i}.mp4`;
      const filepath = path.join(tempDir, filename);

      console.log(`[${projectId}] 📥 Downloading video ${i + 1}/${videoUrls.length} via streaming...`);

      const downloadStartTime = Date.now();

      try {
        await downloadToFile(url, filepath, 600000); // 10 min timeout
        
        const downloadTime = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
        const stats = await fs.stat(filepath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        console.log(`[${projectId}] ✅ Downloaded: ${filename} (${sizeMB} MB in ${downloadTime}s)`);

        if (stats.size > 200 * 1024 * 1024) {
          console.warn(`[${projectId}] ⚠️ Large file detected (${sizeMB} MB). Processing may take longer.`);
        }

        downloadedFiles.push(filepath);
      } catch (downloadError) {
        console.error(`[${projectId}] ❌ Download failed for video ${i + 1}:`, downloadError.message);
        throw new Error(`Failed to download video ${i + 1}: ${downloadError.message}`);
      }
    }

    // ============================================
    // CONCATENAÇÃO: Preparar vídeos já normalizados
    // ============================================
    console.log(`[${projectId}] 📝 Preparando ${downloadedFiles.length} vídeos normalizados para concatenação...`);

    // Create concat file for FFmpeg using downloaded files
    const concatFilePath = path.join(tempDir, "concat.txt");
    const concatContent = downloadedFiles.map((f) => `file '${f}'`).join("\n");
    await fs.writeFile(concatFilePath, concatContent);
    console.log(`[${projectId}] 📝 Created concat file with ${downloadedFiles.length} videos`);

    // ============================================
    // CONCATENAÇÃO HÍBRIDA (stream copy → re-encode se falhar)
    // ============================================
    const outputPath = path.join(tempDir, outputFilename);
    console.log(`[${projectId}] 🎬 Concatenando ${downloadedFiles.length} vídeos...`);

    let concatSuccess = false;
    let concatTime = 0;
    
    // TENTATIVA 1: Stream Copy (instantâneo)
    console.log(`[${projectId}] 🚀 Tentando stream copy (rápido)...`);
    const streamCopyCommand = `ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "${concatFilePath}" \
      -c copy \
      -movflags +faststart \
      -y "${outputPath}"`;
    
    try {
      const concatStartTime = Date.now();
      await execAsync(streamCopyCommand, { timeout: 120000 }); // 2 min timeout
      concatTime = ((Date.now() - concatStartTime) / 1000).toFixed(2);
      concatSuccess = true;
      console.log(`[${projectId}] ✅ Stream copy sucesso em ${concatTime}s!`);
    } catch (streamCopyError) {
      console.log(`[${projectId}] ⚠️ Stream copy falhou, tentando re-encode...`);
    }
    
    // TENTATIVA 2: Re-encode leve (se stream copy falhou)
    if (!concatSuccess) {
      console.log(`[${projectId}] 🔄 Fazendo re-encode com preset ultrafast...`);
      const reencodeCommand = `ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i "${concatFilePath}" \
        -c:v libx264 -preset ultrafast -crf 23 \
        -c:a aac -b:a 128k -ar 44100 -ac 2 \
        -movflags +faststart \
        -pix_fmt yuv420p \
        -r 30 \
        -vsync cfr \
        -async 1 \
        -avoid_negative_ts make_zero \
        -fflags +genpts \
        -threads 0 \
        -y "${outputPath}"`;
      
      try {
        const concatStartTime = Date.now();
        await execAsync(reencodeCommand, { timeout: 600000 }); // 10 min timeout

        concatTime = ((Date.now() - concatStartTime) / 1000).toFixed(2);
        concatSuccess = true;
        console.log(`[${projectId}] ✅ Re-encode completo em ${concatTime}s!`);
      } catch (reencodeError) {
        console.error(`[${projectId}] ❌ Re-encode falhou:`, reencodeError.message);
        throw reencodeError;
      }
    }
    
    // Validar output final
    if (!concatSuccess) {
      throw new Error('Ambas tentativas de concatenação falharam');
    }
    
    const outputStats = await fs.stat(outputPath);
    const sizeMB = (outputStats.size / 1024 / 1024).toFixed(2);
    console.log(`[${projectId}] 📦 Vídeo final: ${sizeMB} MB (tempo: ${concatTime}s)`);
    
    if (outputStats.size < 1000) {
      throw new Error(`Output video muito pequeno (${outputStats.size} bytes)`);
    }

    // STREAMING: Upload to Cloudflare R2 via stream (não carregar em RAM)
    console.log(`[${projectId}] 📤 Uploading to R2 via streaming...`);

    const storagePath = req.body.storagePath || `${projectId}/${outputFilename}`;

    if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey) {
      throw new Error("R2 credentials not provided in request");
    }

    const bucket = "video-parts-upload";
    const r2Endpoint = `https://${r2AccountId}.r2.cloudflarestorage.com`;
    const region = "auto";

    console.log(`[${projectId}] Generating signed URL for R2 path: ${storagePath}`);

    const signedUrl = await generateR2SignedUrl(
      r2Endpoint,
      bucket,
      storagePath,
      r2AccessKeyId,
      r2SecretAccessKey,
      region,
      "PUT",
    );

    console.log(`[${projectId}] Uploading to R2 with streaming...`);
    
    // STREAMING: Upload via stream (não fs.readFile)
    await uploadFileStreamToR2(signedUrl, outputPath, 'video/mp4');

    console.log(`[${projectId}] ✅ R2 upload complete!`);

    const publicUrl = `r2://${bucket}/${storagePath}`;

    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${projectId}] ✅ Cleanup complete`);
    } catch (cleanupError) {
      console.error(`[${projectId}] Cleanup warning:`, cleanupError.message);
    }

    if (global.gc) {
      global.gc();
      console.log(`[${projectId}] Garbage collection triggered`);
    }

    return res.json({
      success: true,
      url: publicUrl,
      filename: outputFilename,
    });
  } catch (error) {
    console.error(`[${projectId}] Error:`, error);

    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`[${projectId}] Cleanup on error complete`);
      }
    } catch (cleanupError) {
      console.error(`[${projectId}] Cleanup error:`, cleanupError.message);
    }

    try {
      await execAsync("pkill -9 ffmpeg || true");
      console.log(`[${projectId}] Killed hanging FFmpeg processes`);
    } catch (killError) {}

    return res.status(500).json({
      error: "Concatenation failed",
      details: error.message,
    });
  }
});

// ============================================
// ENDPOINT: /compress (STREAMING OTIMIZADO)
// ============================================
app.post("/compress", authenticateApiKey, async (req, res) => {
  const {
    videoUrl,
    outputFormat = "mp4",
    crf = 23,
    preset = "medium",
    maxBitrate = "5M",
    codec = "libx264",
    audioCodec = "aac",
    audioBitrate = "128k",
    supabaseUrl,
    supabaseKey,
    outputPath: targetOutputPath,
  } = req.body;

  console.log(`🗜️ Compression request: CRF=${crf}, preset=${preset}, maxBitrate=${maxBitrate}`);

  if (!videoUrl) {
    return res.status(400).json({ error: "videoUrl is required" });
  }

  const uploadToSupabase = supabaseUrl && supabaseKey && targetOutputPath;

  const compressId = `compress-${Date.now()}`;
  const tempDir = path.join("/tmp", compressId);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    console.log(`[${compressId}] Created temp dir: ${tempDir}`);

    const inputFile = path.join(tempDir, "input.mp4");
    console.log(`[${compressId}] 📥 Downloading via streaming...`);

    const downloadStartTime = Date.now();
    
    // STREAMING: Download direto para arquivo (não RAM)
    await downloadToFile(videoUrl, inputFile, 600000);

    const downloadTime = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
    const inputStats = await fs.stat(inputFile);
    const inputSizeMB = (inputStats.size / 1024 / 1024).toFixed(2);
    console.log(`[${compressId}] ✅ Downloaded: ${inputSizeMB} MB in ${downloadTime}s`);

    const outputFile = path.join(tempDir, `compressed.${outputFormat}`);
    console.log(`[${compressId}] 🗜️ Compressing with CRF=${crf}, preset=${preset}...`);

    const compressStartTime = Date.now();
    const compressCommand = `ffmpeg -hide_banner -loglevel error -i "${inputFile}" \
      -c:v ${codec} -preset ${preset} -crf ${crf} \
      -maxrate ${maxBitrate} -bufsize ${parseInt(maxBitrate) * 2}M \
      -c:a ${audioCodec} -b:a ${audioBitrate} \
      -ar 48000 -ac 2 \
      -vsync cfr \
      -fflags +genpts \
      -avoid_negative_ts make_zero \
      -movflags +faststart \
      -y "${outputFile}"`;

    await execAsync(compressCommand, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 900000,
    });

    const compressTime = ((Date.now() - compressStartTime) / 1000).toFixed(2);
    const outputStats = await fs.stat(outputFile);
    const outputSizeMB = (outputStats.size / 1024 / 1024).toFixed(2);
    const compressionRatio = ((1 - outputStats.size / inputStats.size) * 100).toFixed(1);

    console.log(
      `[${compressId}] ✅ Compressed: ${inputSizeMB}MB → ${outputSizeMB}MB in ${compressTime}s (${compressionRatio}% reduction)`,
    );

    if (uploadToSupabase) {
      console.log(`[${compressId}] 📤 Uploading to Supabase via streaming: ${targetOutputPath}`);

      // STREAMING: Upload via stream (não fs.readFile)
      const supabaseUploadUrl = `${supabaseUrl}/storage/v1/object/videos/${targetOutputPath}`;
      
      await new Promise((resolve, reject) => {
        const stats = fsSync.statSync(outputFile);
        const fileStream = fsSync.createReadStream(outputFile);
        const url = new URL(supabaseUploadUrl);
        
        const options = {
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'video/mp4',
            'Content-Length': stats.size,
            'x-upsert': 'false'
          },
          timeout: 600000
        };
        
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`Supabase upload failed: ${res.statusCode} - ${data}`));
            }
          });
        });
        
        req.on('error', (err) => {
          fileStream.destroy();
          reject(err);
        });
        
        req.on('timeout', () => {
          req.destroy();
          fileStream.destroy();
          reject(new Error('Upload timeout'));
        });
        
        fileStream.pipe(req);
        
        fileStream.on('error', (err) => {
          req.destroy();
          reject(err);
        });
      });

      console.log(`[${compressId}] ✅ Upload complete`);

      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${compressId}] ✅ Cleanup complete`);

      res.json({
        success: true,
        outputPath: targetOutputPath,
        originalSize: inputStats.size,
        compressedSize: outputStats.size,
        compressionRatio: parseFloat(compressionRatio),
        processingTime: parseFloat(compressTime),
      });
    } else {
      // STREAMING: Retornar via stream (não base64 em RAM)
      const processingTime = parseFloat(compressTime);

      res.set({
        'Content-Type': 'video/mp4',
        'Content-Length': outputStats.size,
        'X-Processing-Time': processingTime.toString(),
        'X-Original-Size': inputStats.size.toString(),
        'X-Compressed-Size': outputStats.size.toString(),
        'X-Compression-Ratio': compressionRatio
      });

      // Cleanup robusto
      const cleanup = async () => {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (e) {}
      };

      const fileStream = fsSync.createReadStream(outputFile);
      fileStream.pipe(res);

      fileStream.on('end', cleanup);
      fileStream.on('error', async (err) => {
        console.error(`[${compressId}] ❌ Stream error:`, err);
        await cleanup();
      });
      res.on('close', async () => {
        fileStream.destroy();
        await cleanup();
      });
    }
  } catch (error) {
    console.error(`[${compressId}] ❌ Error:`, error);

    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error(`[${compressId}] Cleanup error:`, cleanupError.message);
    }

    res.status(500).json({
      error: "Compression failed",
      details: error.message,
    });
  }
});

// ============================================
// ENDPOINT: /generate-zip (STREAMING COM ARCHIVER)
// ============================================
app.post('/generate-zip', authenticateApiKey, async (req, res) => {
  const startTime = Date.now();
  const tempFiles = [];
  let zipPath = null;
  const { videos, projectId, userId, productCode, r2Config } = req.body;
  
  try {
    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'Videos array is required' });
    }

    if (!r2Config || !r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucketName) {
      return res.status(400).json({ error: 'R2 config is required' });
    }

    console.log(`📦 [${projectId}] Gerando ZIP para ${videos.length} vídeos (modo streaming)`);

    // FASE 1: Download de vídeos via streaming (não RAM)
    console.log(`📥 [${projectId}] Fase 1: Download de vídeos via streaming...`);
    const downloadResults = [];
    const batchSize = 5;
    
    for (let i = 0; i < videos.length; i += batchSize) {
      const batch = videos.slice(i, i + batchSize);
      console.log(`📦 [${projectId}] Batch ${Math.floor(i/batchSize) + 1}: vídeos ${i + 1}-${Math.min(i + batchSize, videos.length)}`);
      
      const batchPromises = batch.map(async (video, idx) => {
        const tempPath = path.join('/tmp', `video_${Date.now()}_${i + idx}.mp4`);
        try {
          await downloadToFile(video.url, tempPath, 300000);
          const stats = await fs.stat(tempPath);
          tempFiles.push(tempPath);
          console.log(`✅ [${projectId}] ${video.filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          return { success: true, video, tempPath, size: stats.size };
        } catch (error) {
          console.error(`❌ [${projectId}] ${video.filename}: ${error.message}`);
          await fs.unlink(tempPath).catch(() => {});
          return { success: false, video, error: error.message };
        }
      });
      
      const results = await Promise.all(batchPromises);
      downloadResults.push(...results);
    }
    
    const successfulDownloads = downloadResults.filter(r => r.success);
    const failedDownloads = downloadResults.filter(r => !r.success);
    
    if (failedDownloads.length > 0) {
      console.warn(`⚠️ [${projectId}] ${failedDownloads.length} vídeos falharam`);
    }
    
    if (successfulDownloads.length === 0) {
      throw new Error('Nenhum vídeo foi baixado com sucesso');
    }

    console.log(`✅ [${projectId}] ${successfulDownloads.length}/${videos.length} vídeos baixados`);

    // FASE 2: Criar ZIP via streaming com archiver (não JSZip em RAM)
    console.log(`🔄 [${projectId}] Fase 2: Criando ZIP via streaming...`);
    
    zipPath = path.join('/tmp', `zip_${Date.now()}.zip`);
    const zipOutput = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { store: true }); // Sem compressão = mais rápido
    
    archive.pipe(zipOutput);
    
    for (const { video, tempPath } of successfulDownloads) {
      const cleanFilename = video.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      archive.file(tempPath, { name: cleanFilename });
    }
    
    await archive.finalize();
    
    // Aguardar arquivo ser escrito
    await new Promise((resolve, reject) => {
      zipOutput.on('close', resolve);
      zipOutput.on('error', reject);
    });
    
    const zipStats = await fs.stat(zipPath);
    const zipSizeBytes = zipStats.size;
    console.log(`✅ [${projectId}] ZIP criado: ${(zipSizeBytes / 1024 / 1024).toFixed(2)} MB`);

    // FASE 3: Upload para R2 via streaming
    console.log(`☁️ [${projectId}] Fase 3: Upload para R2 via streaming...`);
    
    const timestamp = Date.now();
    const filename = `${productCode}_videos_${timestamp}.zip`;
    const r2Path = `zips/${projectId}/${filename}`;
    
    const r2Endpoint = `https://${r2Config.accountId}.r2.cloudflarestorage.com`;
    const signedUrl = await generateR2SignedUrl(
      r2Endpoint,
      r2Config.bucketName,
      r2Path,
      r2Config.accessKeyId,
      r2Config.secretAccessKey,
      'auto',
      'PUT'
    );

    await uploadFileStreamToR2(signedUrl, zipPath, 'application/zip');

    const publicUrl = `https://pub-93cb8cc35ae64cf69f0ea248148ad1b2.r2.dev/${r2Config.bucketName}/${r2Path}`;
    console.log(`✅ [${projectId}] ZIP enviado para R2`);

    // FASE 4: Limpeza
    console.log(`🧹 [${projectId}] Fase 4: Limpando arquivos temporários...`);
    for (const tempFile of tempFiles) {
      await fs.unlink(tempFile).catch(() => {});
    }
    await fs.unlink(zipPath).catch(() => {});

    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`🎉 [${projectId}] Concluído em ${processingTime}s`);

    res.json({
      success: true,
      r2Path: `r2://${r2Config.bucketName}/${r2Path}`,
      publicUrl: publicUrl,
      size: zipSizeBytes,
      videosProcessed: successfulDownloads.length,
      videosFailed: failedDownloads.length,
      processingTimeSeconds: parseFloat(processingTime)
    });

  } catch (error) {
    console.error(`❌ [${projectId}] Erro:`, error);
    
    // Limpeza em caso de erro
    for (const tempFile of tempFiles) {
      await fs.unlink(tempFile).catch(() => {});
    }
    if (zipPath) await fs.unlink(zipPath).catch(() => {});
    
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LIMPEZA PERIÓDICA DE ARQUIVOS TEMPORÁRIOS
// ============================================
setInterval(
  async () => {
    try {
      console.log("🧹 Running periodic cleanup...");
      const tmpDir = "/tmp";
      const files = await fs.readdir(tmpDir);

      let cleanedCount = 0;
      const now = Date.now();

      for (const file of files) {
        if (file.startsWith("project-") || file.startsWith("compress-") || 
            file.startsWith("video_") || file.startsWith("zip_")) {
          const filePath = path.join(tmpDir, file);
          try {
            const stats = await fs.stat(filePath);
            if (now - stats.mtimeMs > 3600000) { // 1 hora
              await fs.rm(filePath, { recursive: true, force: true });
              cleanedCount++;
              console.log(`🗑️ Removed old temp: ${file}`);
            }
          } catch (err) {}
        }
      }

      console.log(`✅ Cleanup complete: ${cleanedCount} old items removed`);

      try {
        const { stdout } = await execAsync("pgrep ffmpeg | wc -l");
        const processCount = parseInt(stdout.trim());
        if (processCount > 5) {
          console.warn(`⚠️ Found ${processCount} FFmpeg processes, killing old ones...`);
          await execAsync('pkill -9 -f "ffmpeg.*project-"');
        }
      } catch (err) {}
    } catch (err) {
      console.error("Cleanup error:", err.message);
    }
  },
  15 * 60 * 1000,
); // A cada 15 minutos

const server = app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Server v2.0.0 (streaming) running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`🧹 Periodic cleanup enabled (every 15 minutes)`);
  console.log(`⚡ Optimizations: streaming downloads, streaming uploads, archiver ZIP`);
});

// Configurações de timeout para processamentos longos
server.timeout = 300000; // 5 minutos
server.keepAliveTimeout = 310000;
server.headersTimeout = 320000;

console.log(`⏱️ Server timeouts: ${server.timeout / 1000}s processing, ${server.keepAliveTimeout / 1000}s keep-alive`);
