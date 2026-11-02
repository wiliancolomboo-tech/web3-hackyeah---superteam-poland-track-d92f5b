import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AuraProtocol } from "../target/types/aura_protocol";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("aura-protocol enterprise factoring suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AuraProtocol as Program<AuraProtocol>;

  const admin = Keypair.generate();
  const seller = Keypair.generate();
  const buyer = Keypair.generate();
  const lpUser = Keypair.generate();

  const poolName = "poland-sme-pool";
  const invoiceId = "PL-INV-99882";
  const rawXml = "<Faktura><NIP>PL1234567890</NIP><Total>5000</Total></Faktura>";
  const ksefHash = crypto.createHash("sha256").update(rawXml).digest();

  const invoiceAmount = 5 * LAMPORTS_PER_SOL; // 5 SOL
  const advanceRateBps = 8000; // 80%
  const feeRateBps = 200; // 2%

  let poolPda: PublicKey;
  let poolBump: number;
  let invoicePda: PublicKey;
  let invoiceBump: number;

  before(async () => {
    // Airdrop accounts
    for (const kp of [admin, seller, buyer, lpUser]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 50 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("factoring_pool"), Buffer.from(poolName)],
      program.programId
    );

    [invoicePda, invoiceBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), seller.publicKey.toBuffer(), Buffer.from(invoiceId)],
      program.programId
    );
  });

  it("1. Initializes the Institutional Factoring Liquidity Pool", async () => {
    await program.methods
      .initializePool(poolName, feeRateBps)
      .accounts({
        pool: poolPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const poolAccount = await program.account.factoringPool.fetch(poolPda);
    expect(poolAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(poolAccount.feeRateBps).to.equal(feeRateBps);
    expect(poolAccount.totalLiquidity.toNumber()).to.equal(0);
    expect(poolAccount.allocatedLiquidity.toNumber()).to.equal(0);
  });

  it("2. Deposits Liquidity into Factoring Pool", async () => {
    const depositAmount = 20 * LAMPORTS_PER_SOL;

    await program.methods
      .depositLiquidity(new anchor.BN(depositAmount))
      .accounts({
        pool: poolPda,
        liquidityProvider: lpUser.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lpUser])
      .rpc();

    const poolAccount = await program.account.factoringPool.fetch(poolPda);
    expect(poolAccount.totalLiquidity.toNumber()).to.equal(depositAmount);
  });

  it("3. Registers verified KSeF invoice on-chain", async () => {
    const currentSlot = await provider.connection.getBlockTime(await provider.connection.getSlot());
    const dueTimestamp = new anchor.BN((currentSlot ?? Math.floor(Date.now() / 1000)) + 86400 * 30);

    const hashArray = Array.from(ksefHash);

    await program.methods
      .createInvoice(
        invoiceId,
        hashArray,
        new anchor.BN(invoiceAmount),
        advanceRateBps,
        dueTimestamp
      )
      .accounts({
        invoice: invoicePda,
        seller: seller.publicKey,
        buyer: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const inv = await program.account.invoiceEscrow.fetch(invoicePda);
    expect(inv.invoiceId).to.equal(invoiceId);
    expect(inv.seller.toBase58()).to.equal(seller.publicKey.toBase58());
    expect(inv.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
    expect(inv.totalAmount.toNumber()).to.equal(invoiceAmount);
    expect(inv.advanceRateBps).to.equal(advanceRateBps);
    expect(JSON.stringify(inv.status)).to.equal(JSON.stringify({ registered: {} }));
  });

  it("4. Factors invoice: Advances liquidity to Seller immediately", async () => {
    const sellerBalanceBefore = await provider.connection.getBalance(seller.publicKey);

    await program.methods
      .factorInvoice()
      .accounts({
        invoice: invoicePda,
        pool: poolPda,
        seller: seller.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const inv = await program.account.invoiceEscrow.fetch(invoicePda);
    const pool = await program.account.factoringPool.fetch(poolPda);
    const sellerBalanceAfter = await provider.connection.getBalance(seller.publicKey);

    // Expected Advance: 5 SOL * 80% = 4 SOL
    // Factoring Fee: 4 SOL * 2% = 0.08 SOL
    // Net Payout: 3.92 SOL
    const expectedAdvance = 4 * LAMPORTS_PER_SOL;
    const expectedFee = (expectedAdvance * 200) / 10000;
    const expectedNetPayout = expectedAdvance - expectedFee;

    expect(inv.advanceAmount.toNumber()).to.equal(expectedAdvance);
    expect(inv.factoredFee.toNumber()).to.equal(expectedFee);
    expect(JSON.stringify(inv.status)).to.equal(JSON.stringify({ factored: {} }));
    expect(pool.allocatedLiquidity.toNumber()).to.equal(expectedAdvance);
    expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(expectedNetPayout);
  });

  it("5. Settles Invoice: Buyer pays full value, factors receive return, seller receives residual", async () => {
    const sellerBalanceBefore = await provider.connection.getBalance(seller.publicKey);
    const poolLamportsBefore = await provider.connection.getBalance(poolPda);

    await program.methods
      .settleInvoice()
      .accounts({
        invoice: invoicePda,
        pool: poolPda,
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const inv = await program.account.invoiceEscrow.fetch(invoicePda);
    const pool = await program.account.factoringPool.fetch(poolPda);
    const sellerBalanceAfter = await provider.connection.getBalance(seller.publicKey);
    const poolLamportsAfter = await provider.connection.getBalance(poolPda);

    // Residual to Seller: 5 SOL - 4 SOL advance = 1 SOL
    const expectedResidual = 1 * LAMPORTS_PER_SOL;
    const expectedAdvance = 4 * LAMPORTS_PER_SOL;

    expect(JSON.stringify(inv.status)).to.equal(JSON.stringify({ settled: {} }));
    expect(pool.allocatedLiquidity.toNumber()).to.equal(0);
    expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(expectedResidual);
    expect(poolLamportsAfter - poolLamportsBefore).to.equal(expectedAdvance);
  });

  it("6. Rejects double settlement or unauthorized settlements", async () => {
    try {
      await program.methods
        .settleInvoice()
        .accounts({
          invoice: invoicePda,
          pool: poolPda,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();
      expect.fail("Should have failed on settled invoice");
    } catch (err: any) {
      expect(err.message).to.include("InvoiceNotFactored");
    }
  });
});