import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BoreasEscrow } from "../target/types/boreas_escrow";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("Project Boreas Escrow Protocol QA Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BoreasEscrow as Program<BoreasEscrow>;

  const client = Keypair.generate();
  const contractor = Keypair.generate();
  const arbitrator = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  let tokenMint: PublicKey;
  let clientTokenAccount: PublicKey;
  let contractorTokenAccount: PublicKey;

  const escrowId = new anchor.BN(9942);
  const depositAmount = new anchor.BN(10_000_000); // 10 tokens (decimals 6)
  const timelockDuration = new anchor.BN(5); // 5 seconds for rapid testing

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [client, contractor, arbitrator, unauthorizedUser]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create test SPL Mint
    tokenMint = await createMint(
      provider.connection,
      client,
      client.publicKey,
      null,
      6
    );

    // Initialize Token Accounts
    const clientAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      client,
      tokenMint,
      client.publicKey
    );
    clientTokenAccount = clientAta.address;

    const contractorAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      client,
      tokenMint,
      contractor.publicKey
    );
    contractorTokenAccount = contractorAta.address;

    // Mint tokens to client
    await mintTo(
      provider.connection,
      client,
      tokenMint,
      clientTokenAccount,
      client,
      100_000_000
    );
  });

  it("Test 1: Initialize Escrow & Lock Vault Funds", async () => {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        client.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeEscrow(escrowId, depositAmount, timelockDuration)
      .accounts({
        client: client.publicKey,
        arbitrator: arbitrator.publicKey,
        contractor: contractor.publicKey,
        tokenMint: tokenMint,
        clientTokenAccount: clientTokenAccount,
        escrowAccount: escrowPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([client])
      .rpc();

    const escrowAccountData = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccountData.escrowId.toString()).to.equal(escrowId.toString());
    expect(escrowAccountData.amount.toString()).to.equal(depositAmount.toString());
    expect(escrowAccountData.client.toBase58()).to.equal(client.publicKey.toBase58());
    expect(escrowAccountData.contractor.toBase58()).to.equal(contractor.publicKey.toBase58());
  });

  it("Test 2: Revert on Zero Amount Escrow Initialization", async () => {
    const badEscrowId = new anchor.BN(1001);
    const [badEscrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        client.publicKey.toBuffer(),
        badEscrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [badVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), badEscrowPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeEscrow(badEscrowId, new anchor.BN(0), timelockDuration)
        .accounts({
          client: client.publicKey,
          arbitrator: arbitrator.publicKey,
          contractor: contractor.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: clientTokenAccount,
          escrowAccount: badEscrowPda,
          vault: badVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();
      expect.fail("Expected transaction to fail on zero amount");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ZeroAmountDeposit");
    }
  });

  it("Test 3: Submit Milestone Delivery Hash as Contractor", async () => {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        client.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const milestoneHash = Array.from(Buffer.alloc(32, 1)); // Mock 32-byte sha256 hash

    await program.methods
      .submitMilestone(milestoneHash)
      .accounts({
        contractor: contractor.publicKey,
        escrowAccount: escrowPda,
      })
      .signers([contractor])
      .rpc();

    const escrowData = await program.account.escrowAccount.fetch(escrowPda);
    expect(JSON.stringify(escrowData.state)).to.include("milestoneSubmitted");
  });

  it("Test 4: Revert on Unauthorized Milestone Submission", async () => {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        client.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const fakeHash = Array.from(Buffer.alloc(32, 9));

    try {
      await program.methods
        .submitMilestone(fakeHash)
        .accounts({
          contractor: unauthorizedUser.publicKey,
          escrowAccount: escrowPda,
        })
        .signers([unauthorizedUser])
        .rpc();
      expect.fail("Expected failure on unauthorized submission");
    } catch (err: any) {
      expect(err.toString()).to.include("Unauthorized");
    }
  });

  it("Test 5: Client Approves Milestone and Disburses Funds", async () => {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        client.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    const balanceBefore = (
      await provider.connection.getTokenAccountBalance(contractorTokenAccount)
    ).value.amount;

    await program.methods
      .approveMilestone()
      .accounts({
        authority: client.publicKey,
        escrowAccount: escrowPda,
        vault: vaultPda,
        contractorTokenAccount: contractorTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();

    const balanceAfter = (
      await provider.connection.getTokenAccountBalance(contractorTokenAccount)
    ).value.amount;

    const delta = new anchor.BN(balanceAfter).sub(new anchor.BN(balanceBefore));
    expect(delta.toString()).to.equal(depositAmount.toString());

    const escrowData = await program.account.escrowAccount.fetch(escrowPda);
    expect(JSON.stringify(escrowData.state)).to.include("completed");
  });
});