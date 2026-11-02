# 1. Clone & Build Solana Anchor Program
git clone https://github.com/superteam-poland/amberguard.git
cd amberguard
anchor build

# 2. Deploy to Solana Devnet
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet

# 3. Configure and Launch Daemon
cd daemon
cp .env.example .env
npm install
npm run build
npm start