import { Command } from "commander";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as crypto from "crypto";

const program = new Command();
program.name("kopernik-cli").description("Kopernik Protocol Admin & Contractor CLI").version("1.0.0");

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

program
  .command("hash-milestone")
  .description("Generate sha256 32-byte submission hash from deliverable archive")
  .argument("<file_path>", "Path to deliverable archive or zip")
  .action((filePath: string) => {
    const fileBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(fileBuffer).digest();
    console.log("--------------------------------------------------");
    console.log("Milestone Deliverable SHA-256:");
    console.log("Hex String: ", hash.toString("hex"));
    console.log("ByteArray : ", JSON.stringify(Array.from(hash)));
    console.log("--------------------------------------------------");
  });

program
  .command("derive-vault")
  .description("Derive the canonical PDA vault for an escrow agreement")
  .requiredOption("-e, --escrow <key>", "Escrow agreement public key")
  .requiredOption("-p, --program <key>", "Kopernik program public key")
  .action((opts) => {
    const escrowPubkey = new PublicKey(opts.escrow);
    const progPubkey = new PublicKey(opts.program);

    const [vaultPda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPubkey.toBuffer()],
      progPubkey
    );

    const [authPda, authBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPubkey.toBuffer(), Buffer.from("authority")],
      progPubkey
    );

    console.log("Vault PDA Address  :", vaultPda.toBase58(), `(bump: ${bump})`);
    console.log("Vault Authority PDA:", authPda.toBase58(), `(bump: ${authBump})`);
  });

program.parse(process.argv);