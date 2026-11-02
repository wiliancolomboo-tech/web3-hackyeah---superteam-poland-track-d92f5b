import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolSettle } from "../target/types/sol_settle";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import crypto from "crypto";

describe("SolSettle Enterprise Escrow Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolSettle as Program<SolSettle>;

  const payer = Keypair.generate();
  const payee = Keypair.generate();
  const arbiter = Keypair.generate();
  const attacker = Keypair.generate();

  const seed = new anchor.BN(Date.now());
  const milestoneAmounts = [
    new anchor.BN(1 * LAMPORTS_PER_SOL),
    new anchor.BN(2 * LAMPORTS_PER_SOL),
  ];
  const totalFunding = milestoneAmounts.reduce((a, b) => a.add(b), new anchor.BN(0));

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;
  let escrowBump: number;
  let vaultBump: number;

  before(async () => {
    // Airdrop funds to all actors
    for (const actor of [payer, payee, arbiter, attacker]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes the escrow and locks funds inside Vault PDA", async () => {
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now

    await program.methods
      .initializeEscrow(seed, milestoneAmounts, deadline)
      .accounts({
        payer: payer.publicKey,
        payee: payee.publicKey,
        arbiter: arbiter.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.payer.toBase58()).to.equal(payer.publicKey.toBase58());
    expect(escrowAccount.payee.toBase58()).to.equal(payee.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toNumber()).to.equal(totalFunding.toNumber());
    expect(escrowAccount.remainingBalance.toNumber()).to.equal(totalFunding.toNumber());

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(totalFunding.toNumber());
  });

  it("2. Blocks malicious actors from submitting deliverables on behalf of payee", async () => {
    const deliverableHash = Array.from(crypto.createHash("sha256").update("github.com/superteam-poland/repo").digest());

    try {
      await program.methods
        .submitMilestone(0, deliverableHash)
        .accounts({
          payee: attacker.publicKey,
          escrow: escrowPda,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Attacker should not be able to submit deliverable");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("Unauthorized");
    }
  });

  it("3. Allows Payee to submit valid deliverable digest", async () => {
    const deliverableHash = Array.from(crypto.createHash("sha256").update("commit-a3f2b18").digest());

    await program.methods
      .submitMilestone(0, deliverableHash)
      .accounts({
        payee: payee.publicKey,
        escrow: escrowPda,
      })
      .signers([payee])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.milestones[0].status).to.deep.equal({ submitted: {} });
  });

  it("4. Blocks unauthorized users from approving milestones", async () => {
    try {
      await program.methods
        .approveMilestone(0)
        .accounts({
          payer: attacker.publicKey,
          payee: payee.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Attacker should not approve milestone");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("Unauthorized");
    }
  });

  it("5. Payer approves milestone 0: releases exact tranche to Payee", async () => {
    const payeeBalanceBefore = await provider.connection.getBalance(payee.publicKey);

    await program.methods
      .approveMilestone(0)
      .accounts({
        payer: payer.publicKey,
        payee: payee.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const payeeBalanceAfter = await provider.connection.getBalance(payee.publicKey);
    expect(payeeBalanceAfter - payeeBalanceBefore).to.equal(1 * LAMPORTS_PER_SOL);

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.milestones[0].status).to.deep.equal({ approved: {} });
    expect(escrowAccount.remainingBalance.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);
  });

  it("6. Arbiter resolves dispute for milestone 1 in favor of contractor", async () => {
    // Payee submits milestone 1
    const deliverableHash = Array.from(crypto.createHash("sha256").update("commit-final-polish").digest());
    await program.methods
      .submitMilestone(1, deliverableHash)
      .accounts({
        payee: payee.publicKey,
        escrow: escrowPda,
      })
      .signers([payee])
      .rpc();

    // Arbiter executes dispute resolution
    const payeeBalanceBefore = await provider.connection.getBalance(payee.publicKey);

    await program.methods
      .resolveDispute(1, true)
      .accounts({
        arbiter: arbiter.publicKey,
        payer: payer.publicKey,
        payee: payee.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter])
      .rpc();

    const payeeBalanceAfter = await provider.connection.getBalance(payee.publicKey);
    expect(payeeBalanceAfter - payeeBalanceBefore).to.equal(2 * LAMPORTS_PER_SOL);

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.remainingBalance.toNumber()).to.equal(0);
  });

  it("7. Blocks timeout refund claim if contract balance is fully depleted", async () => {
    try {
      await program.methods
        .claimTimeoutRefund()
        .accounts({
          payer: payer.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();
      expect.fail("Cannot refund an empty escrow");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("EscrowAlreadyFullySettled");
    }
  });
});