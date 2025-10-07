# 🎬 FFmpeg Video Concatenation Server

Servidor para concatenar vídeos usando FFmpeg e fazer upload para Supabase Storage.

## 🚀 Deploy na DigitalOcean

### Opção 1: DigitalOcean App Platform (Mais Fácil)

1. **Criar conta na DigitalOcean**
   - Acesse: https://www.digitalocean.com/
   - Crie uma conta (tem $200 de crédito grátis para novos usuários)

2. **Criar App**
   - Vá em "App Platform" → "Create App"
   - Escolha "Docker Hub" ou "Upload seu código"
   - Configure a porta: `3000`

3. **Configurar Environment Variables**
   ```
   PORT=3000
   SUPABASE_URL=https://zgadumsyjdxbfrfdvaxf.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=[sua_service_role_key]
   ```

4. **Deploy**
   - Clique em "Create Resources"
   - Aguarde o deploy (3-5 minutos)
   - Copie a URL gerada (ex: `https://your-app.ondigitalocean.app`)

### Opção 2: Droplet (VM Tradicional)

1. **Criar Droplet**
   - Basic Plan: $6/mês (1GB RAM)
   - Escolha Ubuntu 22.04
   - Selecione região mais próxima

2. **SSH no servidor**
   ```bash
   ssh root@your-droplet-ip
   ```

3. **Instalar dependências**
   ```bash
   # Atualizar sistema
   apt update && apt upgrade -y

   # Instalar Node.js
   curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
   apt install -y nodejs

   # Instalar FFmpeg
   apt install -y ffmpeg

   # Instalar PM2 (gerenciador de processos)
   npm install -g pm2
   ```

4. **Upload dos arquivos**
   ```bash
   # No seu computador, faça upload:
   scp -r ffmpeg-server root@your-droplet-ip:/root/
   ```

5. **Configurar e iniciar**
   ```bash
   cd /root/ffmpeg-server
   npm install
   
   # Configurar variáveis de ambiente
   export SUPABASE_URL="https://zgadumsyjdxbfrfdvaxf.supabase.co"
   export SUPABASE_SERVICE_ROLE_KEY="sua_service_role_key"
   
   # Iniciar com PM2
   pm2 start server.js --name ffmpeg-server
   pm2 save
   pm2 startup
   ```

6. **Configurar Firewall**
   ```bash
   ufw allow 3000
   ufw enable
   ```

### Opção 3: Docker Compose (Local ou Servidor)

1. **Criar docker-compose.yml**
   ```yaml
   version: '3.8'
   services:
     ffmpeg-server:
       build: .
       ports:
         - "3000:3000"
       environment:
         - PORT=3000
         - SUPABASE_URL=https://zgadumsyjdxbfrfdvaxf.supabase.co
         - SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key
       restart: unless-stopped
   ```

2. **Iniciar**
   ```bash
   docker-compose up -d
   ```

## 🧪 Testar o Servidor

```bash
# Health check
curl http://your-server-url/health

# Testar concatenação
curl -X POST http://your-server-url/concatenate \
  -H "Content-Type: application/json" \
  -d '{
    "videoUrls": [
      "https://url-video-1.mp4",
      "https://url-video-2.mp4",
      "https://url-video-3.mp4"
    ],
    "outputFilename": "test-output.mp4",
    "projectId": "test-123"
  }'
```

## 📊 Custos Estimados

- **DigitalOcean App Platform**: $12/mês (basic)
- **DigitalOcean Droplet**: $6/mês (1GB RAM)
- **Supabase Storage**: ~$0.021/GB armazenado

## 🔒 Segurança

⚠️ **IMPORTANTE**: Depois do deploy, adicione autenticação!

Opções:
1. API Key no header
2. IP whitelist
3. JWT tokens

## 📝 Próximos Passos

Após o deploy:
1. Copie a URL do servidor
2. Volte no Lovable
3. Adicione o secret `FFMPEG_SERVER_URL` com a URL
4. Implemente a integração!
