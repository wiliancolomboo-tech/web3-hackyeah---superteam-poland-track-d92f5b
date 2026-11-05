# 1. Clone repository and install dependencies
git clone https://github.com/superteam-poland/krok-protocol.git
cd krok-protocol
npm install

# 2. Build Anchor Smart Contracts
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 5. Execute QA Test Matrix (Local validator / Devnet)
anchor test

# 6. Configure Daemon Environment Variables
cat <<EOF > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_WSS_URL=wss://api.devnet.solana.com
PROGRAM_ID=$(solana address -k target/deploy/krok_protocol-keypair.json)
RESEND_API_KEY=re_test_000000000000000000000000
RESEND_FROM_EMAIL=notifications@krok-protocol.dev
ENTERPRISE_PAYER_EMAIL=cfo@superteam.fun
DISCORD_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
EOF

# 7. Launch Turnkey Infrastructure via Docker Compose
docker compose up -d --build
docker compose logs -f krok-daemon