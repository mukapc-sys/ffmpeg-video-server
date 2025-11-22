// === server.js === (arquivo completo com ZIP + R2 CORRIGIDO)
const express = require("express");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");
const FormData = require("form-data");
const crypto = require("crypto");
const JSZip = require("jszip");

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

app.get("/health", (req, res) => {
  const fsLocal = require("fs");
  const version = fsLocal.existsSync("./VERSION") ? fsLocal.readFileSync("./VERSION", "utf8").trim() : "unknown";

  res.json({
    status: "ok",
    version: version,
    timestamp: new Date().toISOString(),
  });
});

// =========================
// R2 SIGNATURE HELPERS
// =========================
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
// ENDPOINT ZIP (CORRIGIDO DEFINITIVO)
// ============================================
app.post('/generate-zip', authenticateApiKey, async (req, res) => {
  let projectId = req.body.projectId || "unknown";

  try {
    const { videos, userId, productCode, r2Config } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'Videos array is required' });
    }

    if (!r2Config || !r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucketName) {
      return res.status(400).json({ error: 'R2 config is required' });
    }

    console.log(`📦 [${projectId}] Gerando ZIP para ${videos.length} vídeos`);

    const zip = new JSZip();
    let processed = 0;
    let failed = 0;

    for (const video of videos) {
      try {
        const response = await fetch(video.url, { timeout: 120000 });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.buffer();
        zip.file(video.filename, buffer);
        processed++;
        console.log(`✅ [${projectId}] ${video.filename}`);
      } catch (err) {
        failed++;
        console.error(`❌ [${projectId}] ${video.filename}: ${err.message}`);
      }
    }

    if (processed === 0) {
      return res.status(500).json({ error: 'Nenhum vídeo processado' });
    }

    console.log(`🗜️ [${projectId}] Gerando ZIP com ${processed} vídeos...`);
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE'
    });

    const filename = `${productCode}_videos_${Date.now()}.zip`;
    const r2Path = `zips/${projectId}/${filename}`;

    console.log(`📤 [${projectId}] Upload para R2: ${r2Path}`);

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
      method: 'PUT',
      body: zipBuffer,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': zipBuffer.length.toString()
      }
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`R2 upload failed: ${uploadResponse.status} - ${errorText}`);
    }

    console.log(`✅ [${projectId}] ZIP enviado para R2 com sucesso`);

    res.json({
      success: true,
      publicUrl: `https://${r2Config.accountId}.r2.cloudflarestorage.com/${r2Config.bucketName}/${r2Path}`,
      r2Path: `r2://${r2Config.bucketName}/${r2Path}`,
      size: zipBuffer.length,
      videosProcessed: processed,
      videosFailed: failed
    });

  } catch (error) {
    console.error(`❌ [${projectId}] Erro ZIP:`, error);
    res.status(500).json({ error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Server running on port ${PORT}`);
});
