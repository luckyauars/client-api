#!/bin/bash
# aaPanel Deployment Script
# Jalankan sebagai root di aaPanel client

set -e

echo "========================================="
echo "  Trader API Deployment"
echo "========================================="

# 1. Install Node.js 20
echo "[1/7] Installing Node.js 20..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "Node.js version: $(node -v)"
echo "NPM version: $(npm -v)"

# 2. Install dependencies untuk Puppeteer
echo "[2/7] Installing system dependencies..."
apt-get update
apt-get install -y \
    chromium-browser \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    fonts-liberation \
    libxss1 \
    --no-install-recommends

# 3. Buat project directory (nama folder biasa saja)
echo "[3/7] Creating project directory..."
mkdir -p /opt/trader-api
cd /opt/trader-api

# 4. Copy files (jalankan dari local ke server)
echo "[4/7] Copy files..."
echo ">>> Upload files via SCP atau aaPanel File Manager <<<"
echo ">>> Upload ke /opt/trader-api/ <<<"

# 5. Install npm packages
echo "[5/7] Installing npm packages..."
npm install

# 6. Setup environment variables
echo "[6/7] Setting environment variables..."
cat > .env << 'EOF'
PORT=3000
TF_EMAIL=sikatbror@gmail.com
TF_PASSWORD=jayapura
DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/railway
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
EOF

echo ">>> EDIT .env FILE DENGAN DATABASE_URL YANG BENAR <<<"

# 7. Install PM2
echo "[7/7] Installing PM2..."
npm install -g pm2

echo ""
echo "========================================="
echo "  Deployment Selesai!"
echo "========================================="
echo ""
echo "Langkah selanjutnya:"
echo "1. Edit .env file: nano /opt/trader-api/.env"
echo "2. Jalankan: cd /opt/trader-api && npx prisma db push"
echo "3. Start server: pm2 start server.js --name trader-api"
echo "4. Save PM2: pm2 save"
echo "5. Setup Cloudflare Tunnel: ./setup-cloudflared.sh"
echo ""
