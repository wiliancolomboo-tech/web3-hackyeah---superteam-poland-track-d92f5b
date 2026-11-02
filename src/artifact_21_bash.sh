# 1. Install Solana CLI & Anchor 0.30.1
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

# 2. Configure Local/Devnet Keypair
solana-keygen new --outfile deployer-keypair.json --no-bip39-passphrase
solana config set --url https://api.devnet.solana.com --keypair ./deployer-keypair.json
solana airdrop 2

# 3. Synchronize Anchor Program ID and Build
anchor keys sync
anchor build

# 4. Deploy Program to Solana Devnet
anchor deploy --provider.cluster devnet

# 5. Run Complete Integration Suite
anchor test --provider.cluster devnet