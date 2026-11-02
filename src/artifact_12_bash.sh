# 1. Build Solana Anchor Program
cd aura-protocol
anchor build

# 2. Deploy to Solana Devnet / Testnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 3. Initialize & Launch Enterprise Client Service
cd ../client
cp .env.example .env
npm install
npm run build
npm start