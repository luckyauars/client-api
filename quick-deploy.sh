#!/bin/bash
# Quick deploy script - jalankan dari local ke server
# Usage: ./quick-deploy.sh USER@SERVER_IP

set -e

SERVER=${1:-"root@192.168.0.201"}
REMOTE_DIR="/opt/trader-api"

echo "Deploying to $SERVER:$REMOTE_DIR"

# Buat remote directory
ssh $SERVER "mkdir -p $REMOTE_DIR"

# Copy files
scp -r \
    server.js \
    package.json \
    package-lock.json \
    prisma/ \
    Dockerfile \
    .env \
    $SERVER:$REMOTE_DIR/

# Install dependencies di server
ssh $SERVER "cd $REMOTE_DIR && npm install --production"

# Setup Prisma
ssh $SERVER "cd $REMOTE_DIR && npx prisma generate"

echo ""
echo "Deploy selesai!"
echo "Selanjutnya jalankan di server:"
echo "  cd $REMOTE_DIR"
echo "  npx prisma db push"
echo "  pm2 start server.js --name trader-api"
echo "  pm2 save"
