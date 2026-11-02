#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "    SolStream Sentinel - Production Anchor Deployer       "
echo "=========================================================="

export ANCHOR_WALLET="${HOME}/.config/solana/id.json"
export SOLANA_CLUSTER="${SOLANA_CLUSTER:-devnet}"

echo ">> Checking Solana CLI balance..."
solana balance --url "${SOLANA_CLUSTER}"

echo ">> Building Anchor Program (Optimized Release)..."
anchor build

PROGRAM_PUBKEY=$(solana address -k target/deploy/solstream_sentinel-keypair.json)
echo ">> Program ID generated: ${PROGRAM_PUBKEY}"

echo ">> Deploying to cluster: ${SOLANA_CLUSTER}..."
solana program deploy \
    --url "${SOLANA_CLUSTER}" \
    --program-id target/deploy/solstream_sentinel-keypair.json \
    target/deploy/solstream_sentinel.so

echo ">> Syncing Program ID into IDL and client configurations..."
sed -i "s/Sent1neL11111111111111111111111111111111111/${PROGRAM_PUBKEY}/g" programs/solstream-sentinel/src/lib.rs
sed -i "s/Sent1neL11111111111111111111111111111111111/${PROGRAM_PUBKEY}/g" client/src/config.ts

echo ">> Rebuilding IDL..."
anchor build

echo ">> Deployment completed successfully."