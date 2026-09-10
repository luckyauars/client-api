#!/bin/bash
# Cloudflare Tunnel Setup
# Jalankan setelah deploy selesai

set -e

echo "========================================="
echo "  Cloudflare Tunnel Setup"
echo "========================================="

# 1. Install cloudflared
echo "[1/4] Installing cloudflared..."
if ! command -v cloudflared &> /dev/null; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflared.list
    apt update
    apt install -y cloudflared
fi
echo "cloudflared version: $(cloudflared --version)"

# 2. Login Cloudflare
echo "[2/4] Login to Cloudflare..."
echo ">>> Buka link yang muncul dan login <<<"
cloudflared tunnel login

# 3. Buat tunnel
echo "[3/4] Creating tunnel..."
TUNNEL_NAME="trader-api"
cloudflared tunnel create $TUNNEL_NAME

# 4. Setup config
echo "[4/4] Setting up config..."
TUNNEL_ID=$(cloudflared tunnel list | grep $TUNNEL_NAME | awk '{print $1}')

cat > /root/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: /root/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: api.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
EOF

echo ""
echo "========================================="
echo "  Cloudflare Tunnel Setup Selesai!"
echo "========================================="
echo ""
echo "Langkah selanjutnya:"
echo "1. Edit config: nano /root/.cloudflared/config.yml"
echo "2. Ganti 'api.yourdomain.com' dengan domain kamu"
echo "3. Tambah CNAME record di Cloudflare DNS:"
echo "   Type: CNAME"
echo "   Name: api"
echo "   Content: $TUNNEL_ID.cfargotunnel.com"
echo "   Proxy: ON"
echo "4. Start tunnel: cloudflared tunnel run $TUNNEL_NAME"
echo "5. Start API: cd /opt/trader-api && pm2 start server.js --name trader-api"
echo ""
