use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::events::DisputeOpened;
use crate::state::{EscrowAgreement, EscrowState, ESCROW_SEED};

#[derive(Accounts)]
pub struct DisputeMilestone<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), escrow.agreement_id.as_bytes()],
        bump = escrow.bump,
        constraint = (signer.key() == escrow.client || signer.key() == escrow.contractor) @ EscrowError::Unauthorized
    )]
    pub escrow: Account<'info, EscrowAgreement>,
    pub signer: Signer<'info>,
}

pub fn handler(ctx: Context<DisputeMilestone>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    require!(
        escrow.state == EscrowState::Funded || escrow.state == EscrowState::Submitted,
        EscrowError::InvalidMilestoneState
    );

    let clock = Clock::get()?;
    escrow.state = EscrowState::Disputed;

    emit!(DisputeOpened {
        agreement_key: escrow.key(),
        disputed_by: ctx.accounts.signer.key(),
        opened_at: clock.unix_timestamp,
    });

    Ok(())
}