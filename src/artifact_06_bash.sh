# 1. Install prerequisites & toolchain
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

# 2. Configure Solana Devnet
solana config set --url https://api.devnet.solana.com
solana-keygen new --no-bip39-passphrase -o ./deployer-keypair.json
solana airdrop 2 $(solana-keygen pubkey ./deployer-keypair.json)

# 3. Build & Deploy Smart Contract
anchor build
solana program deploy ./target/deploy/solkredyt.so --keypair ./deployer-keypair.json

# 4. Verify IDL upload
anchor idl init --filepath ./target/idl/solkredyt.json <DEPLOYED_PROGRAM_ID>