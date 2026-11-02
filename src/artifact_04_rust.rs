use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("Vangurd11111111111111111111111111111111111");

pub const MAX_MILESTONES: usize = 10;
pub const BPS_DIVISOR: u16 = 10_000;

#[program]
pub mod sol_vanguard {
    use super::*;

    /// Initialize a new milestone escrow agreement
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        seed: u64,
        total_amount: u64,
        milestone_shares_bps: Vec<u16>,
        deadline_timestamp: i64,
    ) -> Result<()> {
        require!(
            !milestone_shares_bps.is_empty() && milestone_shares_bps.len() <= MAX_MILESTONES,
            VanguardError::InvalidMilestoneCount
        );
        require!(total_amount > 0, VanguardError::ZeroAmount);
        
        let clock = Clock::get()?;
        require!(
            deadline_timestamp > clock.unix_timestamp,
            VanguardError::InvalidDeadline
        );

        let mut sum_bps: u16 = 0;
        for &bps in milestone_shares_bps.iter() {
            require!(bps > 0, VanguardError::InvalidBpsAllocation);
            sum_bps = sum_bps
                .checked_add(bps)
                .ok_or(VanguardError::ArithmeticOverflow)?;
        }
        require!(sum_bps == BPS_DIVISOR, VanguardError::BpsSumMismatch);

        let escrow = &mut ctx.accounts.escrow;
        escrow.client = ctx.accounts.client.key();
        escrow.contractor = ctx.accounts.contractor.key();
        escrow.arbiter = ctx.accounts.arbiter.key();
        escrow.seed = seed;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;
        escrow.total_amount = total_amount;
        escrow.remaining_balance = total_amount;
        escrow.deposited_amount = 0;
        escrow.current_milestone_index = 0;
        escrow.total_milestones = milestone_shares_bps.len() as u8;
        escrow.deadline_timestamp = deadline_timestamp;
        escrow.state = EscrowState::Initialized;

        let mut milestones = [Milestone::default(); MAX_MILESTONES];
        for (idx, &bps) in milestone_shares_bps.iter().enumerate() {
            let amount = (total_amount as u128)
                .checked_mul(bps as u128)
                .ok_or(VanguardError::ArithmeticOverflow)?
                .checked_div(BPS_DIVISOR as u128)
                .ok_or(VanguardError::ArithmeticOverflow)? as u64;

            milestones[idx] = Milestone {
                shares_bps: bps,
                amount,
                status: MilestoneStatus::Pending,
            };
        }
        escrow.milestones = milestones;

        emit!(EscrowInitializedEvent {
            escrow: escrow.key(),
            client: escrow.client,
            contractor: escrow.contractor,
            arbiter: escrow.arbiter,
            total_amount,
            total_milestones: escrow.total_milestones,
            deadline_timestamp,
        });

        Ok(())
    }

    /// Deposit funds into the escrow vault PDA
    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::Initialized || escrow.state == EscrowState::Funded,
            VanguardError::InvalidState
        );
        require!(amount > 0, VanguardError::ZeroAmount);

        let required_deposit = escrow
            .total_amount
            .checked_sub(escrow.deposited_amount)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        require!(amount <= required_deposit, VanguardError::DepositExceedsTarget);

        // Perform CPI transfer to vault PDA
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.client.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(cpi_ctx, amount)?;

        escrow.deposited_amount = escrow
            .deposited_amount
            .checked_add(amount)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        if escrow.deposited_amount == escrow.total_amount {
            escrow.state = EscrowState::Funded;
        }

        emit!(FundsDepositedEvent {
            escrow: escrow.key(),
            deposited_by: ctx.accounts.client.key(),
            amount,
            total_deposited: escrow.deposited_amount,
        });

        Ok(())
    }

    /// Client marks milestone as approved and releases funds to contractor
    pub fn release_milestone(ctx: Context<ReleaseMilestone>, milestone_idx: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::Funded || escrow.state == EscrowState::PartiallyReleased,
            VanguardError::InvalidState
        );
        require!(
            milestone_idx == escrow.current_milestone_index,
            VanguardError::MilestoneSequenceViolation
        );
        require!(
            (milestone_idx as usize) < (escrow.total_milestones as usize),
            VanguardError::IndexOutOfBounds
        );

        let milestone = &mut escrow.milestones[milestone_idx as usize];
        require!(
            milestone.status == MilestoneStatus::Pending,
            VanguardError::MilestoneNotPending
        );

        let payout_amount = milestone.amount;
        require!(
            payout_amount <= escrow.remaining_balance,
            VanguardError::InsufficientVaultBalance
        );

        milestone.status = MilestoneStatus::Completed;
        escrow.remaining_balance = escrow
            .remaining_balance
            .checked_sub(payout_amount)
            .ok_or(VanguardError::ArithmeticOverflow)?;
        escrow.current_milestone_index = escrow
            .current_milestone_index
            .checked_add(1)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        if escrow.current_milestone_index == escrow.total_milestones {
            escrow.state = EscrowState::Completed;
        } else {
            escrow.state = EscrowState::PartiallyReleased;
        }

        // PDA signer seeds for vault disbursement
        let escrow_key = escrow.key();
        let seeds = &[
            b"vault",
            escrow_key.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .vault
            .to_account_info()
            .lamports()
            .checked_sub(payout_amount)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        **ctx.accounts.contractor.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .contractor
            .to_account_info()
            .lamports()
            .checked_add(payout_amount)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        emit!(MilestoneReleasedEvent {
            escrow: escrow.key(),
            milestone_index: milestone_idx,
            recipient: ctx.accounts.contractor.key(),
            amount: payout_amount,
            remaining_balance: escrow.remaining_balance,
        });

        Ok(())
    }

    /// Client or Contractor can raise a formal dispute
    pub fn raise_dispute(ctx: Context<RaiseDispute>, reason_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::Funded || escrow.state == EscrowState::PartiallyReleased,
            VanguardError::InvalidState
        );

        escrow.state = EscrowState::Disputed;

        emit!(DisputeOpenedEvent {
            escrow: escrow.key(),
            raised_by: ctx.accounts.initiator.key(),
            reason_hash,
            locked_amount: escrow.remaining_balance,
        });

        Ok(())
    }

    /// Designated Arbiter resolves dispute with percentage allocation
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        client_share_bps: u16,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Disputed, VanguardError::NotInDispute);
        require!(client_share_bps <= BPS_DIVISOR, VanguardError::InvalidBpsAllocation);

        let contractor_share_bps = BPS_DIVISOR
            .checked_sub(client_share_bps)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        let total_remaining = escrow.remaining_balance;
        let client_payout = (total_remaining as u128)
            .checked_mul(client_share_bps as u128)
            .ok_or(VanguardError::ArithmeticOverflow)?
            .checked_div(BPS_DIVISOR as u128)
            .ok_or(VanguardError::ArithmeticOverflow)? as u64;

        let contractor_payout = total_remaining
            .checked_sub(client_payout)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        escrow.remaining_balance = 0;
        escrow.state = EscrowState::Resolved;

        // Disburse lamports directly from vault
        if client_payout > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .vault
                .to_account_info()
                .lamports()
                .checked_sub(client_payout)
                .ok_or(VanguardError::ArithmeticOverflow)?;

            **ctx.accounts.client.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .client
                .to_account_info()
                .lamports()
                .checked_add(client_payout)
                .ok_or(VanguardError::ArithmeticOverflow)?;
        }

        if contractor_payout > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .vault
                .to_account_info()
                .lamports()
                .checked_sub(contractor_payout)
                .ok_or(VanguardError::ArithmeticOverflow)?;

            **ctx.accounts.contractor.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .contractor
                .to_account_info()
                .lamports()
                .checked_add(contractor_payout)
                .ok_or(VanguardError::ArithmeticOverflow)?;
        }

        emit!(DisputeResolvedEvent {
            escrow: escrow.key(),
            arbiter: ctx.accounts.arbiter.key(),
            client_payout,
            contractor_payout,
            client_share_bps,
            contractor_share_bps,
        });

        Ok(())
    }

    /// Claim refund if contract deadline has elapsed without completion and no open dispute
    pub fn claim_timeout_refund(ctx: Context<ClaimTimeoutRefund>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(
            escrow.state == EscrowState::Funded || escrow.state == EscrowState::PartiallyReleased,
            VanguardError::InvalidState
        );
        require!(
            clock.unix_timestamp > escrow.deadline_timestamp,
            VanguardError::DeadlineNotExceeded
        );

        let refundable_balance = escrow.remaining_balance;
        require!(refundable_balance > 0, VanguardError::ZeroBalance);

        escrow.remaining_balance = 0;
        escrow.state = EscrowState::Refunded;

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .vault
            .to_account_info()
            .lamports()
            .checked_sub(refundable_balance)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        **ctx.accounts.client.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .client
            .to_account_info()
            .lamports()
            .checked_add(refundable_balance)
            .ok_or(VanguardError::ArithmeticOverflow)?;

        emit!(RefundExecutedEvent {
            escrow: escrow.key(),
            recipient: ctx.accounts.client.key(),
            amount: refundable_balance,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: Recipient contractor validated by pubkey storage
    pub contractor: UncheckedAccount<'info>,
    /// CHECK: Arbiter designated authority
    pub arbiter: UncheckedAccount<'info>,
    #[account(
        init,
        payer = client,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", client.key().as_ref(), seed.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
    /// CHECK: Vault PDA holding SOL balance
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        has_one = client @ VanguardError::UnauthorizedClient,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    /// CHECK: Validated by PDA seed matching escrow
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: Recipient contractor matching escrow state
    #[account(
        mut,
        address = escrow.contractor @ VanguardError::UnauthorizedContractor
    )]
    pub contractor: SystemAccount<'info>,
    #[account(
        mut,
        has_one = client @ VanguardError::UnauthorizedClient,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    /// CHECK: PDA holding funds
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub initiator: Signer<'info>,
    #[account(
        mut,
        constraint = (initiator.key() == escrow.client || initiator.key() == escrow.contractor) @ VanguardError::UnauthorizedDisputeInitiator
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        address = escrow.arbiter @ VanguardError::UnauthorizedArbiter
    )]
    pub arbiter: Signer<'info>,
    /// CHECK: Client recipient
    #[account(mut, address = escrow.client)]
    pub client: SystemAccount<'info>,
    /// CHECK: Contractor recipient
    #[account(mut, address = escrow.contractor)]
    pub contractor: SystemAccount<'info>,
    #[account(mut)]
    pub escrow: Account<'info, EscrowAccount>,
    /// CHECK: PDA vault
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimTimeoutRefund<'info> {
    #[account(
        mut,
        address = escrow.client @ VanguardError::UnauthorizedClient
    )]
    pub client: Signer<'info>,
    #[account(mut)]
    pub escrow: Account<'info, EscrowAccount>,
    /// CHECK: PDA vault
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub client: Pubkey,
    pub contractor: Pubkey,
    pub arbiter: Pubkey,
    pub seed: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub total_amount: u64,
    pub deposited_amount: u64,
    pub remaining_balance: u64,
    pub current_milestone_index: u8,
    pub total_milestones: u8,
    pub deadline_timestamp: i64,
    pub state: EscrowState,
    pub milestones: [Milestone; MAX_MILESTONES],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
pub struct Milestone {
    pub shares_bps: u16,
    pub amount: u64,
    pub status: MilestoneStatus,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
pub enum MilestoneStatus {
    #[default]
    Pending,
    Completed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowState {
    Initialized,
    Funded,
    PartiallyReleased,
    Disputed,
    Resolved,
    Completed,
    Refunded,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct EscrowInitializedEvent {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub contractor: Pubkey,
    pub arbiter: Pubkey,
    pub total_amount: u64,
    pub total_milestones: u8,
    pub deadline_timestamp: i64,
}

#[event]
pub struct FundsDepositedEvent {
    pub escrow: Pubkey,
    pub deposited_by: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

#[event]
pub struct MilestoneReleasedEvent {
    pub escrow: Pubkey,
    pub milestone_index: u8,
    pub recipient: Pubkey,
    pub amount: u64,
    pub remaining_balance: u64,
}

#[event]
pub struct DisputeOpenedEvent {
    pub escrow: Pubkey,
    pub raised_by: Pubkey,
    pub reason_hash: [u8; 32],
    pub locked_amount: u64,
}

#[event]
pub struct DisputeResolvedEvent {
    pub escrow: Pubkey,
    pub arbiter: Pubkey,
    pub client_payout: u64,
    pub contractor_payout: u64,
    pub client_share_bps: u16,
    pub contractor_share_bps: u16,
}

#[event]
pub struct RefundExecutedEvent {
    pub escrow: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum VanguardError {
    #[msg("Invalid milestone count; must be between 1 and 10")]
    InvalidMilestoneCount,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deadline must be set in the future")]
    InvalidDeadline,
    #[msg("Invalid basis point allocation for milestone")]
    InvalidBpsAllocation,
    #[msg("Sum of milestone basis points must strictly equal 10,000 (100%)")]
    BpsSumMismatch,
    #[msg("Integer arithmetic overflow encountered")]
    ArithmeticOverflow,
    #[msg("Invalid escrow state for requested operation")]
    InvalidState,
    #[msg("Deposit amount exceeds remaining required target")]
    DepositExceedsTarget,
    #[msg("Milestones must be released sequentially")]
    MilestoneSequenceViolation,
    #[msg("Milestone index out of bounds")]
    IndexOutOfBounds,
    #[msg("Milestone is not in a pending state")]
    MilestoneNotPending,
    #[msg("Insufficient vault balance to satisfy milestone disburse")]
    InsufficientVaultBalance,
    #[msg("Contract has not entered a disputed state")]
    NotInDispute,
    #[msg("Deadline has not yet passed; cannot process refund")]
    DeadlineNotExceeded,
    #[msg("Vault balance is zero")]
    ZeroBalance,
    #[msg("Signer is not authorized client")]
    UnauthorizedClient,
    #[msg("Signer is not authorized contractor")]
    UnauthorizedContractor,
    #[msg("Signer is not authorized arbiter")]
    UnauthorizedArbiter,
    #[msg("Signer is neither client nor contractor")]
    UnauthorizedDisputeInitiator,
}