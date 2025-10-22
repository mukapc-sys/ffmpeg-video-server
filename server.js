// === server.js ===
const express = require("express");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const FFMPEG_API_KEY = process.env.FFMPEG_API_KEY;

// ---------- AUTH ----------
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!FFMPEG_API_KEY) return next();
  if (!apiKey || apiKey !== FFMPEG_API_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
};

// ---------- HEALTH ----------
app.get("/health", (req, res) => {
  const fsLocal = require("fs");
  const version = fsLocal.existsSync("./VERSION")
    ? fsLocal.readFileSync("./VERSION", "utf8").trim()
    : "unknown";
  res.json({
    status: "ok",
    version,
    hasAudioFix: version.includes("audio-sync-fix"),
    timestamp: new Date().toISOString(),
  });
});

// ---------- DIAGNOSTICS ----------
app.get("/diagnostics", async (req, res) => {
  try {
    const d = {
      status: "ok",
      timestamp: new Date().toISOString(),
      memory: {
        used: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + "MB",
        total:
          (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2) + "MB",
      },
      uptime: (process.uptime() / 60).toFixed(1) + "min",
    };
    try {
      await execAsync("ffmpeg -version");
      d.ffmpeg = "available";
    } catch {
      d.ffmpeg = "not available";
    }
    res.json(d);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- VALIDATE ----------
async function validateVideoFile(filepath, projectId, idx) {
  try {
    const stats = await fs.stat(filepath);
    if (stats.size < 1000) throw new Error("Arquivo muito pequeno");
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate -of json "${filepath}"`;
    const { stdout } = await execAsync(cmd);
    const s = JSON.parse(stdout).streams?.[0];
    if (!s) throw new Error("Vídeo inválido");
    return {
      isValid: true,
      codec: s.codec_name,
      width: s.width,
      height: s.height,
      fps: s.r_frame_rate,
    };
  } catch (e) {
    console.error(`[${projectId}] Erro validação ${idx}:`, e.message);
    return { isValid: false, error: e.message };
  }
}

function shouldNormalizeVideo(v, target) {
  return !(
    v.codec === "h264" &&
    v.width === target.width &&
    v.height === target.height &&
    (v.fps === "30/1" || v.fps === "30")
  );
}

async function fastCopyVideo(input, output, projectId, i) {
  const cmd = `ffmpeg -threads 1 -hide_banner -loglevel error -i "${input}" -c copy -movflags +faststart -y "${output}"`;
  await execAsync(cmd, { timeout: 60000 });
  console.log(`[${projectId}] FAST-PATH ${i} ok`);
  return { success: true };
}

async function normalizeVideoWithRetries(input, output, target, projectId, i) {
  const attempts = [
    { name: "rápido", preset: "fast", crf: 23 },
    { name: "robusto", preset: "medium", crf: 25 },
    { name: "forçado", preset: "slow", crf: 28 },
  ];
  for (const [a, cfg] of attempts.entries()) {
    try {
      const cmd = `ffmpeg -threads 1 -hide_banner -loglevel error -i "${input}" \
-vf "scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1" \
-r 30 -c:v libx264 -preset ${cfg.preset} -crf ${cfg.crf} \
-c:a aac -b:a 128k -ar 48000 -ac 2 -af "aresample=async=1:first_pts=0" \
-vsync 2 -movflags +faststart -y "${output}"`;
      await execAsync(cmd, { timeout: 900000 });
      console.log(`[${projectId}] normalizado ${i} via ${cfg.name}`);
      return { success: true };
    } catch (e) {
      console.log(`[${projectId}] falha tentativa ${a + 1}: ${e.message}`);
      if (a === attempts.length - 1) throw e;
    }
  }
}

// ---------- CONCAT ----------
app.post("/concatenate", authenticateApiKey, async (req, res) => {
  const { videoUrls, outputFilename, projectId, format, supabaseUrl, supabaseKey } = req.body;
  const fmt = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] };
  const [w, h] = fmt[format] || fmt["9:16"];
  const tempDir = path.join("/tmp", `project-${projectId}-${Date.now()}`);
  try {
    await fs.mkdir(tempDir, { recursive: true });
    const paths = [];
    for (const [i, url] of videoUrls.entries()) {
      const fp = path.join(tempDir, `video-${i}.mp4`);
      const resp = await fetch(url);
      const buf = await resp.buffer();
      await fs.writeFile(fp, buf);
      paths.push(fp);
    }

    const val = await Promise.all(paths.map((p, i) => validateVideoFile(p, projectId, i + 1)));
    const allOk = val.every(v => v.isValid);
    if (!allOk) throw new Error("vídeo inválido");

    const audios = [];
    for (const [i, p] of paths.entries()) {
      const af = path.join(tempDir, `audio-${i}.aac`);
      const cmd = `ffmpeg -threads 1 -hide_banner -loglevel error -i "${p}" -vn -c:a aac -b:a 128k -ar 48000 -ac 2 -af "aresample=async=1:first_pts=0" -y "${af}"`;
      await execAsync(cmd, { timeout: 120000 });
      audios.push(af);
    }
    const concatA = path.join(tempDir, "audios.txt");
    await fs.writeFile(concatA, audios.map(f => `file '${f}'`).join("\n"));
    const finalA = path.join(tempDir, "final-audio.aac");
    await execAsync(`ffmpeg -threads 1 -hide_banner -loglevel error -f concat -safe 0 -i "${concatA}" -c copy -y "${finalA}"`);

    const norm = [];
    for (const [i, p] of paths.entries()) {
      const out = path.join(tempDir, `norm-${i}.mp4`);
      if (shouldNormalizeVideo(val[i], { width: w, height: h }))
        await normalizeVideoWithRetries(p, out, { width: w, height: h }, projectId, i + 1);
      else await fastCopyVideo(p, out, projectId, i + 1);
      norm.push(out);
    }

    const concatV = path.join(tempDir, "concat.txt");
    await fs.writeFile(concatV, norm.map(f => `file '${f}'`).join("\n"));
    const videoOnly = path.join(tempDir, `video-only-${outputFilename}`);
    await execAsync(`ffmpeg -threads 1 -hide_banner -loglevel error -f concat -safe 0 -i "${concatV}" -c copy -movflags +faststart -y "${videoOnly}"`);

    let stats = await fs.stat(videoOnly);
    let size = stats.size / 1024 / 1024;
    let crf = 25;
    let pass = 0;
    while (size > 49 && pass < 4) {
      pass++;
      crf += 3;
      const tmp = path.join(tempDir, `compress${pass}.mp4`);
      await execAsync(
        `ffmpeg -threads 1 -hide_banner -loglevel error -i "${videoOnly}" -c:v libx264 -preset medium -crf ${crf} -an -movflags +faststart -y "${tmp}"`,
        { timeout: 900000 }
      );
      await fs.unlink(videoOnly);
      await fs.rename(tmp, videoOnly);
      stats = await fs.stat(videoOnly);
      size = stats.size / 1024 / 1024;
    }

    const output = path.join(tempDir, outputFilename);
    await execAsync(
      `ffmpeg -threads 1 -hide_banner -loglevel error -i "${videoOnly}" -i "${finalA}" -c:v copy -c:a aac -b:a 128k -ar 48000 -ac 2 -af "aresample=async=1:first_pts=0" -shortest -movflags +faststart -y "${output}"`,
      { timeout: 180000 }
    );
    let outStats = await fs.stat(output);
    let outSizeMB = outStats.size / 1024 / 1024;
    if (outSizeMB > 49) {
      const tmpFinal = path.join(tempDir, `final-pass.mp4`);
      await execAsync(
        `ffmpeg -threads 1 -hide_banner -loglevel error -i "${output}" -c:v libx264 -preset medium -crf 28 -c:a copy -movflags +faststart -y "${tmpFinal}"`
      );
      await fs.unlink(output);
      await fs.rename(tmpFinal, output);
      outStats = await fs.stat(output);
      outSizeMB = outStats.size / 1024 / 1024;
      console.log(`[${projectId}] ✅ Passe final de tamanho: ${outSizeMB.toFixed(2)} MB`);
    }

    const fileBuffer = await fs.readFile(output);
    const storagePath = req.body.storagePath || `${projectId}/${outputFilename}`;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/${storagePath}`;
    try {
      await fetch(uploadUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey },
      });
    } catch {}
    const up = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
        "Content-Type": "video/mp4",
        "x-upsert": "true",
      },
      body: fileBuffer,
    });
    if (!up.ok) {
      const t = await up.text();
      throw new Error(`Upload failed ${up.status}: ${t}`);
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${storagePath}`;
    console.log(`[${projectId}] ✅ Upload completo: ${publicUrl}`);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    if (global.gc) try { global.gc(); } catch {}
    return res.json({ success: true, url: publicUrl, filename: outputFilename });
  } catch (err) {
    console.error(`[${projectId}] ❌ concatenate error:`, err.message);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    try { await execAsync("pkill -9 ffmpeg || true"); } catch {}
    return res.status(500).json({ error: "Concatenation failed", details: err.message });
  }
});

// ---------- COMPRESS ----------
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

  if (!videoUrl) return res.status(400).json({ error: "videoUrl is required" });

  const uploadToSupabase = supabaseUrl && supabaseKey && outputPath;
  const jobId = `compress-${Date.now()}`;
  const tempDir = path.join("/tmp", jobId);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    const input = path.join(tempDir, "input.mp4");
    const r = await fetch(videoUrl, { redirect: "follow", timeout: 600000 });
    if (!r.ok) throw new Error(`download ${r.status}`);
    const buf = await r.buffer();
    await fs.writeFile(input, buf);

    const out = path.join(tempDir, `compressed.${outputFormat}`);
    const cmd = `ffmpeg -threads 1 -hide_banner -loglevel error -i "${input}" \
-c:v ${codec} -preset ${preset} -crf ${crf} -maxrate ${maxBitrate} -bufsize ${maxBitrate} \
-c:a ${audioCodec} -b:a ${audioBitrate} -ar 48000 -ac 2 -af "aresample=async=1:first_pts=0" \
-vsync 2 -fflags +genpts -avoid_negative_ts make_zero -movflags +faststart -y "${out}"`;
    await execAsync(cmd, { timeout: 900000 });

    let st = await fs.stat(out);
    let mb = st.size / 1024 / 1024;
    if (mb > 49) {
      const tmp = path.join(tempDir, `fit49.${outputFormat}`);
      await execAsync(
        `ffmpeg -threads 1 -hide_banner -loglevel error -i "${out}" -c:v ${codec} -preset medium -crf 28 -c:a copy -movflags +faststart -y "${tmp}"`
      );
      await fs.unlink(out);
      await fs.rename(tmp, out);
      st = await fs.stat(out);
      mb = st.size / 1024 / 1024;
    }

    if (uploadToSupabase) {
      const b = await fs.readFile(out);
      const url = `${supabaseUrl}/storage/v1/object/videos/${outputPath}`;
      try {
        await fetch(url, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey },
        });
      } catch {}
      const up = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          apikey: supabaseKey,
          "Content-Type": "video/mp4",
          "x-upsert": "true",
        },
        body: b,
      });
      if (!up.ok) {
        const t = await up.text();
        throw new Error(`upload ${up.status}: ${t}`);
      }
      await fs.rm(tempDir, { recursive: true, force: true });
      return res.json({ success: true, outputPath, sizeMB: parseFloat(mb.toFixed(2)) });
    } else {
      const b64 = (await fs.readFile(out)).toString("base64");
      await fs.rm(tempDir, { recursive: true, force: true });
      return res.json({ success: true, outputUrl: `data:video/mp4;base64,${b64}`, sizeMB: parseFloat(mb.toFixed(2)) });
    }
  } catch (err) {
    console.error(`[${jobId}] ❌ compress error:`, err.message);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    return res.status(500).json({ error: "Compression failed", details: err.message });
  }
});

// ---------- limpeza periódica ----------
setInterval(async () => {
  try {
    const base = "/tmp";
    const files = await fs.readdir(base);
    const now = Date.now();
    for (const f of files) {
      if (f.startsWith("project-") || f.startsWith("compress-")) {
        const p = path.join(base, f);
        try {
          const st = await fs.stat(p);
          if (now - st.mtimeMs > 60 * 60 * 1000) {
            await fs.rm(p, { recursive: true, force: true });
            console.log(`🧹 Removed ${f}`);
          }
        } catch {}
      }
    }
    try {
      const { stdout } = await execAsync("pgrep ffmpeg | wc -l");
      const n = parseInt(stdout.trim(), 10);
      if (n > 5) await execAsync('pkill -9 -f ffmpeg');
    } catch {}
  } catch (e) {
    console.warn("cleanup warn:", e.message);
  }
}, 15 * 60 * 1000);

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Server running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`🧹 Periodic cleanup enabled (every 15 minutes)`);
});
