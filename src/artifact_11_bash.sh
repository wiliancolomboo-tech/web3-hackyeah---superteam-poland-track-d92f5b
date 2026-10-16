# 1. Build and verify Anchor smart contract
anchor build

# 2. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --program-name boreal_escrow --provider.cluster devnet

# 3. Initialize & run integration watcher
cp .env.example .env
# Edit .env with your RESEND_API_KEY and SLACK_WEBHOOK_URL
docker compose up -d --build

# 4. View real-time telemetry streaming
docker compose logs -f boreal-daemon