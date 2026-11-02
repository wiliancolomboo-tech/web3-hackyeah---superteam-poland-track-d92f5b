use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::errors::EscrowError;
use crate::events::AgreementInitialized;
use crate::state::{EscrowAgreement, EscrowState, ESCROW_SEED, VAULT_SEED};

#[derive(Accounts)]
#[instruction(agreement_id: String)]
pub struct InitializeAgreement<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: Verified contractor account
    pub contractor: AccountInfo<'info>,
    /// CHECK: Arbiter key authorized to arbitrate disputes
    pub arbiter: AccountInfo<'info>,
    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = client,
        space = EscrowAgreement::LEN,
        seeds = [ESCROW_SEED, client.key().as_ref(), agreement_id.as_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowAgreement>,

    #[account(
        mut,
        constraint = client_token_account.owner == client.key(),
        constraint = client_token_account.mint == token_mint.key()
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = client,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = vault_authority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA authority for vault tokens
    #[account(
        seeds = [VAULT_SEED, escrow.key().as_ref(), b"authority"],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeAgreement>,
    agreement_id: String,
    amount: u64,
    timeout_seconds: i64,
    description_hash: [u8; 32],
) -> Result<()> {
    require!(agreement_id.as_bytes().len() <= 32, EscrowError::AgreementIdTooLong);
    require!(amount > 0, EscrowError::ZeroAmount);
    require!(timeout_seconds >= 3600, EscrowError::TimeoutTooShort);

    let clock = Clock::get()?;
    let deadline = clock.unix_timestamp.checked_add(timeout_seconds)
        .ok_or(EscrowError::NumericalOverflow)?;

    // Lock tokens into escrow vault PDA
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.client_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.client.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.client = ctx.accounts.client.key();
    escrow.contractor = ctx.accounts.contractor.key();
    escrow.arbiter = ctx.accounts.arbiter.key();
    escrow.token_mint = ctx.accounts.token_mint.key();
    escrow.agreement_id = agreement_id.clone();
    escrow.total_amount = amount;
    escrow.deadline = deadline;
    escrow.state = EscrowState::Funded;
    escrow.description_hash = description_hash;
    escrow.submission_hash = [0u8; 32];
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.vault_token_account;

    emit!(AgreementInitialized {
        agreement_key: escrow.key(),
        client: escrow.client,
        contractor: escrow.contractor,
        arbiter: escrow.arbiter,
        amount,
        deadline,
        agreement_id,
    });

    Ok(())
}