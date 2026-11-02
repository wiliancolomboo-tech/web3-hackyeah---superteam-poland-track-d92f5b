import http from "http";
import * as dotenv from "dotenv";
import { Keypair, PublicKey } from "@solana/web3.js";
import { GryfPayClient } from "./orchestrator";

dotenv.config();

const PORT = process.env.PORT || 8080;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "GryfPay111111111111111111111111111111111111");

async function main() {
  const daemonKey = Keypair.generate();
  const idl = require("../target/idl/gryf_pay.json");
  const client = new GryfPayClient(RPC_URL, daemonKey, PROGRAM_ID, idl);

  // Subscribe to Anchor program events
  await client.subscribeToEvents();

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", uptime: process.uptime(), network: RPC_URL }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, () => {
    console.log(`[GryfPay Operational Daemon] Service active on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("[FATAL ERROR] Daemon startup failed:", err);
  process.exit(1);
});