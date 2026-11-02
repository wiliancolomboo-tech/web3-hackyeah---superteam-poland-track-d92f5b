use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("Vist111111111111111111111111111111111111111");

#[program]
pub mod vistula_escrow {
    use super::*;

    /// Initializes a new B2B milestone escrow and deposits funds into the PDA vault.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_seed: u64,
        amount: u64,
        timeout_seconds: i64,
        platform_fee_bps: u16,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(platform_fee_bps <= 1000, EscrowError::FeeTooHigh); // Max 10%
        require!(timeout_seconds >= 3600, EscrowError::TimeoutTooShort); // Min 1 hour

        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        escrow.buyer = ctx.accounts.buyer.key();
        escrow.contractor = ctx.accounts.contractor.key();
        escrow.arbitrator = ctx.accounts.arbitrator.key();
        escrow.fee_recipient = ctx.accounts.fee_recipient.key();
        escrow.escrow_seed = escrow_seed;
        escrow.amount = amount;
        escrow.platform_fee_bps = platform_fee_bps;
        escrow.timeout_timestamp = clock.unix_timestamp.checked_add(timeout_seconds)
            .ok_or(EscrowError::NumericalOverflow)?;
        escrow.status = EscrowStatus::Funded;
        escrow.invoice_hash = [0u8; 32];
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        // Transfer funds from Buyer to Escrow Vault PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        emit!(EscrowInitializedEvent {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            contractor: escrow.contractor,
            amount,
            timeout_timestamp: escrow.timeout_timestamp,
        });

        Ok(())
    }

    /// Contractor submits deliverables alongside an immutable SHA-256 digest of the Polish KSeF/EU invoice.
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        invoice_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Funded, EscrowError::InvalidState);
        require!(invoice_hash != [0u8; 32], EscrowError::InvalidInvoiceHash);

        escrow.invoice_hash = invoice_hash;
        escrow.status = EscrowStatus::Submitted;

        emit!(MilestoneSubmittedEvent {
            escrow: escrow.key(),
            contractor: escrow.contractor,
            invoice_hash,
        });

        Ok(())
    }

    /// Buyer approves deliverable and releases escrow funds.
    pub fn approve_and_settle(ctx: Context<SettleEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Submitted || escrow.status == EscrowStatus::Funded,
            EscrowError::InvalidState
        );

        let vault_balance = ctx.accounts.vault.lamports();
        require!(vault_balance >= escrow.amount, EscrowError::InsufficientVaultBalance);

        let fee_amount = (escrow.amount as u128)
            .checked_mul(escrow.platform_fee_bps as u128)
            .ok_or(EscrowError::NumericalOverflow)?
            .checked_div(10000)
            .ok_or(EscrowError::NumericalOverflow)? as u64;

        let contractor_amount = escrow.amount
            .checked_sub(fee_amount)
            .ok_or(EscrowError::NumericalOverflow)?;

        // PDA Seeds for Vault CPI signing
        let buyer_key = escrow.buyer;
        let seed_bytes = escrow.escrow_seed.to_le_bytes();
        let vault_bump = escrow.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            buyer_key.as_ref(),
            seed_bytes.as_ref(),
            &[vault_bump],
        ]];

        // Disburse Platform Fee
        if fee_amount > 0 {
            let fee_cpi = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
                signer_seeds,
            );
            system_program::transfer(fee_cpi, fee_amount)?;
        }

        // Disburse Contractor Net Amount
        let contractor_cpi = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.contractor.to_account_info(),
            },
            signer_seeds,
        );
        system_program::transfer(contractor_cpi, contractor_amount)?;

        escrow.status = EscrowStatus::Settled;

        emit!(MilestoneSettledEvent {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            contractor: escrow.contractor,
            net_amount: contractor_amount,
            fee_amount,
            invoice_hash: escrow.invoice_hash,
            settled_via_timeout: false,
        });

        Ok(())
    }

    /// Contractor claims funds if SLA timeout passes without client review.
    pub fn claim_timeout_release(ctx: Context<TimeoutRelease>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(escrow.status == EscrowStatus::Submitted, EscrowError::InvalidState);
        require!(
            clock.unix_timestamp >= escrow.timeout_timestamp,
            EscrowError::TimeoutNotElapsed
        );

        let fee_amount = (escrow.amount as u128)
            .checked_mul(escrow.platform_fee_bps as u128)
            .ok_or(EscrowError::NumericalOverflow)?
            .checked_div(10000)
            .ok_or(EscrowError::NumericalOverflow)? as u64;

        let contractor_amount = escrow.amount
            .checked_sub(fee_amount)
            .ok_or(EscrowError::NumericalOverflow)?;

        let buyer_key = escrow.buyer;
        let seed_bytes = escrow.escrow_seed.to_le_bytes();
        let vault_bump = escrow.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            buyer_key.as_ref(),
            seed_bytes.as_ref(),
            &[vault_bump],
        ]];

        if fee_amount > 0 {
            let fee_cpi = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
                signer_seeds,
            );
            system_program::transfer(fee_cpi, fee_amount)?;
        }

        let contractor_cpi = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.contractor.to_account_info(),
            },
            signer_seeds,
        );
        system_program::transfer(contractor_cpi, contractor_amount)?;

        escrow.status = EscrowStatus::Settled;

        emit!(MilestoneSettledEvent {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            contractor: escrow.contractor,
            net_amount: contractor_amount,
            fee_amount,
            invoice_hash: escrow.invoice_hash,
            settled_via_timeout: true,
        });

        Ok(())
    }

    /// Raises an institutional dispute, pausing automatic timeouts and payouts.
    pub fn raise_dispute(ctx: Context<DisputeAction>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Funded || escrow.status == EscrowStatus::Submitted,
            EscrowError::InvalidState
        );
        escrow.status = EscrowStatus::Disputed;

        emit!(DisputeRaisedEvent {
            escrow: escrow.key(),
            initiator: ctx.accounts.initiator.key(),
        });
        Ok(())
    }

    /// Arbitrator resolves disputed funds by splitting lamports deterministically.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        contractor_lamports: u64,
        buyer_lamports: u64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Disputed, EscrowError::InvalidState);

        let total_lamports = contractor_lamports
            .checked_add(buyer_lamports)
            .ok_or(EscrowError::NumericalOverflow)?;
        require!(total_lamports <= escrow.amount, EscrowError::InvalidAmount);

        let buyer_key = escrow.buyer;
        let seed_bytes = escrow.escrow_seed.to_le_bytes();
        let vault_bump = escrow.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            buyer_key.as_ref(),
            seed_bytes.as_ref(),
            &[vault_bump],
        ]];

        if contractor_lamports > 0 {
            let contractor_cpi = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.contractor.to_account_info(),
                },
                signer_seeds,
            );
            system_program::transfer(contractor_cpi, contractor_lamports)?;
        }

        if buyer_lamports > 0 {
            let buyer_cpi = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer.to_account_info(),
                },
                signer_seeds,
            );
            system_program::transfer(buyer_cpi, buyer_lamports)?;
        }

        escrow.status = EscrowStatus::Settled;

        emit!(DisputeResolvedEvent {
            escrow: escrow.key(),
            contractor_lamports,
            buyer_lamports,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(escrow_seed: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Validated as designated contractor
    pub contractor: AccountInfo<'info>,

    /// CHECK: Institutional arbitrator (multisig / compliance entity)
    pub arbitrator: AccountInfo<'info>,

    /// CHECK: Protocol fee recipient account
    #[account(mut)]
    pub fee_recipient: AccountInfo<'info>,

    #[account(
        init,
        payer = buyer,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", buyer.key().as_ref(), &escrow_seed.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: PDA holding the native SOL balance
    #[account(
        mut,
        seeds = [b"vault", buyer.key().as_ref(), &escrow_seed.to_le_bytes()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(
        mut,
        has_one = contractor @ EscrowError::UnauthorizedContractor,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    pub contractor: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleEscrow<'info> {
    #[account(
        mut,
        has_one = buyer @ EscrowError::UnauthorizedBuyer,
        has_one = contractor @ EscrowError::UnauthorizedContractor,
        has_one = fee_recipient @ EscrowError::UnauthorizedFeeRecipient,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    pub buyer: Signer<'info>,

    /// CHECK: Vault checked via seeds in constraints
    #[account(
        mut,
        seeds = [b"vault", escrow.buyer.as_ref(), &escrow.escrow_seed.to_le_bytes()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Verified against escrow account
    #[account(mut)]
    pub contractor: AccountInfo<'info>,

    /// CHECK: Verified against escrow account
    #[account(mut)]
    pub fee_recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TimeoutRelease<'info> {
    #[account(
        mut,
        has_one = contractor @ EscrowError::UnauthorizedContractor,
        has_one = fee_recipient @ EscrowError::UnauthorizedFeeRecipient,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    pub contractor: Signer<'info>,

    /// CHECK: Escrow vault seeds
    #[account(
        mut,
        seeds = [b"vault", escrow.buyer.as_ref(), &escrow.escrow_seed.to_le_bytes()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Recipient of fee
    #[account(mut)]
    pub fee_recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DisputeAction<'info> {
    #[account(mut)]
    pub escrow: Account<'info, EscrowAccount>,
    pub initiator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        has_one = arbitrator @ EscrowError::UnauthorizedArbitrator,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    pub arbitrator: Signer<'info>,

    /// CHECK: Escrow vault seeds
    #[account(
        mut,
        seeds = [b"vault", escrow.buyer.as_ref(), &escrow.escrow_seed.to_le_bytes()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Verified against escrow
    #[account(mut, address = escrow.buyer)]
    pub buyer: AccountInfo<'info>,

    /// CHECK: Verified against escrow
    #[account(mut, address = escrow.contractor)]
    pub contractor: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub buyer: Pubkey,
    pub contractor: Pubkey,
    pub arbitrator: Pubkey,
    pub fee_recipient: Pubkey,
    pub escrow_seed: u64,
    pub amount: u64,
    pub platform_fee_bps: u16,
    pub timeout_timestamp: i64,
    pub invoice_hash: [u8; 32],
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Funded,
    Submitted,
    Disputed,
    Settled,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct EscrowInitializedEvent {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub contractor: Pubkey,
    pub amount: u64,
    pub timeout_timestamp: i64,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub escrow: Pubkey,
    pub contractor: Pubkey,
    pub invoice_hash: [u8; 32],
}

#[event]
pub struct MilestoneSettledEvent {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub contractor: Pubkey,
    pub net_amount: u64,
    pub fee_amount: u64,
    pub invoice_hash: [u8; 32],
    pub settled_via_timeout: bool,
}

#[event]
pub struct DisputeRaisedEvent {
    pub escrow: Pubkey,
    pub initiator: Pubkey,
}

#[event]
pub struct DisputeResolvedEvent {
    pub escrow: Pubkey,
    pub contractor_lamports: u64,
    pub buyer_lamports: u64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum EscrowError {
    #[msg("Invalid deposit amount, must be greater than zero.")]
    InvalidAmount,
    #[msg("Platform fee cannot exceed 1000 basis points (10%).")]
    FeeTooHigh,
    #[msg("Timeout period must be at least 3600 seconds (1 hour).")]
    TimeoutTooShort,
    #[msg("Arithmetic overflow detected.")]
    NumericalOverflow,
    #[msg("Invalid escrow status for this operation.")]
    InvalidState,
    #[msg("Invoice SHA-256 hash must not be zero.")]
    InvalidInvoiceHash,
    #[msg("Insufficient lamports inside vault PDA.")]
    InsufficientVaultBalance,
    #[msg("Milestone review SLA timeout has not yet elapsed.")]
    TimeoutNotElapsed,
    #[msg("Unauthorized: Signer does not match designated buyer.")]
    UnauthorizedBuyer,
    #[msg("Unauthorized: Signer does not match designated contractor.")]
    UnauthorizedContractor,
    #[msg("Unauthorized: Signer does not match designated arbitrator.")]
    UnauthorizedArbitrator,
    #[msg("Unauthorized: Fee recipient mismatch.")]
    UnauthorizedFeeRecipient,
}