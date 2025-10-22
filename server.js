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

const PORT = process.env.PORT || 8080;
const FFMPEG_API_KEY = process.env.FFMPEG_API_KEY;

// API Key authentication middleware
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!FFMPEG_API_KEY) {
    console.error('⚠️ WARNING: FFMPEG_API_KEY not configured - running without authentication!');
    return next();
  }
  
  if (!apiKey || apiKey !== FFMPEG_API_KEY) {
    console.error('❌ Unauthorized request - Invalid or missing API key');
    return res.status(401).json({ 
      error: 'Unauthorized - Invalid or missing API key' 
    });
  }
  
  next();
};

// Health check (public endpoint)
app.get('/health', (req, res) => {
  const fs = require('fs');
  const version = fs.existsSync('./VERSION') 
    ? fs.readFileSync('./VERSION', 'utf8').trim() 
    : 'unknown';
  
  res.json({ 
    status: 'ok',
    version: version,
    hasAudioFix: version.includes('audio-sync-fix'),
    timestamp: new Date().toISOString()
  });
});

// Diagnostic endpoint
app.get('/diagnostics', async (req, res) => {
  try {
    const diagnostics = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      memory: {
        used: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + ' MB',
        total: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2) + ' MB',
        external: (process.memoryUsage().external / 1024 / 1024).toFixed(2) + ' MB'
      },
      uptime: (process.uptime() / 60).toFixed(2) + ' minutes'
    };
    
    // Check FFmpeg availability
    try {
      await execAsync('ffmpeg -version');
      diagnostics.ffmpeg = 'available';
    } catch (err) {
      diagnostics.ffmpeg = 'not available';
    }
    
    // Check disk space in /tmp
    try {
      const { stdout } = await execAsync('df -h /tmp | tail -1');
      const parts = stdout.trim().split(/\s+/);
      diagnostics.disk = {
        total: parts[1],
        used: parts[2],
        available: parts[3],
        usage: parts[4]
      };
    } catch (err) {
      diagnostics.disk = 'unable to check';
    }
    
    // Count running FFmpeg processes
    try {
      const { stdout } = await execAsync('pgrep ffmpeg | wc -l');
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
// VALIDATION AND NORMALIZATION FUNCTIONS
// ============================================

/**
 * Validate video file with ffprobe before processing
 */
async function validateVideoFile(filepath, projectId, videoIndex) {
  try {
    console.log(`[${projectId}] 🔍 Validando vídeo ${videoIndex}...`);
    
    // Verificar se arquivo existe e não está vazio
    const stats = await fs.stat(filepath);
    if (stats.size < 1000) {
      throw new Error(`Arquivo muito pequeno (${stats.size} bytes)`);
    }
    
    // ffprobe para validar estrutura do vídeo
    const probeCmd = `ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=codec_name,width,height,r_frame_rate,duration,nb_read_packets -of json "${filepath}"`;
    const { stdout } = await execAsync(probeCmd, { timeout: 30000 });
    const probeData = JSON.parse(stdout);
    
    if (!probeData.streams || probeData.streams.length === 0) {
      throw new Error('Nenhum stream de vídeo encontrado');
    }
    
    const stream = probeData.streams[0];
    
    // Validações críticas
    if (!stream.codec_name) {
      throw new Error('Codec não identificado - arquivo pode estar corrompido');
    }
    
    if (!stream.width || !stream.height) {
      throw new Error('Dimensões inválidas - arquivo pode estar corrompido');
    }
    
    if (stream.nb_read_packets === '0') {
      throw new Error('Sem pacotes válidos - arquivo corrompido');
    }
    
    console.log(`[${projectId}] ✅ Vídeo ${videoIndex} válido: ${stream.width}x${stream.height}, codec: ${stream.codec_name}`);
    
    return {
      isValid: true,
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      fps: stream.r_frame_rate,
      duration: stream.duration
    };
    
  } catch (error) {
    console.error(`[${projectId}] ❌ Validação falhou para vídeo ${videoIndex}:`, error.message);
    return {
      isValid: false,
      error: error.message
    };
  }
}

/**
 * Decide if video needs normalization based on specs
 * Returns TRUE if re-encode is needed, FALSE if can use fast-path
 */
function shouldNormalizeVideo(validationData, targetDimensions) {
  const { codec, width, height, fps } = validationData;
  
  // Condições para PULAR normalização (usar stream copy):
  const isCorrectCodec = codec === 'h264';
  const isCorrectWidth = width === targetDimensions.width;
  const isCorrectHeight = height === targetDimensions.height;
  const isCorrectFps = fps && (fps === '30/1' || fps === '30' || fps === '60/1');
  
  const canSkipNormalization = isCorrectCodec && isCorrectWidth && isCorrectHeight && isCorrectFps;
  
  if (canSkipNormalization) {
    console.log(`✅ Vídeo JÁ está no formato ideal (${codec}, ${width}x${height}, ${fps}fps) - PULANDO re-encode`);
    return false; // Não precisa normalizar
  }
  
  console.log(`⚠️ Vídeo precisa de normalização: codec=${codec}, dimensões=${width}x${height}, fps=${fps}`);
  return true; // Precisa normalizar
}

/**
 * Fast-path: Stream copy without re-encoding (10x faster)
 * Falls back to normalization if fails
 */
async function fastCopyVideo(inputFile, outputFile, projectId, videoIndex) {
  try {
    console.log(`[${projectId}] ⚡ FAST-PATH: Copiando streams do vídeo ${videoIndex} (sem re-encode)...`);
    const startTime = Date.now();
    
    // Stream copy: copia dados binários sem re-processar com correção de timestamps
    const copyCommand = `ffmpeg -i "${inputFile}" \
      -c copy \
      -movflags +faststart \
      -fflags +genpts \
      -avoid_negative_ts make_zero \
      -y "${outputFile}"`;
    
    await execAsync(copyCommand, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 60000 // 1 minuto (muito mais rápido que re-encode)
    });
    
    // Validar arquivo de saída
    const stats = await fs.stat(outputFile);
    if (stats.size < 1000) {
      throw new Error(`Arquivo copiado muito pequeno (${stats.size} bytes)`);
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[${projectId}] ⚡ FAST-PATH completo em ${duration}s (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    
    return { success: true, method: 'Fast Stream Copy' };
    
  } catch (error) {
    console.error(`[${projectId}] ❌ Fast-path falhou (não é fatal):`, error.message);
    throw error; // Permite fallback para normalização completa
  }
}

/**
 * Normalize video with 3-level fallback strategy
 */
async function normalizeVideoWithRetries(inputFile, outputFile, targetDimensions, projectId, videoIndex) {
  const attempts = [
    {
      name: 'Normalização Rápida',
      preset: 'fast',
      crf: 23,
      extraFilters: ''
    },
    {
      name: 'Normalização Robusta',
      preset: 'medium',
      crf: 25,
      extraFilters: ',format=yuv420p'
    },
    {
      name: 'Re-encode Total Forçado',
      preset: 'slow',
      crf: 28,
      extraFilters: ',format=yuv420p,setpts=PTS-STARTPTS'
    }
  ];
  
  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
    const attempt = attempts[attemptIndex];
    console.log(`[${projectId}] 🔄 Tentativa ${attemptIndex + 1}/3: ${attempt.name} (vídeo ${videoIndex})`);
    
    try {
      const startTime = Date.now();
      
      // Comando FFmpeg normalizado APENAS PARA VÍDEO (sem áudio)
      // - Processa SOMENTE o stream de vídeo (-an remove áudio)
      // - Áudio será adicionado separadamente depois
      console.log(`[${projectId}] 🔧 Normalizando APENAS vídeo ${videoIndex} (sem áudio) com parâmetros:`, {
        preset: attempt.preset,
        crf: attempt.crf,
        targetWidth: targetDimensions.width,
        targetHeight: targetDimensions.height
      });
      
      const normalizeCommand = `ffmpeg -i "${inputFile}" \
        -vf "scale=${targetDimensions.width}:${targetDimensions.height}:force_original_aspect_ratio=decrease,pad=${targetDimensions.width}:${targetDimensions.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1${attempt.extraFilters}" \
        -r 30 \
        -c:v libx264 -preset ${attempt.preset} -crf ${attempt.crf} \
        -maxrate 1.5M -bufsize 3M \
        -an \
        -movflags +faststart \
        -max_muxing_queue_size 1024 \
        -y "${outputFile}"`;
      
      const { stdout, stderr } = await execAsync(normalizeCommand, {
        maxBuffer: 100 * 1024 * 1024,
        timeout: 600000 // 10 minutos
      });
      
      console.log(`[${projectId}] 📊 Normalização stdout (primeiras 500 chars):`, stdout.substring(0, 500));
      if (stderr) {
        console.log(`[${projectId}] ⚠️ Normalização stderr (primeiras 1000 chars):`, stderr.substring(0, 1000));
      }
      
      // Validar arquivo de saída
      const stats = await fs.stat(outputFile);
      if (stats.size < 1000) {
        throw new Error(`Arquivo normalizado muito pequeno (${stats.size} bytes)`);
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[${projectId}] ✅ Vídeo ${videoIndex} normalizado com sucesso em ${duration}s (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
      
      return { success: true, method: attempt.name };
      
    } catch (error) {
      console.error(`[${projectId}] ❌ ${attempt.name} falhou:`, error.message);
      
      // Log detalhado do erro para debug
      if (error.stderr) {
        console.error(`[${projectId}] 📋 FFmpeg stderr completo:`, error.stderr);
      }
      if (error.code) {
        console.error(`[${projectId}] 💥 Exit code:`, error.code);
      }
      if (error.signal) {
        console.error(`[${projectId}] ⚡ Signal:`, error.signal);
      }
      
      // Se não é a última tentativa, continua para próxima
      if (attemptIndex < attempts.length - 1) {
        console.log(`[${projectId}] ⚠️ Tentando próximo método...`);
        continue;
      }
      
      // Se chegou aqui, todas as 3 tentativas falharam
      throw new Error(`Todas as 3 tentativas de normalização falharam para vídeo ${videoIndex}. Último erro: ${error.message}. Stderr: ${error.stderr || 'N/A'}`);
    }
  }
}

// Main concatenation endpoint (protected)
app.post('/concatenate', authenticateApiKey, async (req, res) => {
  const { videoUrls, outputFilename, projectId, format, supabaseUrl, supabaseKey } = req.body;

  console.log(`[${projectId}] 📥 Received request - Format: ${format}, Videos: ${videoUrls?.length}`);

  if (!videoUrls || videoUrls.length < 2) {
    return res.status(400).json({ error: 'Needs at least 2 video URLs' });
  }

  // Definir dimensões baseado no formato
  const formatDimensions = {
    '9:16': { width: 1080, height: 1920 }, // Vertical
    '1:1': { width: 1080, height: 1080 },   // Quadrado
    '16:9': { width: 1920, height: 1080 }   // Horizontal
  };

  const targetDimensions = formatDimensions[format] || formatDimensions['9:16'];
  console.log(`[${projectId}] Target format: ${format} (${targetDimensions.width}x${targetDimensions.height})`);

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
      
      console.log(`[${projectId}] 📥 Downloading video ${i + 1}/${videoUrls.length}...`);
      console.log(`[${projectId}] URL: ${url}`);
      
      const downloadStartTime = Date.now();
      
      const response = await fetch(url, {
        redirect: 'follow',
        timeout: 600000, // 10 minutos timeout para arquivos grandes
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      console.log(`[${projectId}] Response status: ${response.status}`);
      console.log(`[${projectId}] Content-Type: ${response.headers.get('content-type')}`);
      console.log(`[${projectId}] Content-Length: ${response.headers.get('content-length')}`);
      
      if (!response.ok) {
        throw new Error(`Failed to download video ${i + 1}: ${response.status} ${response.statusText}`);
      }
      
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
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
    // ETAPA 1: VALIDAÇÃO OBRIGATÓRIA
    // ============================================
    console.log(`[${projectId}] 🔍 ETAPA 1: Validando todos os vídeos...`);
    
    const validationResults = [];
    for (let i = 0; i < downloadedFiles.length; i++) {
      const validation = await validateVideoFile(downloadedFiles[i], projectId, i + 1);
      validationResults.push(validation);
      
      if (!validation.isValid) {
        throw new Error(`Vídeo ${i + 1} está corrompido ou inválido: ${validation.error}`);
      }
    }
    
    console.log(`[${projectId}] ✅ Todos os ${downloadedFiles.length} vídeos passaram na validação`);

    // ============================================
    // ETAPA 1.5: EXTRAIR ÁUDIOS ORIGINAIS (SEM RE-ENCODING)
    // ============================================
    console.log(`[${projectId}] 🎵 ETAPA 1.5: Extraindo áudios originais (sem re-encoding)...`);
    
    const extractedAudios = [];
    for (let i = 0; i < downloadedFiles.length; i++) {
      const audioFile = path.join(tempDir, `audio-${i}.aac`);
      const extractCommand = `ffmpeg -i "${downloadedFiles[i]}" -vn -c:a copy -y "${audioFile}"`;
      
      try {
        await execAsync(extractCommand, { timeout: 60000 });
        extractedAudios.push(audioFile);
        console.log(`[${projectId}] ✅ Áudio ${i + 1} extraído (codec original mantido)`);
      } catch (extractError) {
        console.error(`[${projectId}] ❌ Erro ao extrair áudio ${i + 1}:`, extractError.message);
        throw new Error(`Falha ao extrair áudio do vídeo ${i + 1}`);
      }
    }
    
    // Concatenar áudios usando codec copy
    const audioConcatFile = path.join(tempDir, 'audio-concat.txt');
    const audioConcatContent = extractedAudios.map(f => `file '${f}'`).join('\n');
    await fs.writeFile(audioConcatFile, audioConcatContent);
    
    const finalAudioPath = path.join(tempDir, 'final-audio.aac');
    const audioConcatCommand = `ffmpeg -f concat -safe 0 -i "${audioConcatFile}" -c copy -y "${finalAudioPath}"`;
    
    try {
      await execAsync(audioConcatCommand, { timeout: 120000 });
      const audioStats = await fs.stat(finalAudioPath);
      console.log(`[${projectId}] ✅ Áudios concatenados (${(audioStats.size / 1024 / 1024).toFixed(2)} MB, codec original mantido)`);
    } catch (concatError) {
      console.error(`[${projectId}] ❌ Erro ao concatenar áudios:`, concatError.message);
      throw new Error('Falha ao concatenar áudios');
    }

    // ============================================
    // ETAPA 2: NORMALIZAÇÃO INTELIGENTE (SOMENTE VÍDEO)
    // ============================================
    console.log(`[${projectId}] 🔄 ETAPA 2: Verificando necessidade de normalização...`);
    
    const normalizedFiles = [];
    
    for (let i = 0; i < downloadedFiles.length; i++) {
      const inputFile = downloadedFiles[i];
      const normalizedFile = path.join(tempDir, `normalized-${i}.mp4`);
      const validation = validationResults[i];
      
      console.log(`[${projectId}] 📹 Vídeo ${i + 1}/${downloadedFiles.length}: ${validation.codec} ${validation.width}x${validation.height} ${validation.fps}fps`);
      
      // 🔑 DECISÃO INTELIGENTE: Normalizar ou não?
      const needsNormalization = shouldNormalizeVideo(validation, targetDimensions);
      
      if (needsNormalization) {
        // ⚙️ Caminho normal: Re-encode completo (vídeo não está no formato ideal)
        console.log(`[${projectId}] 🔄 Normalizando vídeo ${i + 1} (re-encode necessário)...`);
        
        const result = await normalizeVideoWithRetries(
          inputFile,
          normalizedFile,
          targetDimensions,
          projectId,
          i + 1
        );
        
        normalizedFiles.push(normalizedFile);
        console.log(`[${projectId}] ✅ Vídeo ${i + 1} normalizado via: ${result.method}`);
        
      } else {
        // ⚡ Fast-path: Vídeo JÁ está perfeito, apenas copia streams
        console.log(`[${projectId}] ⚡ Vídeo ${i + 1} JÁ está perfeito, usando fast-path...`);
        
        try {
          const result = await fastCopyVideo(
            inputFile,
            normalizedFile,
            projectId,
            i + 1
          );
          
          normalizedFiles.push(normalizedFile);
          console.log(`[${projectId}] ✅ ${result.method} - 10x mais rápido que re-encode!`);
          
        } catch (fastPathError) {
          // 🛡️ FALLBACK AUTOMÁTICO: Se fast-path falhar, usa re-encode
          console.log(`[${projectId}] ⚠️ Fast-path falhou, usando re-encode como fallback...`);
          
          const result = await normalizeVideoWithRetries(
            inputFile,
            normalizedFile,
            targetDimensions,
            projectId,
            i + 1
          );
          
          normalizedFiles.push(normalizedFile);
          console.log(`[${projectId}] ✅ Vídeo ${i + 1} normalizado via fallback: ${result.method}`);
        }
      }
    }
    
    console.log(`[${projectId}] ✅ Todos os ${normalizedFiles.length} vídeos prontos para concatenação`)

    // Create concat file for FFmpeg using normalized files
    const concatFilePath = path.join(tempDir, 'concat.txt');
    const concatContent = normalizedFiles.map(f => `file '${f}'`).join('\n');
    await fs.writeFile(concatFilePath, concatContent);
    console.log(`[${projectId}] 📝 Created concat file with ${normalizedFiles.length} videos`);
    console.log(`[${projectId}] Concat content:\n${concatContent}`);

    // ============================================
    // ETAPA 3: CONCATENAÇÃO RÁPIDA (APENAS VÍDEOS, SEM ÁUDIO)
    // ============================================
    const videoOnlyPath = path.join(tempDir, `video-only-${outputFilename}`);
    const outputPath = path.join(tempDir, outputFilename); // DECLARAR AQUI para estar disponível em todo o escopo
    console.log(`[${projectId}] 🎬 ETAPA 3: Concatenando ${normalizedFiles.length} vídeos normalizados (sem áudio)...`);
    console.log(`[${projectId}] Video-only output will be: ${videoOnlyPath}`);
    
    // Como TODOS os vídeos foram normalizados, usar sempre concat rápido
    console.log(`[${projectId}] Using fast concat (codec copy - vídeos já normalizados, sem áudio)`);
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${concatFilePath}" \
      -c copy \
      -movflags +faststart \
      -y "${videoOnlyPath}"`;
    
    try {
      const concatStartTime = Date.now();
      const { stdout, stderr } = await execAsync(ffmpegCommand, {
        timeout: 600000 // 10 minutos
      });
      
      const concatTime = ((Date.now() - concatStartTime) / 1000).toFixed(2);
      
      // Verify output file
      let videoOnlyStats = await fs.stat(videoOnlyPath);
      console.log(`[${projectId}] ✅ Video concatenation complete in ${concatTime}s!`);
      console.log(`[${projectId}] Video-only file size: ${(videoOnlyStats.size / 1024 / 1024).toFixed(2)} MB`);
      
      if (videoOnlyStats.size < 1000) {
        throw new Error(`Output video is too small (${videoOnlyStats.size} bytes), concatenation likely failed`);
      }
      
      if (stderr && stderr.includes('Error')) {
        console.warn(`[${projectId}] FFmpeg concatenation warning:`, stderr);
      }

      // ============================================
      // COMPRESSÃO ITERATIVA ATÉ < 49MB (SOMENTE VÍDEO)
      // ============================================
      const MAX_SIZE_MB = 49;
      const MAX_CRF = 35; // CRF máximo antes de desistir
      let currentSizeMB = videoOnlyStats.size / 1024 / 1024;
      let currentCrf = 23; // CRF inicial
      let compressionAttempt = 0;
      const MAX_ATTEMPTS = 4; // Máximo de tentativas de compressão
      
      if (currentSizeMB > MAX_SIZE_MB) {
        console.log(`[${projectId}] ⚠️ Vídeo muito grande (${currentSizeMB.toFixed(2)} MB). Iniciando compressão iterativa (somente vídeo)...`);
        
        const compressStartTime = Date.now();
        let workingPath = videoOnlyPath;
        
        while (currentSizeMB > MAX_SIZE_MB && compressionAttempt < MAX_ATTEMPTS && currentCrf <= MAX_CRF) {
          compressionAttempt++;
          
          // Calcular CRF baseado no quanto precisa comprimir
          const compressionRatio = currentSizeMB / MAX_SIZE_MB;
          
          if (compressionAttempt === 1) {
            // Primeira tentativa: CRF baseado no tamanho inicial
            if (compressionRatio > 3) {
              currentCrf = 32; // Enorme - compressão muito agressiva
            } else if (compressionRatio > 2) {
              currentCrf = 30; // Muito grande - compressão agressiva
            } else if (compressionRatio > 1.5) {
              currentCrf = 28; // Grande - compressão alta
            } else {
              currentCrf = 25; // Levemente grande - compressão moderada
            }
          } else {
            // Tentativas subsequentes: aumentar CRF gradualmente
            currentCrf = Math.min(currentCrf + 3, MAX_CRF);
          }
          
          console.log(`[${projectId}] Tentativa ${compressionAttempt}/${MAX_ATTEMPTS}: CRF ${currentCrf} (tamanho atual: ${currentSizeMB.toFixed(2)} MB, ratio: ${compressionRatio.toFixed(2)}x)`);
          
          const compressedPath = path.join(tempDir, `compressed_${compressionAttempt}_${outputFilename}`);
          
          // Ajustar bitrate baseado no CRF
          let maxrate = '3M';
          let bufsize = '6M';
          if (currentCrf >= 30) {
            maxrate = '2M';
            bufsize = '4M';
          }
          if (currentCrf >= 33) {
            maxrate = '1.5M';
            bufsize = '3M';
          }
          
          const compressCommand = `ffmpeg -i "${workingPath}" \
            -c:v libx264 -preset medium -crf ${currentCrf} \
            -maxrate ${maxrate} -bufsize ${bufsize} \
            -an \
            -movflags +faststart \
            -y "${compressedPath}"`;
          
          try {
            await execAsync(compressCommand, {
              maxBuffer: 100 * 1024 * 1024,
              timeout: 900000 // 15 minutos
            });
            
            const compressedStats = await fs.stat(compressedPath);
            const newSizeMB = compressedStats.size / 1024 / 1024;
            const reductionPercent = ((1 - compressedStats.size / videoOnlyStats.size) * 100).toFixed(1);
            
            console.log(`[${projectId}] Resultado tentativa ${compressionAttempt}: ${currentSizeMB.toFixed(2)} MB → ${newSizeMB.toFixed(2)} MB (${reductionPercent}% redução total)`);
            
            // Deletar o arquivo anterior se não for o original
            if (workingPath !== videoOnlyPath) {
              await fs.unlink(workingPath);
            }
            
            workingPath = compressedPath;
            currentSizeMB = newSizeMB;
            
            // Se atingiu o objetivo, sair do loop
            if (currentSizeMB <= MAX_SIZE_MB) {
              console.log(`[${projectId}] ✅ Objetivo alcançado! Vídeo (sem áudio) está em ${currentSizeMB.toFixed(2)} MB`);
              break;
            }
            
          } catch (compressError) {
            console.error(`[${projectId}] Erro na tentativa ${compressionAttempt}:`, compressError.message);
            // Se falhar, tentar próximo CRF
            continue;
          }
        }
        
        const totalCompressTime = ((Date.now() - compressStartTime) / 1000).toFixed(2);
        const originalSizeMB = videoOnlyStats.size / 1024 / 1024;
        const finalReduction = ((1 - currentSizeMB / originalSizeMB) * 100).toFixed(1);
        
        console.log(`[${projectId}] ✅ Compressão do vídeo completa em ${totalCompressTime}s após ${compressionAttempt} tentativa(s)`);
        console.log(`[${projectId}] ${originalSizeMB.toFixed(2)} MB → ${currentSizeMB.toFixed(2)} MB (${finalReduction}% redução)`);
        
        // Verificar se ainda excede o limite
        if (currentSizeMB > MAX_SIZE_MB) {
          console.error(`[${projectId}] ⚠️ AVISO: Vídeo (sem áudio) ainda excede ${MAX_SIZE_MB}MB após ${compressionAttempt} tentativas! (${currentSizeMB.toFixed(2)} MB)`);
        }
        
        // Substituir arquivo original pelo comprimido final
        if (workingPath !== videoOnlyPath) {
          await fs.unlink(videoOnlyPath);
          await fs.rename(workingPath, videoOnlyPath);
        }
        
        videoOnlyStats = await fs.stat(videoOnlyPath);
        console.log(`[${projectId}] ✅ Vídeo (sem áudio) final pronto (${(videoOnlyStats.size / 1024 / 1024).toFixed(2)} MB)`);
      }

      // ============================================
      // ETAPA 4: ADICIONAR ÁUDIO ORIGINAL AO VÍDEO FINAL
      // ============================================
      console.log(`[${projectId}] 🎵 ETAPA 4: Adicionando áudio original concatenado ao vídeo final...`);
      
      const addAudioCommand = `ffmpeg -i "${videoOnlyPath}" -i "${finalAudioPath}" \
        -c:v copy \
        -c:a copy \
        -shortest \
        -movflags +faststart \
        -y "${outputPath}"`;
      
      await execAsync(addAudioCommand, { timeout: 180000 });
      const finalStats = await fs.stat(outputPath);
      console.log(`[${projectId}] ✅ Áudio original adicionado ao vídeo final!`);
      console.log(`[${projectId}] ✅ Vídeo final completo: ${(finalStats.size / 1024 / 1024).toFixed(2)} MB`);
      
      let outputStats = finalStats;
      
    } catch (concatError) {
      console.error(`[${projectId}] Concatenation failed:`, concatError.message);
      if (concatError.stderr) {
        console.error(`[${projectId}] FFmpeg stderr:`, concatError.stderr);
      }
      throw new Error(`Concatenation failed: ${concatError.message}`);
    }

    // Upload to Supabase Storage
    console.log(`[${projectId}] Uploading to storage...`);
    const fileBuffer = await fs.readFile(outputPath);
    
    // Use custom storagePath if provided (for batch organization), otherwise use default
    const storagePath = req.body.storagePath || `${projectId}/${outputFilename}`;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/${storagePath}`;
    
    // Try to delete if exists (for retry scenarios) - with proper error handling
    try {
      const deleteUrl = `${supabaseUrl}/storage/v1/object/videos/${storagePath}`;
      const deleteResponse = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'apikey': supabaseKey
        }
      });
      
      if (deleteResponse.ok || deleteResponse.status === 404) {
        console.log(`[${projectId}] Delete successful or file didn't exist: ${deleteResponse.status}`);
      } else {
        const deleteError = await deleteResponse.text();
        console.warn(`[${projectId}] Delete warning (${deleteResponse.status}): ${deleteError}`);
        // Continuar mesmo com warning - o upsert deve resolver
      }
    } catch (deleteError) {
      console.warn(`[${projectId}] Delete exception (continuing): ${deleteError.message}`);
    }
    
    // Upload with upsert behavior
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'apikey': supabaseKey,
        'Content-Type': 'video/mp4',
        'x-upsert': 'true'
      },
      body: fileBuffer
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error(`[${projectId}] Upload failed (${uploadResponse.status}):`, errorText);
      
      // Se for erro 409 (duplicate), tentar novamente com timestamp único
      if (uploadResponse.status === 409) {
        throw new Error(`Upload failed: ${uploadResponse.status} - Duplicate file. Retry with unique name.`);
      }
      
      throw new Error(`Upload failed: ${uploadResponse.status} - ${errorText}`);
    }

    console.log(`[${projectId}] Upload complete!`);

    // Get public URL using the actual storage path
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${storagePath}`;

    // Cleanup agressivo - remover diretório temporário
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${projectId}] Cleanup complete`);
    } catch (cleanupError) {
      console.error(`[${projectId}] Cleanup warning:`, cleanupError.message);
    }

    // Forçar garbage collection se disponível
    if (global.gc) {
      global.gc();
      console.log(`[${projectId}] Garbage collection triggered`);
    }

    res.json({
      success: true,
      url: publicUrl,
      filename: outputFilename
    });

  } catch (error) {
    console.error(`[${projectId}] Error:`, error);
    
    // Cleanup on error - CRÍTICO para não deixar lixo
    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`[${projectId}] Cleanup on error complete`);
      }
    } catch (cleanupError) {
      console.error(`[${projectId}] Cleanup error:`, cleanupError.message);
    }

    // Tentar limpar processos FFmpeg pendurados
    try {
      await execAsync('pkill -9 ffmpeg || true');
      console.log(`[${projectId}] Killed hanging FFmpeg processes`);
    } catch (killError) {
      // Ignorar erro se não houver processos para matar
    }

    res.status(500).json({
      error: 'Concatenation failed',
      details: error.message
    });
  }
});

// Compression endpoint (protected)
app.post('/compress', authenticateApiKey, async (req, res) => {
  const { 
    videoUrl, 
    outputFormat = 'mp4',
    crf = 23, 
    preset = 'medium', 
    maxBitrate = '5M',
    codec = 'libx264',
    audioCodec = 'aac',
    audioBitrate = '128k',
    // Supabase upload config
    supabaseUrl,
    supabaseKey,
    outputPath
  } = req.body;

  console.log(`🗜️ Compression request: CRF=${crf}, preset=${preset}, maxBitrate=${maxBitrate}`);

  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }

  // Validar se tem configuração para upload no Supabase
  const uploadToSupabase = supabaseUrl && supabaseKey && outputPath;

  const compressId = `compress-${Date.now()}`;
  const tempDir = path.join('/tmp', compressId);
  
  try {
    // 1. Criar diretório temporário
    await fs.mkdir(tempDir, { recursive: true });
    console.log(`[${compressId}] Created temp dir: ${tempDir}`);

    // 2. Baixar vídeo original
    const inputFile = path.join(tempDir, 'input.mp4');
    console.log(`[${compressId}] 📥 Downloading from: ${videoUrl.substring(0, 80)}...`);
    
    const downloadStartTime = Date.now();
    const response = await fetch(videoUrl, {
      redirect: 'follow',
      timeout: 600000 // 10 min
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

    // 3. Comprimir vídeo
    const outputFile = path.join(tempDir, `compressed.${outputFormat}`);
    console.log(`[${compressId}] 🗜️ Compressing with CRF=${crf}, preset=${preset}...`);
    
    const compressStartTime = Date.now();
    const compressCommand = `ffmpeg -i "${inputFile}" \
      -c:v ${codec} -preset ${preset} -crf ${crf} \
      -maxrate ${maxBitrate} -bufsize ${parseInt(maxBitrate) * 2}M \
      -c:a ${audioCodec} -b:a ${audioBitrate} \
      -ar 48000 -ac 2 \
      -af "aresample=async=1" \
      -vsync cfr \
      -async 1 \
      -fflags +genpts \
      -avoid_negative_ts make_zero \
      -movflags +faststart \
      -y "${outputFile}"`;
    
    await execAsync(compressCommand, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 900000 // 15 min
    });
    
    const compressTime = ((Date.now() - compressStartTime) / 1000).toFixed(2);
    const outputStats = await fs.stat(outputFile);
    const outputSizeMB = (outputStats.size / 1024 / 1024).toFixed(2);
    const compressionRatio = ((1 - outputStats.size / inputStats.size) * 100).toFixed(1);
    
    console.log(`[${compressId}] ✅ Compressed: ${inputSizeMB}MB → ${outputSizeMB}MB in ${compressTime}s (${compressionRatio}% reduction)`);

    // 4. Upload para Supabase ou retornar base64
    if (uploadToSupabase) {
      console.log(`[${compressId}] 📤 Uploading to Supabase: ${outputPath}`);
      
      const compressedBuffer = await fs.readFile(outputFile);
      
      const uploadResponse = await fetch(`${supabaseUrl}/storage/v1/object/videos/${outputPath}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'video/mp4',
          'x-upsert': 'false'
        },
        body: compressedBuffer
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        throw new Error(`Supabase upload failed: ${uploadResponse.status} - ${errorText}`);
      }

      console.log(`[${compressId}] ✅ Upload complete`);

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${compressId}] ✅ Cleanup complete`);

      res.json({
        success: true,
        outputPath: outputPath,
        originalSize: inputStats.size,
        compressedSize: outputStats.size,
        compressionRatio: parseFloat(compressionRatio),
        processingTime: parseFloat(compressTime)
      });

    } else {
      // Fallback: retornar como base64
      const compressedBuffer = await fs.readFile(outputFile);
      const compressedBase64 = compressedBuffer.toString('base64');

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${compressId}] ✅ Cleanup complete`);

      res.json({
        success: true,
        outputUrl: `data:video/mp4;base64,${compressedBase64}`,
        originalSize: inputStats.size,
        compressedSize: outputStats.size,
        compressionRatio: parseFloat(compressionRatio),
        processingTime: parseFloat(compressTime)
      });
    }

  } catch (error) {
    console.error(`[${compressId}] ❌ Error:`, error);
    
    // Cleanup on error
    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error(`[${compressId}] Cleanup error:`, cleanupError.message);
    }

    res.status(500).json({
      error: 'Compression failed',
      details: error.message
    });
  }
});

// Limpeza periódica de arquivos temporários (a cada 15 minutos)
setInterval(async () => {
  try {
    console.log('🧹 Running periodic cleanup...');
    const tmpDir = '/tmp';
    const files = await fs.readdir(tmpDir);
    
    let cleanedCount = 0;
    const now = Date.now();
    
    for (const file of files) {
      if (file.startsWith('project-')) {
        const filePath = path.join(tmpDir, file);
        try {
          const stats = await fs.stat(filePath);
          // Remover diretórios com mais de 1 hora
          if (now - stats.mtimeMs > 3600000) {
            await fs.rm(filePath, { recursive: true, force: true });
            cleanedCount++;
            console.log(`🗑️  Removed old temp dir: ${file}`);
          }
        } catch (err) {
          // Ignorar erros individuais
        }
      }
    }
    
    console.log(`✅ Cleanup complete: ${cleanedCount} old directories removed`);
    
    // Matar processos FFmpeg orfãos
    try {
      const { stdout } = await execAsync('pgrep ffmpeg | wc -l');
      const processCount = parseInt(stdout.trim());
      if (processCount > 5) {
        console.warn(`⚠️  Found ${processCount} FFmpeg processes, killing old ones...`);
        await execAsync('pkill -9 -f "ffmpeg.*project-"');
      }
    } catch (err) {
      // Ignorar se não houver processos
    }
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}, 15 * 60 * 1000); // A cada 15 minutos

app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Server running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`🧹 Periodic cleanup enabled (every 15 minutes)`);
});
