# 1. Clone repository and install dependencies
git clone https://github.com/superteam-vistula/vistula-escrow.git
cd vistula-escrow

# 2. Configure Solana CLI for Devnet
solana config set --url https://api.devnet.solana.com

# 3. Build Anchor program & generate deterministically verified IDL
anchor build

# 4. Run full test matrix with local-validator mock
anchor test

# 5. Deploy program to Solana Devnet
solana airdrop 2
anchor deploy --provider.cluster devnet