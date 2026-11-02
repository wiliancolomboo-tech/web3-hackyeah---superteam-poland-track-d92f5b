import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { VistulaEscrow } from "../target/types/vistula_escrow";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import * as crypto from "crypto";

describe("Vistula Escrow - End-to-End Enterprise Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.VistulaEscrow as Program<VistulaEscrow>;

  let mint: anchor.web3.PublicKey;
  let buyerTokenAccount: anchor.web3.PublicKey;
  let contractorTokenAccount: anchor.web3.PublicKey;

  const buyer = (provider.wallet as any).payer as anchor.web3.Keypair;
  const contractor = anchor.web3.Keypair.generate();
  const unauthorizedParty = anchor.web3.Keypair.generate();

  const escrowId = new BN(Date.now());
  const totalAmount = new BN(1_000_000_000); // 1,000 Tokens (6 decimals or 9 decimals)
  const slaTimeoutSeconds = new BN(3600); // 1 hour

  let escrowPda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to contractor and buyer
    const airdropSig = await provider.connection.requestAirdrop(
      contractor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create Test Mint
    mint = await createMint(
      provider.connection,
      buyer,
      buyer.publicKey,
      null,
      6
    );

    // Create Buyer Associated Token Account
    buyerTokenAccount = await createAccount(
      provider.connection,
      buyer,
      mint,
      buyer.publicKey
    );

    // Create Contractor Associated Token Account
    contractorTokenAccount = await createAccount(
      provider.connection,
      buyer,
      mint,
      contractor.publicKey
    );

    // Mint funds to Buyer
    await mintTo(
      provider.connection,
      buyer,
      mint,
      buyerTokenAccount,
      buyer,
      5_000_000_000
    );

    // Calculate PDAs
    const [derivedEscrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        buyer.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    escrowPda = derivedEscrowPda;

    const [derivedVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );
    vaultPda = derivedVaultPda;
  });

  it("1. Successfully initializes an enterprise escrow contract & locks funds into PDA vault", async () => {
    const buyerInitialBalance = (await getAccount(provider.connection, buyerTokenAccount)).amount;

    await program.methods
      .initializeEscrow(
        escrowId,
        totalAmount,
        slaTimeoutSeconds,
        "Frontend & Solana Program Security Audit Milestone"
      )
      .accounts({
        buyer: buyer.publicKey,
        contractor: contractor.publicKey,
        mint: mint,
        escrowAccount: escrowPda,
        vaultAccount: vaultPda,
        buyerTokenAccount: buyerTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // Verify On-Chain State
    const escrowState = await program.account.escrowAccount.fetch(escrowPda);
    assert.isTrue(escrowState.buyer.equals(buyer.publicKey));
    assert.isTrue(escrowState.contractor.equals(contractor.publicKey));
    assert.equal(escrowState.amount.toString(), totalAmount.toString());
    assert.equal(escrowState.remainingBalance.toString(), totalAmount.toString());
    assert.deepEqual(escrowState.state, { funded: {} });

    // Verify Vault Token Balance
    const vaultBalance = (await getAccount(provider.connection, vaultPda)).amount;
    assert.equal(vaultBalance.toString(), totalAmount.toString());

    // Verify Buyer Token Deduction
    const buyerAfterBalance = (await getAccount(provider.connection, buyerTokenAccount)).amount;
    assert.equal(buyerInitialBalance - buyerAfterBalance, BigInt(totalAmount.toString()));
  });

  it("2. Fails when an unauthorized third-party attempts to submit deliverables", async () => {
    const fakeDeliverableHash = Array.from(crypto.createHash("sha256").update("codebase-v1").digest());

    try {
      await program.methods
        .submitMilestone(fakeDeliverableHash)
        .accounts({
          escrowAccount: escrowPda,
          contractor: unauthorizedParty.publicKey,
        } as any)
        .signers([unauthorizedParty])
        .rpc();
      assert.fail("Should have reverted on unauthorized contractor submission");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedContractor");
    }
  });

  it("3. Contractor submits deliverable digest with valid SHA-256 fingerprint", async () => {
    const deliverableData = "https://github.com/vistula-protocol/core/commit/9f8c2e1a";
    const deliverableHash = Array.from(crypto.createHash("sha256").update(deliverableData).digest());

    await program.methods
      .submitMilestone(deliverableHash)
      .accounts({
        escrowAccount: escrowPda,
        contractor: contractor.publicKey,
      } as any)
      .signers([contractor])
      .rpc();

    const escrowState = await program.account.escrowAccount.fetch(escrowPda);
    assert.deepEqual(escrowState.state, { submitted: {} });
    assert.deepEqual(escrowState.deliverableHash, deliverableHash);
    assert.isAbove(escrowState.submissionTimestamp.toNumber(), 0);
  });

  it("4. Fails when contractor attempts to claim timeout before SLA window elapses", async () => {
    try {
      await program.methods
        .claimTimeout()
        .accounts({
          escrowAccount: escrowPda,
          contractor: contractor.publicKey,
          vaultAccount: vaultPda,
          contractorTokenAccount: contractorTokenAccount,
          vault: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([contractor])
        .rpc();
      assert.fail("Should have failed because SLA window has not expired");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlaNotExpired");
    }
  });

  it("5. Buyer approves milestone deliverable and releases funds to Contractor", async () => {
    const contractorInitialBalance = (await getAccount(provider.connection, contractorTokenAccount)).amount;

    await program.methods
      .approveMilestone()
      .accounts({
        escrowAccount: escrowPda,
        buyer: buyer.publicKey,
        vaultAccount: vaultPda,
        contractorTokenAccount: contractorTokenAccount,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    // Verify On-Chain State transition
    const escrowState = await program.account.escrowAccount.fetch(escrowPda);
    assert.deepEqual(escrowState.state, { completed: {} });
    assert.equal(escrowState.remainingBalance.toNumber(), 0);

    // Verify Contractor Balance Increased
    const contractorFinalBalance = (await getAccount(provider.connection, contractorTokenAccount)).amount;
    assert.equal(contractorFinalBalance - contractorInitialBalance, BigInt(totalAmount.toString()));

    // Verify Vault is drained
    const vaultBalance = (await getAccount(provider.connection, vaultPda)).amount;
    assert.equal(vaultBalance.toString(), "0");
  });

  it("6. Edge Case: Dispute lifecycle prevents fund drain", async () => {
    const disputeEscrowId = new BN(Date.now() + 100);
    const [disputeEscrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        buyer.publicKey.toBuffer(),
        disputeEscrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [disputeVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), disputeEscrowPda.toBuffer()],
      program.programId
    );

    // Initialize second contract
    await program.methods
      .initializeEscrow(disputeEscrowId, totalAmount, slaTimeoutSeconds, "Deliverable with flaw")
      .accounts({
        buyer: buyer.publicKey,
        contractor: contractor.publicKey,
        mint: mint,
        escrowAccount: disputeEscrowPda,
        vaultAccount: disputeVaultPda,
        buyerTokenAccount: buyerTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // Submit milestone
    const fakeHash = Array.from(crypto.createHash("sha256").update("bad-deliverable").digest());
    await program.methods
      .submitMilestone(fakeHash)
      .accounts({
        escrowAccount: disputeEscrowPda,
        contractor: contractor.publicKey,
      } as any)
      .signers([contractor])
      .rpc();

    // Buyer disputes milestone
    const reasonDigest = Array.from(crypto.createHash("sha256").update("Fails integration specs").digest());
    await program.methods
      .disputeMilestone(reasonDigest)
      .accounts({
        escrowAccount: disputeEscrowPda,
        buyer: buyer.publicKey,
      } as any)
      .rpc();

    const disputedState = await program.account.escrowAccount.fetch(disputeEscrowPda);
    assert.deepEqual(disputedState.state, { disputed: {} });

    // Ensure Contractor cannot claim timeout during dispute
    try {
      await program.methods
        .claimTimeout()
        .accounts({
          escrowAccount: disputeEscrowPda,
          contractor: contractor.publicKey,
          vaultAccount: disputeVaultPda,
          contractorTokenAccount: contractorTokenAccount,
          vault: disputeVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([contractor])
        .rpc();
      assert.fail("Should not allow claim_timeout while under DISPUTED state");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidState");
    }
  });
});