# 1. Clone repository & install dependencies
git clone https://github.com/superteam-poland-hackyeah/kopernik-escrow.git
cd kopernik-escrow
yarn install

# 2. Build Anchor smart contract binary
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Execute end-to-end integration test suite
anchor test