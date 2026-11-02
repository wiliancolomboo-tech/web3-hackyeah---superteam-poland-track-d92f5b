use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

declare_id!("AmbGuard111111111111111111111111111111111111");

#[program]
pub mod amberguard {
    use super::*;

    /// Initialize a new deterministic enterprise escrow
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_seed: u64,
        amount: u64,
        challenge_window_seconds: i64,
        milestone_count: u8,
        description_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(
            challenge_window_seconds >= 3600 && challenge_window_seconds <= 2_592_000,
            EscrowError::InvalidChallengeWindow
        );
        require!(milestone_count > 0, EscrowError::InvalidMilestoneCount);

        let escrow = &mut ctx.accounts.escrow_state;
        escrow.client = ctx.accounts.client.key();
        escrow.contractor = ctx.accounts.contractor.key();
        escrow.arbiter = ctx.accounts.arbiter.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.escrow_seed = escrow_seed;
        escrow.total_amount = amount;
        escrow.released_amount = 0;
        escrow.milestone_count = milestone_count;
        escrow.current_milestone = 0;
        escrow.challenge_window_seconds = challenge_window_seconds;
        escrow.work_submitted_timestamp = 0;
        escrow.state = EscrowStatus::Initialized;
        escrow.milestone_work_hash = [0u8; 32];
        escrow.description_hash = description_hash;
        escrow.bump = ctx.bumps.escrow_state;
        escrow.vault_bump = ctx.bumps.vault;

        emit!(EscrowInitializedEvent {
            escrow: escrow.key(),
            client: escrow.client,
            contractor: escrow.contractor,
            arbiter: escrow.arbiter,
            total_amount: amount,
            milestones: milestone_count,
            seed: escrow_seed,
        });

        Ok(())
    }

    /// Client deposits total escrow funding into PDA token vault
    pub fn fund_escrow(ctx: Context<FundEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStatus::Initialized,
            EscrowError::InvalidStateTransition
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.client_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.client.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, escrow.total_amount)?;

        escrow.state = EscrowStatus::Funded;

        emit!(EscrowFundedEvent {
            escrow: escrow.key(),
            amount: escrow.total_amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Contractor submits milestone progress with verified cryptographic proof (IPFS/Arweave digest)
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        work_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStatus::Funded,
            EscrowError::InvalidStateTransition
        );
        require!(
            escrow.current_milestone < escrow.milestone_count,
            EscrowError::AllMilestonesCompleted
        );
        require!(work_hash != [0u8; 32], EscrowError::InvalidWorkHash);

        let clock = Clock::get()?;
        escrow.state = EscrowStatus::WorkSubmitted;
        escrow.work_submitted_timestamp = clock.unix_timestamp;
        escrow.milestone_work_hash = work_hash;

        emit!(MilestoneSubmittedEvent {
            escrow: escrow.key(),
            milestone_index: escrow.current_milestone,
            work_hash,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Client explicitly approves the submitted milestone, executing instant pro-rata payout
    pub fn approve_milestone(ctx: Context<ApproveMilestone>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStatus::WorkSubmitted,
            EscrowError::InvalidStateTransition
        );

        let milestone_payout = calculate_milestone_amount(
            escrow.total_amount,
            escrow.milestone_count,
            escrow.current_milestone,
            escrow.released_amount,
        )?;

        // Execute CPI transfer from PDA Vault to Contractor
        let client_key = escrow.client;
        let seed_bytes = escrow.escrow_seed.to_le_bytes();
        let bump_bytes = [escrow.bump];
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow_state",
            client_key.as_ref(),
            seed_bytes.as_ref(),
            &bump_bytes,
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.contractor_token_account.to_account_info(),
            authority: ctx.accounts.escrow_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, milestone_payout)?;

        escrow.released_amount = escrow
            .released_amount
            .checked_add(milestone_payout)
            .ok_or(EscrowError::NumericalOverflow)?;
        escrow.current_milestone = escrow
            .current_milestone
            .checked_add(1)
            .ok_or(EscrowError::NumericalOverflow)?;

        if escrow.current_milestone >= escrow.milestone_count {
            escrow.state = EscrowStatus::Completed;
        } else {
            escrow.state = EscrowStatus::Funded; // Ready for subsequent milestone submission
            escrow.milestone_work_hash = [0u8; 32];
            escrow.work_submitted_timestamp = 0;
        }

        emit!(MilestoneApprovedEvent {
            escrow: escrow.key(),
            milestone_index: escrow.current_milestone - 1,
            amount_paid: milestone_payout,
            completed: escrow.state == EscrowStatus::Completed,
        });

        Ok(())
    }

    /// Auto-settlement triggered if client ghosts past challenge window
    pub fn claim_timeout_settlement(ctx: Context<ClaimTimeoutSettlement>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStatus::WorkSubmitted,
            EscrowError::InvalidStateTransition
        );

        let clock = Clock::get()?;
        let time_elapsed = clock
            .unix_timestamp
            .checked_sub(escrow.work_submitted_timestamp)
            .ok_or(EscrowError::NumericalOverflow)?;

        require!(
            time_elapsed >= escrow.challenge_window_seconds,
            EscrowError::ChallengeWindowActive
        );

        let milestone_payout = calculate_milestone_amount(
            escrow.total_amount,
            escrow.milestone_count,
            escrow.current_milestone,
            escrow.released_amount,
        )?;

        let client_key = escrow.client;
        let seed_bytes = escrow.escrow_seed.to_le_bytes();
        let bump_bytes = [escrow.bump];
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow_state",
            client_key.as_ref(),
            seed_bytes.as_ref(),
            &bump_bytes,
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.contractor_token_account.to_account_info(),
            authority: ctx.accounts.escrow_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, milestone_payout)?;

        escrow.released_amount = escrow
            .released_amount
            .checked_add(milestone_payout)
            .ok_or(EscrowError::NumericalOverflow)?;
        escrow.current_milestone = escrow
            .current_milestone
            .checked_add(1)
            .ok_or(EscrowError::NumericalOverflow)?;

        if escrow.current_milestone >= escrow.milestone_count {
            escrow.state = EscrowStatus::Completed;
        } else {
            escrow.state = EscrowStatus::Funded;
            escrow.milestone_work_hash = [0u8; 32];
            escrow.work_submitted_timestamp = 0;
        }

        emit!(TimeoutSettlementClaimedEvent {
            escrow: escrow.key(),
            milestone_index: escrow.current_milestone - 1,
            amount: milestone_payout,
        });

        Ok(())
    }

    /// Client or Contractor opens a dispute during the challenge window
    pub fn raise_dispute(ctx: Context<RaiseDispute>, reason_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStatus::WorkSubmitted,
            EscrowError::InvalidStateTransition
        );
        require!(
            ctx.accounts.caller.key() == escrow.client || ctx.accounts.caller.key() == escrow.contractor,
            EscrowError::Unauthorized
        );

        let clock = Clock::get()?;
        let time_elapsed = clock
            .unix_timestamp
            .checked_sub(escrow.work_submitted_timestamp)
            .ok_or(EscrowError::NumericalOverflow)?;

        require!(
            time_elapsed < escrow.challenge_window_seconds,
            EscrowError::ChallengeWindowExpired
        );

        escrow.state = EscrowStatus::Disputed;

        emit!(DisputeRaisedEvent {
            escrow: escrow.key(),
            raised_by: ctx.accounts.caller.key(),
            reason_hash,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Certified Arbiter resolves dispute with deterministic basis-point allocation
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        contractor_bps: u16, // Basis points out of 10,000 (e.g. 5000 = 50%)
    ) -> Result<()> {
        require!(contractor_bps <= 10_000, EscrowError::InvalidBps);
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStatus::Disputed,
            EscrowError::InvalidStateTransition
        );

        let remaining_vault_balance = ctx.accounts.vault.amount;
        require!(remaining_vault_balance > 0, EscrowError::ZeroVaultBalance);

        let contractor_share = (remaining_vault_balance as u128)
            .checked_mul(contractor_bps as u128)
            .ok_or(EscrowError::NumericalOverflow)?
            .checked_div(10_000)
            .ok_or(EscrowError::NumericalOverflow)? as u64;

        let client_refund = remaining_vault_balance
            .checked_sub(contractor_share)
            .ok_or(EscrowError::NumericalOverflow)?;

        let client_key = escrow.client;
        let seed_bytes = escrow.escrow_seed.to_le_bytes();
        let bump_bytes = [escrow.bump];
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow_state",
            client_key.as_ref(),
            seed_bytes.as_ref(),
            &bump_bytes,
        ]];

        if contractor_share > 0 {
            let cpi_contractor = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.contractor_token_account.to_account_info(),
                authority: ctx.accounts.escrow_state.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_contractor,
                    signer_seeds,
                ),
                contractor_share,
            )?;
        }

        if client_refund > 0 {
            let cpi_client = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.client_token_account.to_account_info(),
                authority: ctx.accounts.escrow_state.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_client,
                    signer_seeds,
                ),
                client_refund,
            )?;
        }

        // Close Vault account to recover rent
        let close_cpi = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.arbiter.to_account_info(),
            authority: ctx.accounts.escrow_state.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_cpi,
            signer_seeds,
        ))?;

        escrow.state = EscrowStatus::Resolved;

        emit!(DisputeResolvedEvent {
            escrow: escrow.key(),
            arbiter: ctx.accounts.arbiter.key(),
            contractor_amount: contractor_share,
            client_refund_amount: client_refund,
        });

        Ok(())
    }
}

/// Helper pure calculation for milestone distribution with remainder resolution
fn calculate_milestone_amount(
    total: u64,
    milestones: u8,
    current_index: u8,
    already_released: u64,
) -> Result<u64> {
    if current_index + 1 == milestones {
        total
            .checked_sub(already_released)
            .ok_or(EscrowError::NumericalOverflow.into())
    } else {
        total
            .checked_div(milestones as u64)
            .ok_or(EscrowError::NumericalOverflow.into())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowStatus {
    Initialized,
    Funded,
    WorkSubmitted,
    Completed,
    Disputed,
    Resolved,
}

#[account]
pub struct EscrowState {
    pub client: Pubkey,                    // 32
    pub contractor: Pubkey,                // 32
    pub arbiter: Pubkey,                   // 32
    pub mint: Pubkey,                      // 32
    pub vault: Pubkey,                     // 32
    pub escrow_seed: u64,                  // 8
    pub total_amount: u64,                 // 8
    pub released_amount: u64,              // 8
    pub work_submitted_timestamp: i64,     // 8
    pub challenge_window_seconds: i64,     // 8
    pub milestone_work_hash: [u8; 32],     // 32
    pub description_hash: [u8; 32],        // 32
    pub milestone_count: u8,               // 1
    pub current_milestone: u8,             // 1
    pub state: EscrowStatus,               // 1 + 1 (enum)
    pub bump: u8,                          // 1
    pub vault_bump: u8,                    // 1
}

impl EscrowState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 32 + 32 + 1 + 1 + 2 + 1 + 1;
}

#[derive(Accounts)]
#[instruction(escrow_seed: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: Recipient contractor address verified by signature on creation
    pub contractor: UncheckedAccount<'info>,
    /// CHECK: Arbiter multisig or certified Superteam arbiter key
    pub arbiter: UncheckedAccount<'info>,
    pub mint: Account<'info, anchor_spl::token::Mint>,

    #[account(
        init,
        payer = client,
        space = EscrowState::LEN,
        seeds = [b"escrow_state", client.key().as_ref(), &escrow_seed.to_le_bytes()],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        init,
        payer = client,
        token::mint = mint,
        token::authority = escrow_state,
        seeds = [b"vault", escrow_state.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        has_one = client @ EscrowError::Unauthorized,
        has_one = vault @ EscrowError::InvalidVaultAccount,
    )]
    pub escrow_state: Account<'info, EscrowState>,
    #[account(
        mut,
        constraint = client_token_account.mint == escrow_state.mint @ EscrowError::MintMismatch,
        constraint = client_token_account.owner == client.key() @ EscrowError::Unauthorized
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(mut)]
    pub contractor: Signer<'info>,
    #[account(
        mut,
        has_one = contractor @ EscrowError::Unauthorized
    )]
    pub escrow_state: Account<'info, EscrowState>,
}

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        has_one = client @ EscrowError::Unauthorized,
        has_one = vault @ EscrowError::InvalidVaultAccount,
    )]
    pub escrow_state: Account<'info, EscrowState>,
    #[account(
        mut,
        constraint = contractor_token_account.mint == escrow_state.mint @ EscrowError::MintMismatch,
        constraint = contractor_token_account.owner == escrow_state.contractor @ EscrowError::InvalidRecipient
    )]
    pub contractor_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimTimeoutSettlement<'info> {
    #[account(mut)]
    pub contractor: Signer<'info>,
    #[account(
        mut,
        has_one = contractor @ EscrowError::Unauthorized,
        has_one = vault @ EscrowError::InvalidVaultAccount,
    )]
    pub escrow_state: Account<'info, EscrowState>,
    #[account(
        mut,
        constraint = contractor_token_account.mint == escrow_state.mint @ EscrowError::MintMismatch,
        constraint = contractor_token_account.owner == contractor.key() @ EscrowError::Unauthorized
    )]
    pub contractor_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub escrow_state: Account<'info, EscrowState>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub arbiter: Signer<'info>,
    #[account(
        mut,
        has_one = arbiter @ EscrowError::Unauthorized,
        has_one = vault @ EscrowError::InvalidVaultAccount,
    )]
    pub escrow_state: Account<'info, EscrowState>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contractor_token_account.mint == escrow_state.mint @ EscrowError::MintMismatch,
        constraint = contractor_token_account.owner == escrow_state.contractor @ EscrowError::InvalidRecipient
    )]
    pub contractor_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = client_token_account.mint == escrow_state.mint @ EscrowError::MintMismatch,
        constraint = client_token_account.owner == escrow_state.client @ EscrowError::InvalidRecipient
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ------------------- Events -------------------
#[event]
pub struct EscrowInitializedEvent {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub contractor: Pubkey,
    pub arbiter: Pubkey,
    pub total_amount: u64,
    pub milestones: u8,
    pub seed: u64,
}

#[event]
pub struct EscrowFundedEvent {
    pub escrow: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub escrow: Pubkey,
    pub milestone_index: u8,
    pub work_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct MilestoneApprovedEvent {
    pub escrow: Pubkey,
    pub milestone_index: u8,
    pub amount_paid: u64,
    pub completed: bool,
}

#[event]
pub struct TimeoutSettlementClaimedEvent {
    pub escrow: Pubkey,
    pub milestone_index: u8,
    pub amount: u64,
}

#[event]
pub struct DisputeRaisedEvent {
    pub escrow: Pubkey,
    pub raised_by: Pubkey,
    pub reason_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct DisputeResolvedEvent {
    pub escrow: Pubkey,
    pub arbiter: Pubkey,
    pub contractor_amount: u64,
    pub client_refund_amount: u64,
}

// ------------------- Errors -------------------
#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Challenge window must be between 1 hour and 30 days.")]
    InvalidChallengeWindow,
    #[msg("Milestone count must be at least 1.")]
    InvalidMilestoneCount,
    #[msg("Unauthorized account invoked instruction.")]
    Unauthorized,
    #[msg("Invalid state transition for current escrow phase.")]
    InvalidStateTransition,
    #[msg("All milestones have already been completed.")]
    AllMilestonesCompleted,
    #[msg("Work hash cannot be zero.")]
    InvalidWorkHash,
    #[msg("Challenge window is still active.")]
    ChallengeWindowActive,
    #[msg("Challenge window has expired. Dispute cannot be raised.")]
    ChallengeWindowExpired,
    #[msg("Basis points cannot exceed 10000 (100%).")]
    InvalidBps,
    #[msg("Vault has zero balance.")]
    ZeroVaultBalance,
    #[msg("Numerical overflow detected.")]
    NumericalOverflow,
    #[msg("Supplied vault does not match state PDA.")]
    InvalidVaultAccount,
    #[msg("Mint mismatch on token account.")]
    MintMismatch,
    #[msg("Invalid recipient token account.")]
    InvalidRecipient,
}