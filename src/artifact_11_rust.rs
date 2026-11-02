use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::MilestoneSubmitted;
use crate::state::{EscrowAgreement, EscrowState, ESCROW_SEED};

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), escrow.agreement_id.as_bytes()],
        bump = escrow.bump,
        constraint = escrow.contractor == contractor.key() @ EscrowError::Unauthorized
    )]
    pub escrow: Account<'info, EscrowAgreement>,
    pub contractor: Signer<'info>,
}

pub fn handler(ctx: Context<SubmitMilestone>, submission_hash: [u8; 32]) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    require!(
        escrow.state == EscrowState::Funded || escrow.state == EscrowState::Submitted,
        EscrowError::InvalidMilestoneState
    );

    let clock = Clock::get()?;
    escrow.submission_hash = submission_hash;
    escrow.state = EscrowState::Submitted;

    emit!(MilestoneSubmitted {
        agreement_key: escrow.key(),
        submission_hash,
        submitted_at: clock.unix_timestamp,
    });

    Ok(())
}