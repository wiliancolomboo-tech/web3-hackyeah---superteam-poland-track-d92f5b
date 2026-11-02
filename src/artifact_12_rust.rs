use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};
use crate::errors::EscrowError;
use crate::events::MilestoneApproved;
use crate::state::{EscrowAgreement, EscrowState, ProtocolConfig, CONFIG_SEED, ESCROW_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), escrow.agreement_id.as_bytes()],
        bump = escrow.bump,
        constraint = escrow.client == client.key() @ EscrowError::Unauthorized
    )]
    pub escrow: Account<'info, EscrowAgreement>,
    pub client: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: Derived PDA authority
    #[account(
        seeds = [VAULT_SEED, escrow.key().as_ref(), b"authority"],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    #[account(
        mut,
        constraint = contractor_token_account.owner == escrow.contractor,
        constraint = contractor_token_account.mint == escrow.token_mint
    )]
    pub contractor_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.owner == config.treasury,
        constraint = treasury_token_account.mint == escrow.token_mint
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ApproveMilestone>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    require!(
        escrow.state == EscrowState::Submitted || escrow.state == EscrowState::Funded,
        EscrowError::InvalidMilestoneState
    );

    let total = escrow.total_amount;
    let fee = (total as u128)
        .checked_mul(ctx.accounts.config.fee_basis_points as u128)
        .ok_or(EscrowError::NumericalOverflow)?
        .checked_div(10000)
        .ok_or(EscrowError::NumericalOverflow)? as u64;

    let net_payout = total.checked_sub(fee).ok_or(EscrowError::NumericalOverflow)?;

    let escrow_key = escrow.key();
    let auth_seeds = &[
        VAULT_SEED,
        escrow_key.as_ref(),
        b"authority".as_ref(),
        &[ctx.bumps.vault_authority],
    ];
    let signer = &[&auth_seeds[..]];

    // 1. Transfer protocol fee
    if fee > 0 {
        let fee_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer,
        );
        token::transfer(fee_ctx, fee)?;
    }

    // 2. Transfer contractor payout
    let contractor_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.contractor_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer,
    );
    token::transfer(contractor_ctx, net_payout)?;

    // 3. Close the empty vault account back to client
    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault_token_account.to_account_info(),
            destination: ctx.accounts.client.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer,
    );
    token::close_account(close_ctx)?;

    escrow.state = EscrowState::Settled;

    emit!(MilestoneApproved {
        agreement_key: escrow.key(),
        contractor: escrow.contractor,
        net_payout,
        fee_paid: fee,
    });

    Ok(())
}