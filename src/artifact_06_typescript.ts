import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Amberguard } from '../target/types/amberguard';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import { expect } from 'chai';
import { Keypair, PublicKey } from '@solana/web3.js';
import crypto from 'crypto';

describe('AmberGuard Settlement Core Tests', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Amberguard as Program<Amberguard>;

  const client = Keypair.generate();
  const contractor = Keypair.generate();
  const arbiter = Keypair.generate();
  const attacker = Keypair.generate();

  let mint: PublicKey;
  let clientAta: PublicKey;
  let contractorAta: PublicKey;
  let attackerAta: PublicKey;

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;
  const escrowSeed = new anchor.BN(Date.now());
  const totalAmount = new anchor.BN(10_000_000); // 10 tokens (with 6 decimals)
  const challengeWindow = new anchor.BN(3600); // 1 hour
  const milestoneCount = 2;
  const dummyWorkHash = crypto.createHash('sha256').update('milestone_proof_v1').digest();
  const dummyDescHash = crypto.createHash('sha256').update('contract_spec_v1').digest();

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [client, contractor, arbiter, attacker]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create SPL Mint (simulating USDC/EURC)
    mint = await createMint(
      provider.connection,
      client,
      client.publicKey,
      null,
      6
    );

    // Create Token Accounts
    clientAta = await createAccount(provider.connection, client, mint, client.publicKey);
    contractorAta = await createAccount(provider.connection, client, mint, contractor.publicKey);
    attackerAta = await createAccount(provider.connection, attacker, mint, attacker.publicKey);

    // Mint funds to client
    await mintTo(provider.connection, client, mint, clientAta, client.publicKey, 50_000_000);

    // Derive Escrow State and Vault PDAs
    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('escrow_state'),
        client.publicKey.toBuffer(),
        escrowSeed.toArrayLike(Buffer, 'le', 8),
      ],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), escrowPda.toBuffer()],
      program.programId
    );
  });

  it('1. Successfully initializes the enterprise escrow PDA', async () => {
    await program.methods
      .initializeEscrow(
        escrowSeed,
        totalAmount,
        challengeWindow,
        milestoneCount,
        Array.from(dummyDescHash)
      )
      .accounts({
        client: client.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        mint: mint,
        escrowState: escrowPda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([client])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.client.toBase58()).to.equal(client.publicKey.toBase58());
    expect(escrowAccount.contractor.toBase58()).to.equal(contractor.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toNumber()).to.equal(totalAmount.toNumber());
    expect(escrowAccount.milestoneCount).to.equal(2);
    expect(escrowAccount.currentMilestone).to.equal(0);
  });

  it('2. Client funds the escrow vault successfully', async () => {
    await program.methods
      .fundEscrow()
      .accounts({
        client: client.publicKey,
        escrowState: escrowPda,
        clientTokenAccount: clientAta,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(totalAmount.toNumber());
  });

  it('3. Rejects milestone submission if not contractor (Unauthorized check)', async () => {
    try {
      await program.methods
        .submitMilestone(Array.from(dummyWorkHash))
        .accounts({
          contractor: attacker.publicKey,
          escrowState: escrowPda,
        })
        .signers([attacker])
        .rpc();
      expect.fail('Expected unauthorized submission to fail');
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.satisfy((c: string) =>
        c.includes('Unauthorized') || c.includes('ConstraintRaw') || c.includes('has_one')
      );
    }
  });

  it('4. Contractor submits Milestone 1 with cryptographic proof', async () => {
    await program.methods
      .submitMilestone(Array.from(dummyWorkHash))
      .accounts({
        contractor: contractor.publicKey,
        escrowState: escrowPda,
      })
      .signers([contractor])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(Buffer.from(escrowAccount.milestoneWorkHash)).to.deep.equal(dummyWorkHash);
  });

  it('5. Client approves Milestone 1; releases 50% pro-rata tokens to contractor', async () => {
    const preBalance = await getAccount(provider.connection, contractorAta);

    await program.methods
      .approveMilestone()
      .accounts({
        client: client.publicKey,
        escrowState: escrowPda,
        contractorTokenAccount: contractorAta,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();

    const postBalance = await getAccount(provider.connection, contractorAta);
    const difference = Number(postBalance.amount) - Number(preBalance.amount);

    expect(difference).to.equal(5_000_000); // 50% of 10M

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.currentMilestone).to.equal(1);
  });

  it('6. Milestone 2: Contractor submits work and enters dispute scenario', async () => {
    const dummyWorkHash2 = crypto.createHash('sha256').update('milestone_proof_v2').digest();
    await program.methods
      .submitMilestone(Array.from(dummyWorkHash2))
      .accounts({
        contractor: contractor.publicKey,
        escrowState: escrowPda,
      })
      .signers([contractor])
      .rpc();

    // Client raises a dispute inside challenge window
    const disputeReason = crypto.createHash('sha256').update('defective_deliverable').digest();
    await program.methods
      .raiseDispute(Array.from(disputeReason))
      .accounts({
        caller: client.publicKey,
        escrowState: escrowPda,
      })
      .signers([client])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.state).to.deep.equal({ disputed: {} });
  });

  it('7. Arbiter resolves dispute with a 60/40 balance split', async () => {
    const preContractorBalance = await getAccount(provider.connection, contractorAta);
    const preClientBalance = await getAccount(provider.connection, clientAta);

    // Arbiter grants 60% of remaining (5,000,000 * 0.60 = 3,000,000) to contractor
    // and refunds remaining 40% (2,000,000) to client
    await program.methods
      .resolveDispute(6000) // 6000 bps = 60%
      .accounts({
        arbiter: arbiter.publicKey,
        escrowState: escrowPda,
        vault: vaultPda,
        contractorTokenAccount: contractorAta,
        clientTokenAccount: clientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter])
      .rpc();

    const postContractorBalance = await getAccount(provider.connection, contractorAta);
    const postClientBalance = await getAccount(provider.connection, clientAta);

    expect(Number(postContractorBalance.amount) - Number(preContractorBalance.amount)).to.equal(3_000_000);
    expect(Number(postClientBalance.amount) - Number(preClientBalance.amount)).to.equal(2_000_000);

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.state).to.deep.equal({ resolved: {} });
  });
});