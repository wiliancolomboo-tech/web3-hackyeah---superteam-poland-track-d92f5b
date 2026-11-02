import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import * as dotenv from "dotenv";
import { EnterpriseNotifier } from "./notify";

dotenv.config();

/**
 * Calculates SHA-256 Digest corresponding to Polish KSeF XML Document Schema.
 */
export function computeKSeFHash(rawXmlInvoice: string): Buffer {
  return crypto.createHash("sha256").update(rawXmlInvoice, "utf8").digest();
}

async function runDaemon() {
  console.log("==========================================================");
  console.log("   AURA PROTOCOL: ENTERPRISE SOLANA FACTORING DAEMON     ");
  console.log("==========================================================");

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const programId = new PublicKey(
    process.env.AURA_PROGRAM_ID || "AuRA111111111111111111111111111111111111111"
  );

  const notifier = new EnterpriseNotifier();

  console.log(`[CONNECTED] Solana RPC: ${rpcUrl}`);
  console.log(`[LISTENING] Program ID: ${programId.toBase58()}`);

  // Simulating an incoming KSeF invoice processing loop
  const sampleKSeFInvoice = `
    <Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/">
      <Naglowek KodFormularza="FA" WariantFormularza="2"/>
      <Podmiot1><DaneIdentyfikujace><NIP>5210000000</NIP></DaneIdentyfikujace></Podmiot1>
      <Podmiot2><DaneIdentyfikujace><NIP>9510000000</NIP></DaneIdentyfikujace></Podmiot2>
      <Fa><P_1>2024-10-25</P_1><P_2>INV-2024-PL-0092</P_2><P_15>150.00</P_15></Fa>
    </Faktura>
  `;

  const ksefHash = computeKSeFHash(sampleKSeFInvoice);
  console.log(`[KSeF] Canonical SHA-256: 0x${ksefHash.toString("hex")}`);

  // Subscribe to Program account changes
  connection.onProgramAccountChange(
    programId,
    async (keyedAccountInfo) => {
      const pubkey = keyedAccountInfo.accountId.toBase58();
      console.log(`[ON-CHAIN EVENT] State mutated on PDA: ${pubkey}`);

      await notifier.notifyAll({
        title: "Invoice PDA State Mutation Detected",
        invoiceId: "INV-2024-PL-0092",
        pda: pubkey,
        amountSol: 150.0,
        details: "On-chain state transitioned into settlement verification.",
      });
    },
    "confirmed"
  );

  console.log("[DAEMON RUNNING] Awaiting on-chain invoice triggers...");
}

if (require.main === module) {
  runDaemon().catch((err) => {
    console.error("[FATAL ERROR IN DAEMON]", err);
    process.exit(1);
  });
}