use anchor_lang::prelude::*;
use crate::errors::EscrowError;
use crate::state::{ProtocolConfig, CONFIG_SEED};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Safe treasury recipient
    pub treasury: AccountInfo<'info>,
    #[account(
        init,
        payer = admin,
        space = ProtocolConfig::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>, fee_basis_points: u16) -> Result<()> {
    require!(fee_basis_points <= 500, EscrowError::FeeTooHigh);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.treasury = ctx.accounts.treasury.key();
    config.fee_basis_points = fee_basis_points;
    config.bump = ctx.bumps.config;

    Ok(())
}