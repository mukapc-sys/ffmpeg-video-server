// === server.js === (arquivo completo, com correções de áudio e upload para R2)
const express = require("express");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");
const FormData = require("form-data");
const crypto = require("crypto");
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
  const fsLocal = require("fs");
  const version = fsLocal.existsSync("./VERSION") ? fsLocal.readFileSync("./VERSION", "utf8").trim() : "unknown";

  res.json({
    status: "ok",
    version: version,
    hasAudioFix: version.includes("audio-sync-fix"),
    timestamp: new Date().toISOString(),
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
      },
      uptime: (process.uptime() / 60).toFixed(2) + " minutes",
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

// Main concatenation endpoint (protected)
app.post("/concatenate", authenticateApiKey, async (req, res) => {
  const {
    videoUrls,
    outputFilename,
    projectId,
    format,
    supabaseUrl,
    supabaseKey,
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

    // Download all videos
    const downloadedFiles = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const url = videoUrls[i];
      const filename = `video-${i}.mp4`;
      const filepath = path.join(tempDir, filename);

      console.log(`[${projectId}] 📥 Downloading video ${i + 1}/${videoUrls.length}...`);
      console.log(`[${projectId}] URL: ${url}`);

      const downloadStartTime = Date.now();

      const response = await fetch(url, {
        redirect: "follow",
        timeout: 600000, // 10 minutos timeout para arquivos grandes
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      console.log(`[${projectId}] Response status: ${response.status}`);
      console.log(`[${projectId}] Content-Type: ${response.headers.get("content-type")}`);
      console.log(`[${projectId}] Content-Length: ${response.headers.get("content-length")}`);

      if (!response.ok) {
        throw new Error(`Failed to download video ${i + 1}: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        console.error(`[${projectId}] ⚠️ WARNING: Received HTML instead of video! Google Drive may be blocking.`);
        const htmlPreview = (await response.text()).substring(0, 500);
        console.error(`[${projectId}] HTML preview: ${htmlPreview}`);
        throw new Error(`Google Drive returned HTML instead of video. Link may be private or blocked.`);
      }

      const buffer = await response.buffer();
      await fs.writeFile(filepath, buffer);

      const downloadTime = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
      const stats = await fs.stat(filepath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

      console.log(`[${projectId}] ✅ Downloaded: ${filename} (${sizeMB} MB in ${downloadTime}s)`);

      if (stats.size > 200 * 1024 * 1024) {
        console.warn(`[${projectId}] ⚠️ Large file detected (${sizeMB} MB). Processing may take longer.`);
      }

      downloadedFiles.push(filepath);
    }

    // ============================================
    // CONCATENAÇÃO: Preparar vídeos já normalizados
    // (Vídeos validados no upload + já normalizados pelo servidor dedicado)
    // ============================================
    console.log(`[${projectId}] 📝 Preparando ${downloadedFiles.length} vídeos normalizados para concatenação...`);

    // Create concat file for FFmpeg using downloaded files (já normalizados)
    const concatFilePath = path.join(tempDir, "concat.txt");
    const concatContent = downloadedFiles.map((f) => `file '${f}'`).join("\n");
    await fs.writeFile(concatFilePath, concatContent);
    console.log(`[${projectId}] 📝 Created concat file with ${downloadedFiles.length} videos`);
    console.log(`[${projectId}] Concat content:\n${concatContent}`);

    // ============================================
    // CONCATENAÇÃO HÍBRIDA (stream copy → re-encode se falhar)
    // ============================================
    const outputPath = path.join(tempDir, outputFilename);
    console.log(`[${projectId}] 🎬 Concatenando ${downloadedFiles.length} vídeos...`);
    console.log(`[${projectId}] Output: ${outputPath}`);

    // ESTRATÉGIA: Como os vídeos JÁ foram normalizados (1080x1920, 30fps, H.264)
    // 1. Tentar stream copy primeiro (RÁPIDO - sem re-encode)
    // 2. Se falhar, fazer re-encode leve
    
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
        const { stdout, stderr } = await execAsync(reencodeCommand, {
          timeout: 600000, // 10 min timeout
        });

        concatTime = ((Date.now() - concatStartTime) / 1000).toFixed(2);
        concatSuccess = true;
        console.log(`[${projectId}] ✅ Re-encode completo em ${concatTime}s!`);
        
        if (stderr && stderr.includes("Error")) {
          console.warn(`[${projectId}] FFmpeg warning:`, stderr);
        }
      } catch (reencodeError) {
        console.error(`[${projectId}] ❌ Re-encode falhou:`, reencodeError.message);
        if (reencodeError.stderr) {
          console.error(`[${projectId}] FFmpeg stderr:`, reencodeError.stderr);
        }
        throw reencodeError;
      }
    }
    
    // Validar output final
    if (!concatSuccess) {
      throw new Error('Ambas tentativas de concatenação falharam (stream copy e re-encode)');
    }
    
    const outputStats = await fs.stat(outputPath);
    const sizeMB = (outputStats.size / 1024 / 1024).toFixed(2);
    console.log(`[${projectId}] 📦 Vídeo final: ${sizeMB} MB (tempo: ${concatTime}s)`);
    
    if (outputStats.size < 1000) {
      throw new Error(`Output video muito pequeno (${outputStats.size} bytes)`);
    }

    // Upload to Cloudflare R2
    console.log(`[${projectId}] Uploading to R2...`);
    const fileBuffer = await fs.readFile(outputPath);

    const storagePath = req.body.storagePath || `${projectId}/${outputFilename}`;

    // R2 credentials should come from request payload (passed from edge function)
    if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey) {
      throw new Error("R2 credentials not provided in request");
    }

    const bucket = "video-parts-upload";
    const r2Endpoint = `https://${r2AccountId}.r2.cloudflarestorage.com`;
    const region = "auto";

    console.log(`[${projectId}] Generating signed URL for R2 path: ${storagePath}`);

    // Generate signed URL for upload
    const signedUrl = await generateR2SignedUrl(
      r2Endpoint,
      bucket,
      storagePath,
      r2AccessKeyId,
      r2SecretAccessKey,
      region,
      "PUT",
    );

    console.log(`[${projectId}] Uploading to R2 with signed URL...`);

    const uploadResponse = await fetch(signedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
      },
      body: fileBuffer,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error(`[${projectId}] R2 upload failed (${uploadResponse.status}):`, errorText);
      throw new Error(`R2 upload failed: ${uploadResponse.status} - ${errorText}`);
    }

    console.log(`[${projectId}] R2 upload complete!`);

    // R2 path will be used to generate signed URLs via edge function
    const publicUrl = `r2://${bucket}/${storagePath}`;

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${projectId}] Cleanup complete`);
    } catch (cleanupError) {
      console.error(`[${projectId}] Cleanup warning:`, cleanupError.message);
    }

    if (global.gc) {
      global.gc();
      console.log(`[${projectId}] Garbage collection triggered`);
    }

    // --- resposta final para o front (URL pública do Supabase)
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

// Compression endpoint (protected)
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
    outputPath,
  } = req.body;

  console.log(`🗜️ Compression request: CRF=${crf}, preset=${preset}, maxBitrate=${maxBitrate}`);

  if (!videoUrl) {
    return res.status(400).json({ error: "videoUrl is required" });
  }

  const uploadToSupabase = supabaseUrl && supabaseKey && outputPath;

  const compressId = `compress-${Date.now()}`;
  const tempDir = path.join("/tmp", compressId);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    console.log(`[${compressId}] Created temp dir: ${tempDir}`);

    const inputFile = path.join(tempDir, "input.mp4");
    console.log(`[${compressId}] 📥 Downloading from: ${videoUrl.substring(0, 80)}...`);

    const downloadStartTime = Date.now();
    const response = await fetch(videoUrl, {
      redirect: "follow",
      timeout: 600000,
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.buffer();
    await fs.writeFile(inputFile, buffer);

    const downloadTime = ((Date.now() - downloadStartTime) / 1000).toFixed(2);
    const inputStats = await fs.stat(inputFile);
    const inputSizeMB = (inputStats.size / 1024 / 1024).toFixed(2);
    console.log(`[${compressId}] ✅ Downloaded: ${inputSizeMB} MB in ${downloadTime}s`);

    const outputFile = path.join(tempDir, `compressed.${outputFormat}`);
    console.log(`[${compressId}] 🗜️ Compressing with CRF=${crf}, preset=${preset}...`);

    const compressStartTime = Date.now();
    // removi -af "aresample=async=1:first_pts=0" daqui para evitar pitch changes; uso -ar 48000 -ac 2
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
      console.log(`[${compressId}] 📤 Uploading to Supabase: ${outputPath}`);

      const compressedBuffer = await fs.readFile(outputFile);

      const uploadResponse = await fetch(`${supabaseUrl}/storage/v1/object/videos/${outputPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "video/mp4",
          "x-upsert": "false",
        },
        body: compressedBuffer,
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        throw new Error(`Supabase upload failed: ${uploadResponse.status} - ${errorText}`);
      }

      console.log(`[${compressId}] ✅ Upload complete`);

      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${compressId}] ✅ Cleanup complete`);

      res.json({
        success: true,
        outputPath: outputPath,
        originalSize: inputStats.size,
        compressedSize: outputStats.size,
        compressionRatio: parseFloat(compressionRatio),
        processingTime: parseFloat(compressTime),
      });
    } else {
      const compressedBuffer = await fs.readFile(outputFile);
      const compressedBase64 = compressedBuffer.toString("base64");

      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${compressId}] ✅ Cleanup complete`);

      res.json({
        success: true,
        outputUrl: `data:video/mp4;base64,${compressedBase64}`,
        originalSize: inputStats.size,
        compressedSize: outputStats.size,
        compressionRatio: parseFloat(compressionRatio),
        processingTime: parseFloat(compressTime),
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
// ENDPOINT: GENERATE ZIP (STREAM REAL - NÃO CRASHA)
// ============================================

const archiver = require("archiver");
const fsSync = require("fs");

app.post('/generate-zip', authenticateApiKey, async (req, res) => {
  const { videos, projectId, productCode, r2Config } = req.body;

  try {
    if (!videos || !videos.length) {
      return res.status(400).json({ error: "Videos são obrigatórios" });
    }

    console.log(`📦 [${projectId}] Gerando ZIP para ${videos.length} vídeos`);

    const zipName = `${productCode}_videos_${Date.now()}.zip`;
    const localZipPath = `/tmp/${zipName}`;

    const output = fsSync.createWriteStream(localZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);

    let processed = 0;

    for (const video of videos) {
      console.log(`➕ Adicionando: ${video.filename}`);

      const response = await fetch(video.url);

      if (!response.ok) {
        console.warn(`⚠️ Falha: ${video.filename}`);
        continue;
      }

      archive.append(response.body, { name: video.filename });
      processed++;
    }

    await archive.finalize();
    await new Promise(resolve => output.on("close", resolve));

    console.log(`✅ ZIP gerado local: ${localZipPath}`);

    const zipBuffer = await fs.readFile(localZipPath);

    // Upload para R2
    const r2Path = `zips/${projectId}/${zipName}`;
    const r2Endpoint = `https://${r2Config.accountId}.r2.cloudflarestorage.com`;

    const signedUrl = await generateR2SignedUrl(
      r2Endpoint,
      r2Config.bucketName,
      r2Path,
      r2Config.accessKeyId,
      r2Config.secretAccessKey,
      "auto",
      "PUT"
    );

    const uploadResponse = await fetch(signedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": zipBuffer.length.toString()
      },
      body: zipBuffer
    });

    if (!uploadResponse.ok) {
      throw new Error("Falha no upload ZIP R2");
    }

    await fs.unlink(localZipPath);

    const publicUrl = `https://${r2Config.accountId}.r2.cloudflarestorage.com/${r2Config.bucketName}/${r2Path}`;

    console.log(`✅ ZIP DISPONÍVEL: ${publicUrl}`);

    res.json({
      success: true,
      publicUrl,
      videosProcessados: processed
    });

  } catch (err) {
    console.error(`❌ ERRO ZIP:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

    if (!uploadResponse.ok) {
      throw new Error(`R2 upload falhou: ${uploadResponse.status}`);
    }

    console.log(`✅ [${projectId}] ZIP enviado para R2`);

    res.json({
      success: true,
      r2Path: `r2://${r2Config.bucketName}/${r2Path}`,
      publicUrl: r2Url,
      size: zipBuffer.length,
      videosProcessed: processed,
      videosFailed: failed
    });

  } catch (error) {
    console.error(`❌ [${projectId}] Erro:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Limpeza periódica de arquivos temporários (a cada 15 minutos)
setInterval(
  async () => {
    try {
      console.log("🧹 Running periodic cleanup...");
      const tmpDir = "/tmp";
      const files = await fs.readdir(tmpDir);

      let cleanedCount = 0;
      const now = Date.now();

      for (const file of files) {
        if (file.startsWith("project-") || file.startsWith("compress-")) {
          const filePath = path.join(tmpDir, file);
          try {
            const stats = await fs.stat(filePath);
            if (now - stats.mtimeMs > 3600000) {
              await fs.rm(filePath, { recursive: true, force: true });
              cleanedCount++;
              console.log(`🗑️  Removed old temp dir: ${file}`);
            }
          } catch (err) {}
        }
      }

      console.log(`✅ Cleanup complete: ${cleanedCount} old directories removed`);

      try {
        const { stdout } = await execAsync("pgrep ffmpeg | wc -l");
        const processCount = parseInt(stdout.trim());
        if (processCount > 5) {
          console.warn(`⚠️  Found ${processCount} FFmpeg processes, killing old ones...`);
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
  console.log(`🎬 FFmpeg Server running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`🧹 Periodic cleanup enabled (every 15 minutes)`);
});

// Configurações de timeout para processamentos longos (compressão iterativa)
server.timeout = 300000; // 5 minutos - tempo máximo de processamento
server.keepAliveTimeout = 310000; // 5min + 10s - mantém conexão viva
server.headersTimeout = 320000; // 5min + 20s - tempo para receber headers

console.log(`⏱️  Server timeouts: ${server.timeout / 1000}s processing, ${server.keepAliveTimeout / 1000}s keep-alive`);
