# Clone and enter repo
git clone https://github.com/superteam-poland-track/boreas-protocol.git
cd boreas-protocol

# Build Anchor artifacts
anchor build

# Generate deterministic program ID or read keypair
solana address -k target/deploy/boreas_escrow-keypair.json

# Fund deployer account on Devnet
solana airdrop 2 $(solana address) --url devnet

# Deploy to Devnet
anchor deploy --provider.cluster devnet