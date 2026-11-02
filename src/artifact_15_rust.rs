use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};
use crate::errors::EscrowError;
use crate::events::TimeoutClaimed;
use crate::state::{EscrowAgreement, EscrowState, ESCROW_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), escrow.agreement_id.as_bytes()],
        bump = escrow.bump,
        constraint = (signer.key() == escrow.client || signer.key() == escrow.contractor) @ EscrowError::Unauthorized
    )]
    pub escrow: Account<'info, EscrowAgreement>,
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: Vault authority PDA
    #[account(
        seeds = [VAULT_SEED, escrow.key().as_ref(), b"authority"],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == escrow.token_mint
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// CHECK: Target recipient account for rent
    #[account(mut)]
    pub rent_destination: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimTimeout>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let clock = Clock::get()?;

    require!(clock.unix_timestamp > escrow.deadline, EscrowError::TimeoutNotReached);

    // Rule:
    // If state is Submitted and client was inactive -> contractor can claim payout
    // If state is Funded (contractor never submitted) -> client can reclaim funds
    let is_contractor = ctx.accounts.signer.key() == escrow.contractor;
    let is_client = ctx.accounts.signer.key() == escrow.client;

    let recipient_pubkey: Pubkey;
    if escrow.state == EscrowState::Submitted && is_contractor {
        require!(
            ctx.accounts.recipient_token_account.owner == escrow.contractor,
            EscrowError::Unauthorized
        );
        recipient_pubkey = escrow.contractor;
    } else if escrow.state == EscrowState::Funded && is_client {
        require!(
            ctx.accounts.recipient_token_account.owner == escrow.client,
            EscrowError::Unauthorized
        );
        recipient_pubkey = escrow.client;
    } else {
        return Err(EscrowError::InvalidMilestoneState.into());
    }

    let escrow_key = escrow.key();
    let auth_seeds = &[
        VAULT_SEED,
        escrow_key.as_ref(),
        b"authority".as_ref(),
        &[ctx.bumps.vault_authority],
    ];
    let signer = &[&auth_seeds[..]];

    let payout = escrow.total_amount;

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer,
    );
    token::transfer(transfer_ctx, payout)?;

    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault_token_account.to_account_info(),
            destination: ctx.accounts.rent_destination.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer,
    );
    token::close_account(close_ctx)?;

    escrow.state = if is_client { EscrowState::Refunded } else { EscrowState::Settled };

    emit!(TimeoutClaimed {
        agreement_key: escrow.key(),
        recipient: recipient_pubkey,
        refund_amount: payout,
    });

    Ok(())
}