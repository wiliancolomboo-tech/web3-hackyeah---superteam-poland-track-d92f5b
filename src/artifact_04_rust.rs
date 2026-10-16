use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("BoreAL1111111111111111111111111111111111111");

#[program]
pub mod boreal_escrow {
    use super::*;

    /// Initializes an enterprise milestone escrow and deposits milestone funds into PDA vault.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_id: u64,
        amount: u64,
        deadline_timestamp: i64,
        deliverable_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        let clock = Clock::get()?;
        require!(
            deadline_timestamp > clock.unix_timestamp,
            EscrowError::InvalidDeadline
        );

        let escrow = &mut ctx.accounts.escrow_account;
        escrow.escrow_id = escrow_id;
        escrow.payer = ctx.accounts.payer.key();
        escrow.contractor = ctx.accounts.contractor.key();
        escrow.arbiter = ctx.accounts.arbiter.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault = ctx.accounts.vault_account.key();
        escrow.amount = amount;
        escrow.deadline_timestamp = deadline_timestamp;
        escrow.deliverable_hash = deliverable_hash;
        escrow.submission_hash = [0u8; 32];
        escrow.status = EscrowStatus::Initialized;
        escrow.bump = ctx.bumps.escrow_account;
        escrow.vault_bump = ctx.bumps.vault_account;
        escrow.created_at = clock.unix_timestamp;

        // Transfer funds from payer to PDA vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.vault_account.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(EscrowInitializedEvent {
            escrow_id,
            payer: escrow.payer,
            contractor: escrow.contractor,
            arbiter: escrow.arbiter,
            amount,
            deadline: deadline_timestamp,
        });

        Ok(())
    }

    /// Contractor submits work milestone along with proof hash (e.g. SHA-256 / IPFS CID hash)
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        submission_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(
            escrow.status == EscrowStatus::Initialized,
            EscrowError::InvalidEscrowStatus
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp <= escrow.deadline_timestamp,
            EscrowError::DeadlinePassed
        );

        escrow.submission_hash = submission_hash;
        escrow.status = EscrowStatus::MilestoneSubmitted;

        emit!(MilestoneSubmittedEvent {
            escrow_id: escrow.escrow_id,
            submission_hash,
            submitted_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Payer verifies and releases escrow funds to contractor upon milestone satisfaction
    pub fn approve_and_release(ctx: Context<ApproveAndRelease>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(
            escrow.status == EscrowStatus::MilestoneSubmitted,
            EscrowError::InvalidEscrowStatus
        );

        let total_amount = ctx.accounts.vault_account.amount;
        require!(total_amount > 0, EscrowError::InsufficientVaultFunds);

        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds = &[
            b"escrow".as_ref(),
            escrow.payer.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_account.to_account_info(),
            to: ctx.accounts.contractor_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, total_amount)?;

        escrow.status = EscrowStatus::Completed;

        emit!(FundsReleasedEvent {
            escrow_id: escrow.escrow_id,
            contractor: escrow.contractor,
            amount: total_amount,
            completed_at: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Either party can raise a dispute before completion
    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(
            escrow.status == EscrowStatus::Initialized
                || escrow.status == EscrowStatus::MilestoneSubmitted,
            EscrowError::DisputeNotAllowed
        );

        let signer = ctx.accounts.party.key();
        require!(
            signer == escrow.payer || signer == escrow.contractor,
            EscrowError::Unauthorized
        );

        escrow.status = EscrowStatus::Disputed;

        emit!(DisputeRaisedEvent {
            escrow_id: escrow.escrow_id,
            raised_by: signer,
            disputed_at: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Designated Arbiter resolves dispute by splitting funds according to basis points (bps)
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        payer_split_bps: u16,
    ) -> Result<()> {
        require!(payer_split_bps <= 10000, EscrowError::InvalidBasisPoints);
        let escrow = &mut ctx.accounts.escrow_account;
        require!(
            escrow.status == EscrowStatus::Disputed,
            EscrowError::InvalidEscrowStatus
        );

        let total_vault_funds = ctx.accounts.vault_account.amount;
        let payer_amount = (total_vault_funds as u128)
            .checked_mul(payer_split_bps as u128)
            .unwrap()
            .checked_div(10000)
            .unwrap() as u64;
        let contractor_amount = total_vault_funds.checked_sub(payer_amount).unwrap();

        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds = &[
            b"escrow".as_ref(),
            escrow.payer.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_program = ctx.accounts.token_program.to_account_info();

        if payer_amount > 0 {
            let payer_cpi = Transfer {
                from: ctx.accounts.vault_account.to_account_info(),
                to: ctx.accounts.payer_token_account.to_account_info(),
                authority: escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(cpi_program.clone(), payer_cpi, signer),
                payer_amount,
            )?;
        }

        if contractor_amount > 0 {
            let contractor_cpi = Transfer {
                from: ctx.accounts.vault_account.to_account_info(),
                to: ctx.accounts.contractor_token_account.to_account_info(),
                authority: escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(cpi_program, contractor_cpi, signer),
                contractor_amount,
            )?;
        }

        escrow.status = EscrowStatus::Resolved;

        emit!(DisputeResolvedEvent {
            escrow_id: escrow.escrow_id,
            payer_amount,
            contractor_amount,
            resolved_at: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Payer claims complete refund if milestone was never submitted and deadline has lapsed
    pub fn claim_timeout_refund(ctx: Context<ClaimTimeoutRefund>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_account;
        require!(
            escrow.status == EscrowStatus::Initialized,
            EscrowError::InvalidEscrowStatus
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp > escrow.deadline_timestamp,
            EscrowError::DeadlineNotPassed
        );

        let total_vault_funds = ctx.accounts.vault_account.amount;
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds = &[
            b"escrow".as_ref(),
            escrow.payer.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_account.to_account_info(),
            to: ctx.accounts.payer_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
            total_vault_funds,
        )?;

        escrow.status = EscrowStatus::Refunded;

        emit!(TimeoutRefundedEvent {
            escrow_id: escrow.escrow_id,
            payer: escrow.payer,
            amount: total_vault_funds,
            refunded_at: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Validated as designated recipient in escrow state
    pub contractor: AccountInfo<'info>,

    /// CHECK: Independent arbiter
    pub arbiter: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", payer.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    #[account(
        init,
        payer = payer,
        seeds = [b"vault", escrow_account.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow_account,
    )]
    pub vault_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = payer_token_account.owner == payer.key(),
        constraint = payer_token_account.mint == mint.key()
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(
        mut,
        has_one = contractor @ EscrowError::Unauthorized,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    pub contractor: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveAndRelease<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        has_one = payer @ EscrowError::Unauthorized,
        has_one = vault @ EscrowError::InvalidVault,
        has_one = contractor @ EscrowError::InvalidContractor,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,

    /// CHECK: Account ownership validated against escrow definition
    pub contractor: AccountInfo<'info>,

    #[account(
        mut,
        constraint = contractor_token_account.owner == escrow_account.contractor,
        constraint = contractor_token_account.mint == escrow_account.mint,
    )]
    pub contractor_token_account: Account<'info, TokenAccount>,

    pub vault: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub escrow_account: Account<'info, EscrowAccount>,
    pub party: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        has_one = arbiter @ EscrowError::Unauthorized,
        has_one = vault @ EscrowError::InvalidVault,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    pub arbiter: Signer<'info>,

    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = payer_token_account.owner == escrow_account.payer,
        constraint = payer_token_account.mint == escrow_account.mint,
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = contractor_token_account.owner == escrow_account.contractor,
        constraint = contractor_token_account.mint == escrow_account.mint,
    )]
    pub contractor_token_account: Account<'info, TokenAccount>,

    pub vault: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimTimeoutRefund<'info> {
    #[account(
        mut,
        has_one = payer @ EscrowError::Unauthorized,
        has_one = vault @ EscrowError::InvalidVault,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    pub payer: Signer<'info>,

    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = payer_token_account.owner == escrow_account.payer,
        constraint = payer_token_account.mint == escrow_account.mint,
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    pub vault: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTURES & ENUMS
// -----------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Initialized,
    MilestoneSubmitted,
    Completed,
    Disputed,
    Resolved,
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub escrow_id: u64,
    pub payer: Pubkey,
    pub contractor: Pubkey,
    pub arbiter: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub deadline_timestamp: i64,
    pub deliverable_hash: [u8; 32],
    pub submission_hash: [u8; 32],
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
    pub created_at: i64,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct EscrowInitializedEvent {
    pub escrow_id: u64,
    pub payer: Pubkey,
    pub contractor: Pubkey,
    pub arbiter: Pubkey,
    pub amount: u64,
    pub deadline: i64,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub escrow_id: u64,
    pub submission_hash: [u8; 32],
    pub submitted_at: i64,
}

#[event]
pub struct FundsReleasedEvent {
    pub escrow_id: u64,
    pub contractor: Pubkey,
    pub amount: u64,
    pub completed_at: i64,
}

#[event]
pub struct DisputeRaisedEvent {
    pub escrow_id: u64,
    pub raised_by: Pubkey,
    pub disputed_at: i64,
}

#[event]
pub struct DisputeResolvedEvent {
    pub escrow_id: u64,
    pub payer_amount: u64,
    pub contractor_amount: u64,
    pub resolved_at: i64,
}

#[event]
pub struct TimeoutRefundedEvent {
    pub escrow_id: u64,
    pub payer: Pubkey,
    pub amount: u64,
    pub refunded_at: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum EscrowError {
    #[msg("Escrow amount must be strictly greater than zero.")]
    InvalidAmount,
    #[msg("Deadline must be configured to a future timestamp.")]
    InvalidDeadline,
    #[msg("Current escrow status does not permit this operation.")]
    InvalidEscrowStatus,
    #[msg("Milestone deadline has already lapsed.")]
    DeadlinePassed,
    #[msg("Milestone deadline has not yet elapsed.")]
    DeadlineNotPassed,
    #[msg("Unauthorized signer for this escrow instruction.")]
    Unauthorized,
    #[msg("Insufficient balance available in vault.")]
    InsufficientVaultFunds,
    #[msg("Dispute is only permissible prior to completion or cancellation.")]
    DisputeNotAllowed,
    #[msg("Basis points parameter must be between 0 and 10000.")]
    InvalidBasisPoints,
    #[msg("Provided token vault does not match escrow parameters.")]
    InvalidVault,
    #[msg("Provided contractor account does not match escrow parameters.")]
    InvalidContractor,
}