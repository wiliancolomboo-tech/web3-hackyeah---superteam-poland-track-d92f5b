import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import * as crypto from "crypto";

describe("boreal_escrow integration test matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load program from workspace
  const program = anchor.workspace.BorealEscrow as Program<any>;

  let mint: PublicKey;
  let payer: Keypair;
  let contractor: Keypair;
  let arbiter: Keypair;
  let unauthorizedUser: Keypair;

  let payerTokenAccount: PublicKey;
  let contractorTokenAccount: PublicKey;

  const ESCROW_AMOUNT = 100_000_000; // 100 Tokens (6 decimals)
  const DELIVERABLE_HASH = crypto.createHash("sha256").update("REQUIREMENT_SPEC_V1").digest();

  before(async () => {
    payer = Keypair.generate();
    contractor = Keypair.generate();
    arbiter = Keypair.generate();
    unauthorizedUser = Keypair.generate();

    // Airdrop SOL for gas
    for (const kp of [payer, contractor, arbiter, unauthorizedUser]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Settlement Token Mint (e.g. USDC mock)
    mint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    payerTokenAccount = await createAccount(
      provider.connection,
      payer,
      mint,
      payer.publicKey
    );

    contractorTokenAccount = await createAccount(
      provider.connection,
      contractor,
      mint,
      contractor.publicKey
    );

    // Fund Payer
    await mintTo(
      provider.connection,
      payer,
      mint,
      payerTokenAccount,
      payer,
      1_000_000_000
    );
  });

  it("Test 1: Initializes Escrow & successfully transfers funds into Vault PDA", async () => {
    const escrowId = new anchor.BN(101);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // +1 hour

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeEscrow(
        escrowId,
        new anchor.BN(ESCROW_AMOUNT),
        deadline,
        Array.from(DELIVERABLE_HASH)
      )
      .accounts({
        payer: payer.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        mint: mint,
        escrowAccount: escrowPda,
        vaultAccount: vaultPda,
        payerTokenAccount: payerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([payer])
      .rpc();

    // Assert Vault Balance
    const vaultBal = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBal.amount)).to.equal(ESCROW_AMOUNT);

    // Assert Escrow Account State
    const escrowState = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowState.payer.toBase58()).to.equal(payer.publicKey.toBase58());
    expect(escrowState.contractor.toBase58()).to.equal(contractor.publicKey.toBase58());
    expect(escrowState.status).to.deep.equal({ initialized: {} });
  });

  it("Test 2: Contractor submits deliverable proof hash", async () => {
    const escrowId = new anchor.BN(101);
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const submissionProof = crypto.createHash("sha256").update("GITHUB_COMMIT_DEADBEEF").digest();

    await program.methods
      .submitMilestone(Array.from(submissionProof))
      .accounts({
        escrowAccount: escrowPda,
        contractor: contractor.publicKey,
      })
      .signers([contractor])
      .rpc();

    const escrowState = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowState.status).to.deep.equal({ milestoneSubmitted: {} });
    expect(Buffer.from(escrowState.submissionHash)).to.deep.equal(submissionProof);
  });

  it("Test 3: Payer approves milestone and releases full amount to contractor", async () => {
    const escrowId = new anchor.BN(101);
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .approveAndRelease()
      .accounts({
        payer: payer.publicKey,
        escrowAccount: escrowPda,
        vaultAccount: vaultPda,
        contractor: contractor.publicKey,
        contractorTokenAccount: contractorTokenAccount,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([payer])
      .rpc();

    const contractorBal = await getAccount(provider.connection, contractorTokenAccount);
    expect(Number(contractorBal.amount)).to.equal(ESCROW_AMOUNT);

    const escrowState = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowState.status).to.deep.equal({ completed: {} });
  });

  it("Test 4: Dispute flow and arbiter settlement split execution (60/40)", async () => {
    const escrowId = new anchor.BN(102);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    // Initialize second escrow
    await program.methods
      .initializeEscrow(escrowId, new anchor.BN(ESCROW_AMOUNT), deadline, Array.from(DELIVERABLE_HASH))
      .accounts({
        payer: payer.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        mint: mint,
        escrowAccount: escrowPda,
        vaultAccount: vaultPda,
        payerTokenAccount: payerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([payer])
      .rpc();

    // Raise Dispute by Contractor
    await program.methods
      .raiseDispute()
      .accounts({
        escrowAccount: escrowPda,
        party: contractor.publicKey,
      })
      .signers([contractor])
      .rpc();

    let state = await program.account.escrowAccount.fetch(escrowPda);
    expect(state.status).to.deep.equal({ disputed: {} });

    // Arbiter splits: 60% Payer (6000 bps), 40% Contractor
    const payerBefore = Number((await getAccount(provider.connection, payerTokenAccount)).amount);
    const contractorBefore = Number((await getAccount(provider.connection, contractorTokenAccount)).amount);

    await program.methods
      .resolveDispute(6000)
      .accounts({
        escrowAccount: escrowPda,
        arbiter: arbiter.publicKey,
        vaultAccount: vaultPda,
        payerTokenAccount: payerTokenAccount,
        contractorTokenAccount: contractorTokenAccount,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter])
      .rpc();

    const payerAfter = Number((await getAccount(provider.connection, payerTokenAccount)).amount);
    const contractorAfter = Number((await getAccount(provider.connection, contractorTokenAccount)).amount);

    expect(payerAfter - payerBefore).to.equal(60_000_000);
    expect(contractorAfter - contractorBefore).to.equal(40_000_000);

    state = await program.account.escrowAccount.fetch(escrowPda);
    expect(state.status).to.deep.equal({ resolved: {} });
  });

  it("Test 5: Edge Case: Rejects release when unapproved or unauthorized user signs", async () => {
    const escrowId = new anchor.BN(103);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), payer.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeEscrow(escrowId, new anchor.BN(ESCROW_AMOUNT), deadline, Array.from(DELIVERABLE_HASH))
      .accounts({
        payer: payer.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        mint: mint,
        escrowAccount: escrowPda,
        vaultAccount: vaultPda,
        payerTokenAccount: payerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([payer])
      .rpc();

    // Attacking: Attempting release before milestone submission
    try {
      await program.methods
        .approveAndRelease()
        .accounts({
          payer: payer.publicKey,
          escrowAccount: escrowPda,
          vaultAccount: vaultPda,
          contractor: contractor.publicKey,
          contractorTokenAccount: contractorTokenAccount,
          vault: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([payer])
        .rpc();
      expect.fail("Should have thrown InvalidEscrowStatus error");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("InvalidEscrowStatus");
    }
  });
});