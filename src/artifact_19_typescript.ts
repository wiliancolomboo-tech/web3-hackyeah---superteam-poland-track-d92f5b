import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KopernikEscrow } from "../target/types/kopernik_escrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";
import * as crypto from "crypto";

describe("kopernik-escrow unit & integration matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KopernikEscrow as Program<KopernikEscrow>;

  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const client = Keypair.generate();
  const contractor = Keypair.generate();
  const arbiter = Keypair.generate();
  const unauthorizedParty = Keypair.generate();

  let tokenMint: PublicKey;
  let clientAta: PublicKey;
  let contractorAta: PublicKey;
  let treasuryAta: PublicKey;

  const agreementId = "HACKYEAH-2024-PO-01";
  const milestoneAmount = new anchor.BN(10_000_000); // 10 token units (6 decimals)
  const feeBasisPoints = 15; // 0.15%

  let configPda: PublicKey;
  let escrowPda: PublicKey;
  let vaultPda: PublicKey;
  let vaultAuthorityPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, client, contractor, arbiter, unauthorizedParty]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize mock SPL mint (simulating USDC)
    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Setup associated accounts
    clientAta = await createAccount(provider.connection, client, tokenMint, client.publicKey);
    contractorAta = await createAccount(provider.connection, contractor, tokenMint, contractor.publicKey);
    treasuryAta = await createAccount(provider.connection, admin, tokenMint, treasury.publicKey);

    // Mint funds to client
    await mintTo(provider.connection, admin, tokenMint, clientAta, admin.publicKey, 1_000_000_000);

    // Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), client.publicKey.toBuffer(), Buffer.from(agreementId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer(), Buffer.from("authority")],
      program.programId
    );
  });

  it("1. Initializes global protocol configuration with verified fee cap", async () => {
    await program.methods
      .initializeConfig(feeBasisPoints)
      .accounts({
        admin: admin.publicKey,
        treasury: treasury.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    assert.strictEqual(configAccount.admin.toBase58(), admin.publicKey.toBase58());
    assert.strictEqual(configAccount.treasury.toBase58(), treasury.publicKey.toBase58());
    assert.strictEqual(configAccount.feeBasisPoints, feeBasisPoints);
  });

  it("2. Client initiates and funds agreement vault via PDA", async () => {
    const descHash = Array.from(crypto.createHash("sha256").update("Specification v1.0").digest());
    const timeoutSeconds = new anchor.BN(86400); // 24 hours

    await program.methods
      .initializeAgreement(agreementId, milestoneAmount, timeoutSeconds, descHash)
      .accounts({
        client: client.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        tokenMint: tokenMint,
        escrow: escrowPda,
        clientTokenAccount: clientAta,
        vaultTokenAccount: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([client])
      .rpc();

    const escrow = await program.account.escrowAgreement.fetch(escrowPda);
    assert.strictEqual(escrow.client.toBase58(), client.publicKey.toBase58());
    assert.strictEqual(escrow.contractor.toBase58(), contractor.publicKey.toBase58());
    assert.strictEqual(escrow.totalAmount.toNumber(), milestoneAmount.toNumber());

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    assert.strictEqual(Number(vaultBalance.amount), milestoneAmount.toNumber());
  });

  it("3. Contractor submits deliverable proof hash", async () => {
    const subHash = Array.from(crypto.createHash("sha256").update("github.com/superteam-poland/prs/1").digest());

    await program.methods
      .submitMilestone(subHash)
      .accounts({
        escrow: escrowPda,
        contractor: contractor.publicKey,
      })
      .signers([contractor])
      .rpc();

    const escrow = await program.account.escrowAgreement.fetch(escrowPda);
    expect(escrow.state).to.deep.equal({ submitted: {} });
    assert.deepStrictEqual(escrow.submissionHash, subHash);
  });

  it("4. Unauthorized attacker fails to approve milestone", async () => {
    try {
      await program.methods
        .approveMilestone()
        .accounts({
          escrow: escrowPda,
          client: unauthorizedParty.publicKey,
          config: configPda,
          vaultTokenAccount: vaultPda,
          vaultAuthority: vaultAuthorityPda,
          contractorTokenAccount: contractorAta,
          treasuryTokenAccount: treasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([unauthorizedParty])
        .rpc();
      assert.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      assert.include(err.toString(), "Unauthorized");
    }
  });

  it("5. Client approves milestone, triggering fee deduction and net payout", async () => {
    const initialContractorBal = await getAccount(provider.connection, contractorAta);

    await program.methods
      .approveMilestone()
      .accounts({
        escrow: escrowPda,
        client: client.publicKey,
        config: configPda,
        vaultTokenAccount: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        contractorTokenAccount: contractorAta,
        treasuryTokenAccount: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();

    const finalContractorBal = await getAccount(provider.connection, contractorAta);
    const treasuryBal = await getAccount(provider.connection, treasuryAta);

    // Fee: 10,000,000 * 15 / 10,000 = 15,000
    // Net: 9,985,000
    const expectedFee = 15_000;
    const expectedNet = 9_985_000;

    assert.strictEqual(
      Number(finalContractorBal.amount) - Number(initialContractorBal.amount),
      expectedNet
    );
    assert.strictEqual(Number(treasuryBal.amount), expectedFee);

    const escrow = await program.account.escrowAgreement.fetch(escrowPda);
    expect(escrow.state).to.deep.equal({ settled: {} });
  });

  it("6. Edge Case: Dispute & Arbiter Resolution Split", async () => {
    // Setup a 2nd agreement to validate arbitration flow
    const disputeAgreementId = "HACKYEAH-2024-DISPUTE-02";
    const [dEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), client.publicKey.toBuffer(), Buffer.from(disputeAgreementId)],
      program.programId
    );
    const [dVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), dEscrowPda.toBuffer()],
      program.programId
    );
    const [dVaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), dEscrowPda.toBuffer(), Buffer.from("authority")],
      program.programId
    );

    const descHash = Array.from(crypto.createHash("sha256").update("Disputed Project").digest());

    // 1. Initialize & Fund
    await program.methods
      .initializeAgreement(disputeAgreementId, milestoneAmount, new anchor.BN(86400), descHash)
      .accounts({
        client: client.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        tokenMint: tokenMint,
        escrow: dEscrowPda,
        clientTokenAccount: clientAta,
        vaultTokenAccount: dVaultPda,
        vaultAuthority: dVaultAuthPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([client])
      .rpc();

    // 2. Client flags dispute
    await program.methods
      .disputeMilestone()
      .accounts({
        escrow: dEscrowPda,
        signer: client.publicKey,
      })
      .signers([client])
      .rpc();

    const disputedAccount = await program.account.escrowAgreement.fetch(dEscrowPda);
    expect(disputedAccount.state).to.deep.equal({ disputed: {} });

    // 3. Arbiter awards 70% to contractor, 30% back to client
    const contractorSplitBps = 7000; // 70%
    await program.methods
      .resolveDispute(contractorSplitBps)
      .accounts({
        escrow: dEscrowPda,
        arbiter: arbiter.publicKey,
        config: configPda,
        vaultTokenAccount: dVaultPda,
        vaultAuthority: dVaultAuthPda,
        clientRecipient: client.publicKey,
        clientTokenAccount: clientAta,
        contractorTokenAccount: contractorAta,
        treasuryTokenAccount: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter])
      .rpc();

    const resolvedAccount = await program.account.escrowAgreement.fetch(dEscrowPda);
    expect(resolvedAccount.state).to.deep.equal({ settled: {} });
  });
});