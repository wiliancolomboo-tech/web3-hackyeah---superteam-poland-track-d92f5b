# 1. Clone repository & install dependencies
git clone https://github.com/superteam-poland/solshield-paystream.git
cd solshield-paystream
npm install

# 2. Build the Anchor Solana Program
anchor build

# 3. Synchronize program ID and deploy to Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Initialize protocol configuration
anchor run initialize --provider.cluster devnet