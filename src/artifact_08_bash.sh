# 1. Setup Solana CLI configured to Devnet
solana config set --url https://api.devnet.solana.com

# 2. Generate deployment keypair if not present
solana-keygen new -o deploy-keypair.json --no-bip39-passphrase --force

# 3. Fund deployer wallet via Devnet faucet
solana airdrop 5 $(solana-keygen pubkey deploy-keypair.json)

# 4. Build program & sync program ID
anchor build
anchor keys sync

# 5. Rebuild with synced program address and deploy
anchor build
anchor deploy --provider.cluster devnet

# 6. Run comprehensive end-to-end test suite
anchor test --provider.cluster devnet