import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolVanguard } from "../target/types/sol_vanguard";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("sol_vanguard end-to-end QA verification suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolVanguard as Program<SolVanguard>;

  let clientKeypair: Keypair;
  let contractorKeypair: Keypair;
  let arbiterKeypair: Keypair;
  let unauthorizedKeypair: Keypair;

  before(async () => {
    clientKeypair = Keypair.generate();
    contractorKeypair = Keypair.generate();
    arbiterKeypair = Keypair.generate();
    unauthorizedKeypair = Keypair.generate();

    // Airdrop funding for gas and escrow funding
    const airdropSigners = [clientKeypair, contractorKeypair, arbiterKeypair, unauthorizedKeypair];
    for (const kp of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }
  });

  it("Test 1: Initializes Escrow with valid 3-part milestone schedule", async () => {
    const seed = new anchor.BN(Date.now());
    const totalAmount = new anchor.BN(3 * LAMPORTS_PER_SOL);
    const milestoneShares = [3000, 3000, 4000]; // 30%, 30%, 40% = 10,000 bps
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400); // +24 hours

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), clientKeypair.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeEscrow(seed, totalAmount, milestoneShares, deadline)
      .accounts({
        client: clientKeypair.publicKey,
        contractor: contractorKeypair.publicKey,
        arbiter: arbiterKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([clientKeypair])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    assert.strictEqual(escrowAccount.client.toBase58(), clientKeypair.publicKey.toBase58());
    assert.strictEqual(escrowAccount.contractor.toBase58(), contractorKeypair.publicKey.toBase58());
    assert.strictEqual(escrowAccount.totalAmount.toString(), totalAmount.toString());
    assert.strictEqual(escrowAccount.totalMilestones, 3);
    assert.strictEqual(escrowAccount.currentMilestoneIndex, 0);
  });

  it("Test 2: Rejects initialization when milestone BPS sum does not equal 10,000", async () => {
    const seed = new anchor.BN(Date.now() + 100);
    const totalAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const invalidMilestones = [2000, 2000]; // 4000 != 10000 bps
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), clientKeypair.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeEscrow(seed, totalAmount, invalidMilestones, deadline)
        .accounts({
          client: clientKeypair.publicKey,
          contractor: contractorKeypair.publicKey,
          arbiter: arbiterKeypair.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([clientKeypair])
        .rpc();
      assert.fail("Should have failed with BpsSumMismatch");
    } catch (err: any) {
      expect(err.toString()).to.include("BpsSumMismatch");
    }
  });

  it("Test 3: Deposits funds into Vault and releases Milestone #0", async () => {
    const seed = new anchor.BN(999281);
    const totalAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);
    const milestoneShares = [5000, 5000]; // 50% & 50%
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), clientKeypair.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    // 1. Initialize
    await program.methods
      .initializeEscrow(seed, totalAmount, milestoneShares, deadline)
      .accounts({
        client: clientKeypair.publicKey,
        contractor: contractorKeypair.publicKey,
        arbiter: arbiterKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([clientKeypair])
      .rpc();

    // 2. Deposit full amount
    await program.methods
      .depositFunds(totalAmount)
      .accounts({
        client: clientKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([clientKeypair])
      .rpc();

    const vaultBalanceBefore = await provider.connection.getBalance(vaultPda);
    assert.strictEqual(vaultBalanceBefore, 2 * LAMPORTS_PER_SOL);

    const contractorBalanceBefore = await provider.connection.getBalance(contractorKeypair.publicKey);

    // 3. Release Milestone 0 (50% = 1 SOL)
    await program.methods
      .releaseMilestone(0)
      .accounts({
        client: clientKeypair.publicKey,
        contractor: contractorKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
      })
      .signers([clientKeypair])
      .rpc();

    const contractorBalanceAfter = await provider.connection.getBalance(contractorKeypair.publicKey);
    assert.strictEqual(contractorBalanceAfter - contractorBalanceBefore, 1 * LAMPORTS_PER_SOL);

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    assert.strictEqual(escrowAccount.currentMilestoneIndex, 1);
    assert.strictEqual(escrowAccount.remainingBalance.toNumber(), 1 * LAMPORTS_PER_SOL);
  });

  it("Test 4: Prevents unauthorized account from releasing milestone", async () => {
    const seed = new anchor.BN(1284712);
    const totalAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const milestoneShares = [10000];
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), clientKeypair.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeEscrow(seed, totalAmount, milestoneShares, deadline)
      .accounts({
        client: clientKeypair.publicKey,
        contractor: contractorKeypair.publicKey,
        arbiter: arbiterKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([clientKeypair])
      .rpc();

    await program.methods
      .depositFunds(totalAmount)
      .accounts({
        client: clientKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([clientKeypair])
      .rpc();

    try {
      await program.methods
        .releaseMilestone(0)
        .accounts({
          client: unauthorizedKeypair.publicKey,
          contractor: contractorKeypair.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
        })
        .signers([unauthorizedKeypair])
        .rpc();
      assert.fail("Should have failed with unauthorized client");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedClient");
    }
  });

  it("Test 5: Raises dispute and executes arbiter 70/30 split resolution", async () => {
    const seed = new anchor.BN(777612);
    const totalAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);
    const milestoneShares = [10000];
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), clientKeypair.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeEscrow(seed, totalAmount, milestoneShares, deadline)
      .accounts({
        client: clientKeypair.publicKey,
        contractor: contractorKeypair.publicKey,
        arbiter: arbiterKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([clientKeypair])
      .rpc();

    await program.methods
      .depositFunds(totalAmount)
      .accounts({
        client: clientKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([clientKeypair])
      .rpc();

    // Contractor raises dispute
    const reasonHash = new Array(32).fill(7);
    await program.methods
      .raiseDispute(reasonHash)
      .accounts({
        initiator: contractorKeypair.publicKey,
        escrow: escrowPda,
      })
      .signers([contractorKeypair])
      .rpc();

    // Arbiter resolves dispute: 70% to client, 30% to contractor
    const clientBalBefore = await provider.connection.getBalance(clientKeypair.publicKey);
    const contractorBalBefore = await provider.connection.getBalance(contractorKeypair.publicKey);

    await program.methods
      .resolveDispute(7000) // 7000 bps = 70%
      .accounts({
        arbiter: arbiterKeypair.publicKey,
        client: clientKeypair.publicKey,
        contractor: contractorKeypair.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
      })
      .signers([arbiterKeypair])
      .rpc();

    const clientBalAfter = await provider.connection.getBalance(clientKeypair.publicKey);
    const contractorBalAfter = await provider.connection.getBalance(contractorKeypair.publicKey);

    const expectedClientRefund = (2 * LAMPORTS_PER_SOL * 7000) / 10000;
    const expectedContractorPayout = (2 * LAMPORTS_PER_SOL * 3000) / 10000;

    assert.strictEqual(clientBalAfter - clientBalBefore, expectedClientRefund);
    assert.strictEqual(contractorBalAfter - contractorBalBefore, expectedContractorPayout);
  });
});