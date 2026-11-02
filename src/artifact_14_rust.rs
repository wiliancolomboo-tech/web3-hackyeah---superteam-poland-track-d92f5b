use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};
use crate::errors::EscrowError;
use crate::events::DisputeResolved;
use crate::state::{EscrowAgreement, EscrowState, ProtocolConfig, CONFIG_SEED, ESCROW_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), escrow.agreement_id.as_bytes()],
        bump = escrow.bump,
        constraint = escrow.arbiter == arbiter.key() @ EscrowError::Unauthorized
    )]
    pub escrow: Account<'info, EscrowAgreement>,
    pub arbiter: Signer<'info>,

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

    /// CHECK: Vault authority PDA
    #[account(
        seeds = [VAULT_SEED, escrow.key().as_ref(), b"authority"],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    /// CHECK: Arbiter receives closed rent refund or client receives it
    #[account(mut, constraint = client_recipient.key() == escrow.client)]
    pub client_recipient: AccountInfo<'info>,

    #[account(
        mut,
        constraint = client_token_account.owner == escrow.client,
        constraint = client_token_account.mint == escrow.token_mint
    )]
    pub client_token_account: Account<'info, TokenAccount>,

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

pub fn handler(ctx: Context<ResolveDispute>, contractor_basis_points: u16) -> Result<()> {
    require!(contractor_basis_points <= 10000, EscrowError::InvalidSplitBps);
    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.state == EscrowState::Disputed, EscrowError::InvalidMilestoneState);

    let total = escrow.total_amount;
    let fee = (total as u128)
        .checked_mul(ctx.accounts.config.fee_basis_points as u128)
        .ok_or(EscrowError::NumericalOverflow)?
        .checked_div(10000)
        .ok_or(EscrowError::NumericalOverflow)? as u64;

    let distributable = total.checked_sub(fee).ok_or(EscrowError::NumericalOverflow)?;
    let contractor_amount = (distributable as u128)
        .checked_mul(contractor_basis_points as u128)
        .ok_or(EscrowError::NumericalOverflow)?
        .checked_div(10000)
        .ok_or(EscrowError::NumericalOverflow)? as u64;

    let client_amount = distributable.checked_sub(contractor_amount)
        .ok_or(EscrowError::NumericalOverflow)?;

    let escrow_key = escrow.key();
    let auth_seeds = &[
        VAULT_SEED,
        escrow_key.as_ref(),
        b"authority".as_ref(),
        &[ctx.bumps.vault_authority],
    ];
    let signer = &[&auth_seeds[..]];

    // 1. Send protocol fee
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

    // 2. Transfer contractor share
    if contractor_amount > 0 {
        let c_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.contractor_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer,
        );
        token::transfer(c_ctx, contractor_amount)?;
    }

    // 3. Transfer client share
    if client_amount > 0 {
        let cl_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.client_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer,
        );
        token::transfer(cl_ctx, client_amount)?;
    }

    // 4. Close vault
    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault_token_account.to_account_info(),
            destination: ctx.accounts.client_recipient.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer,
    );
    token::close_account(close_ctx)?;

    escrow.state = EscrowState::Settled;

    emit!(DisputeResolved {
        agreement_key: escrow.key(),
        arbiter: ctx.accounts.arbiter.key(),
        contractor_amount,
        client_amount,
        fee_paid: fee,
    });

    Ok(())
}