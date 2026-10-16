import { Command } from "commander";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";

const program = new Command();

program
  .name("boreal-cli")
  .description("Administrative CLI for Boreal Solana Escrow Protocol")
  .version("1.0.0");

program
  .command("hash-milestone")
  .description("Generates a deterministic SHA-256 deliverable payload hash")
  .argument("<payloadPathOrString>", "Milestone specification or deliverable string")
  .action((input: string) => {
    const hash = crypto.createHash("sha256").update(input).digest();
    console.log(`[Boreal-CLI] Milestone String: "${input}"`);
    console.log(`[Boreal-CLI] Output Hex: 0x${hash.toString("hex")}`);
    console.log(`[Boreal-CLI] Rust Array: [${Array.from(hash).join(", ")}]`);
  });

program
  .command("derive-addresses")
  .description("Derives Escrow PDA and Vault PDA addresses")
  .requiredOption("-p, --program-id <key>", "Boreal Program ID")
  .requiredOption("-a, --payer <key>", "Payer Public Key")
  .requiredOption("-i, --escrow-id <number>", "Escrow ID integer")
  .action((opts: { programId: string; payer: string; escrowId: string }) => {
    const programId = new PublicKey(opts.programId);
    const payerPk = new PublicKey(opts.payer);
    const escrowIdBn = Buffer.alloc(8);
    escrowIdBn.writeBigUInt64LE(BigInt(opts.escrowId));

    const [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payerPk.toBuffer(), escrowIdBn],
      programId
    );

    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      programId
    );

    console.log(`Escrow PDA:  ${escrowPda.toBase58()} (bump: ${escrowBump})`);
    console.log(`Vault PDA:   ${vaultPda.toBase58()} (bump: ${vaultBump})`);
  });

program.parse(process.argv);