# 1. Clone repository & configure secrets
git clone https://github.com/superteam-poland/vistulapay.git
cd vistulapay
cp .env.example .env

# Fill your API keys in .env:
# RESEND_API_KEY=re_123456789
# ENTERPRISE_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder

# 2. Build and verify Anchor smart contract on Solana Devnet
anchor build
anchor test --skip-local-validator

# 3. Deploy to Solana Devnet
solana program deploy target/deploy/vistula_escrow.so \
  --program-id target/deploy/vistula_escrow-keypair.json \
  --url devnet

# 4. Launch 1-Click Production Container Relay
docker-compose up --build -d

# 5. Inspect container health & live log subscription
docker logs -f vistula-relay-engine