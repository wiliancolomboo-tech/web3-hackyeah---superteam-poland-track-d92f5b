# Generate deliverable proof hash from deliverable file
npx ts-node agent/src/cli.ts hash-deliverable README.md

# Check RPC cluster connection & deployer wallet status
npx ts-node agent/src/cli.ts healthcheck -k ./deployer-key.json