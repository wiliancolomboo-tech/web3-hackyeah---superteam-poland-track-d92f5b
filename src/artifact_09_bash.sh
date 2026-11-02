# 1. Generate program keypair and build
solana-keygen new -o target/deploy/ambershield-keypair.json --no-bip39-passphrase --force
anchor build

# 2. Sync program address and re-compile
anchor keys sync
anchor build

# 3. Deploy to Solana Devnet
solana airdrop 5 -u devnet
anchor deploy --provider.cluster devnet

# 4. Run test QA verification suite
anchor test --provider.cluster devnet