use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("AuRA111111111111111111111111111111111111111");

pub const MAX_INVOICE_ID_LEN: usize = 32;
pub const BASIS_POINTS_DIVISOR: u64 = 10_000;

#[program]
pub mod aura_protocol {
    use super::*;

    /// Initializes an institutional factoring liquidity pool.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        pool_name: String,
        fee_rate_bps: u16,
    ) -> Result<()> {
        require!(pool_name.len() <= 32, AuraError::InvalidStringLength);
        require!(fee_rate_bps <= 1000, AuraError::ExcessiveFeeRate); // Max 10% fee

        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.total_liquidity = 0;
        pool.allocated_liquidity = 0;
        pool.fee_rate_bps = fee_rate_bps;
        pool.bump = ctx.bumps.pool;
        pool.name = pool_name;

        emit!(PoolInitialized {
            pool: pool.key(),
            admin: pool.admin,
            fee_rate_bps,
        });

        Ok(())
    }

    /// Liquidity Providers deposit funds into the factoring pool.
    pub fn deposit_liquidity(ctx: Context<DepositLiquidity>, amount: u64) -> Result<()> {
        require!(amount > 0, AuraError::InvalidAmount);

        // Transfer funds from LP to Pool PDA vault
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.liquidity_provider.to_account_info(),
                to: ctx.accounts.pool.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        let pool = &mut ctx.accounts.pool;
        pool.total_liquidity = pool
            .total_liquidity
            .checked_add(amount)
            .ok_or(AuraError::ArithmeticOverflow)?;

        emit!(LiquidityDeposited {
            pool: pool.key(),
            provider: ctx.accounts.liquidity_provider.key(),
            amount,
        });

        Ok(())
    }

    /// Seller anchors an e-invoice (e.g. Polish KSeF FA_VAT) by SHA-256 hash and sets payment terms.
    pub fn create_invoice(
        ctx: Context<CreateInvoice>,
        invoice_id: String,
        ksef_hash: [u8; 32],
        total_amount: u64,
        advance_rate_bps: u16,
        due_timestamp: i64,
    ) -> Result<()> {
        require!(
            !invoice_id.is_empty() && invoice_id.len() <= MAX_INVOICE_ID_LEN,
            AuraError::InvalidStringLength
        );
        require!(total_amount > 0, AuraError::InvalidAmount);
        require!(
            advance_rate_bps > 0 && advance_rate_bps <= 9000,
            AuraError::InvalidAdvanceRate
        ); // Up to 90%
        
        let clock = Clock::get()?;
        require!(
            due_timestamp > clock.unix_timestamp,
            AuraError::InvalidDueDate
        );

        let invoice = &mut ctx.accounts.invoice;
        invoice.seller = ctx.accounts.seller.key();
        invoice.buyer = ctx.accounts.buyer.key();
        invoice.invoice_id = invoice_id.clone();
        invoice.ksef_hash = ksef_hash;
        invoice.total_amount = total_amount;
        invoice.advance_rate_bps = advance_rate_bps;
        invoice.due_timestamp = due_timestamp;
        invoice.advance_amount = 0;
        invoice.factored_fee = 0;
        invoice.factor = Pubkey::default();
        invoice.status = InvoiceStatus::Registered;
        invoice.bump = ctx.bumps.invoice;

        emit!(InvoiceCreated {
            invoice_pda: invoice.key(),
            seller: invoice.seller,
            buyer: invoice.buyer,
            invoice_id,
            total_amount,
            ksef_hash,
            due_timestamp,
        });

        Ok(())
    }

    /// Factoring Pool advances liquid capital to the Seller against the registered invoice.
    pub fn factor_invoice(ctx: Context<FactorInvoice>) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        let pool = &mut ctx.accounts.pool;

        require!(
            invoice.status == InvoiceStatus::Registered,
            AuraError::InvoiceNotEligible
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < invoice.due_timestamp,
            AuraError::InvoiceExpired
        );

        // Advance calculation: total_amount * advance_rate_bps / 10000
        let advance_amount = (invoice.total_amount as u128)
            .checked_mul(invoice.advance_rate_bps as u128)
            .ok_or(AuraError::ArithmeticOverflow)?
            .checked_div(BASIS_POINTS_DIVISOR as u128)
            .ok_or(AuraError::ArithmeticOverflow)? as u64;

        // Factoring fee calculation: advance_amount * pool.fee_rate_bps / 10000
        let factoring_fee = (advance_amount as u128)
            .checked_mul(pool.fee_rate_bps as u128)
            .ok_or(AuraError::ArithmeticOverflow)?
            .checked_div(BASIS_POINTS_DIVISOR as u128)
            .ok_or(AuraError::ArithmeticOverflow)? as u64;

        let net_payout = advance_amount
            .checked_sub(factoring_fee)
            .ok_or(AuraError::ArithmeticUnderflow)?;

        // Ensure pool has sufficient unallocated liquidity
        let available_liquidity = pool
            .total_liquidity
            .checked_sub(pool.allocated_liquidity)
            .ok_or(AuraError::ArithmeticUnderflow)?;
        require!(
            available_liquidity >= advance_amount,
            AuraError::InsufficientPoolLiquidity
        );

        // Update pool states
        pool.allocated_liquidity = pool
            .allocated_liquidity
            .checked_add(advance_amount)
            .ok_or(AuraError::ArithmeticOverflow)?;

        // Payout to Seller directly from Pool PDA
        **pool.to_account_info().try_borrow_mut_lamports()? = pool
            .to_account_info()
            .lamports()
            .checked_sub(net_payout)
            .ok_or(AuraError::ArithmeticUnderflow)?;

        **ctx.accounts.seller.try_borrow_mut_lamports()? = ctx
            .accounts.seller
            .lamports()
            .checked_add(net_payout)
            .ok_or(AuraError::ArithmeticOverflow)?;

        // Update Invoice status
        invoice.status = InvoiceStatus::Factored;
        invoice.factor = pool.key();
        invoice.advance_amount = advance_amount;
        invoice.factored_fee = factoring_fee;

        emit!(InvoiceFactored {
            invoice_pda: invoice.key(),
            factor: pool.key(),
            net_payout,
            advance_amount,
            factoring_fee,
        });

        Ok(())
    }

    /// Buyer settles the invoice in full. Protocol repays the Factoring Pool and remits the residual to Seller.
    pub fn settle_invoice(ctx: Context<SettleInvoice>) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        let pool = &mut ctx.accounts.pool;

        require!(
            invoice.status == InvoiceStatus::Factored,
            AuraError::InvoiceNotFactored
        );
        require!(
            ctx.accounts.buyer.key() == invoice.buyer,
            AuraError::UnauthorizedBuyer
        );

        let total_due = invoice.total_amount;
        let advance_amount = invoice.advance_amount;
        let residual_amount = total_due
            .checked_sub(advance_amount)
            .ok_or(AuraError::ArithmeticUnderflow)?;

        // 1. Buyer pays full amount into pool & seller accounts
        // Transfer advance + fee back to the pool
        let cpi_to_pool = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: pool.to_account_info(),
            },
        );
        system_program::transfer(cpi_to_pool, advance_amount)?;

        // Transfer residual remainder to the seller
        if residual_amount > 0 {
            let cpi_to_seller = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.seller.to_account_info(),
                },
            );
            system_program::transfer(cpi_to_seller, residual_amount)?;
        }

        // 2. Adjust Pool accounting (de-allocate liquidity + realize earned fee)
        pool.allocated_liquidity = pool
            .allocated_liquidity
            .checked_sub(advance_amount)
            .ok_or(AuraError::ArithmeticUnderflow)?;
        pool.total_liquidity = pool
            .total_liquidity
            .checked_add(invoice.factored_fee)
            .ok_or(AuraError::ArithmeticOverflow)?;

        invoice.status = InvoiceStatus::Settled;

        emit!(InvoiceSettled {
            invoice_pda: invoice.key(),
            buyer: ctx.accounts.buyer.key(),
            seller: ctx.accounts.seller.key(),
            total_settled: total_due,
            residual_to_seller: residual_amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT STRUCTS & VALIDATIONS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(pool_name: String)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + FactoringPool::INIT_SPACE,
        seeds = [b"factoring_pool", pool_name.as_bytes()],
        bump
    )]
    pub pool: Account<'info, FactoringPool>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(
        mut,
        seeds = [b"factoring_pool", pool.name.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Account<'info, FactoringPool>,
    #[account(mut)]
    pub liquidity_provider: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(invoice_id: String)]
pub struct CreateInvoice<'info> {
    #[account(
        init,
        payer = seller,
        space = 8 + InvoiceEscrow::INIT_SPACE,
        seeds = [b"invoice", seller.key().as_ref(), invoice_id.as_bytes()],
        bump
    )]
    pub invoice: Account<'info, InvoiceEscrow>,
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: Validated as buyer account address
    pub buyer: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FactorInvoice<'info> {
    #[account(
        mut,
        seeds = [b"invoice", invoice.seller.as_ref(), invoice.invoice_id.as_bytes()],
        bump = invoice.bump
    )]
    pub invoice: Account<'info, InvoiceEscrow>,
    #[account(
        mut,
        seeds = [b"factoring_pool", pool.name.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Account<'info, FactoringPool>,
    /// CHECK: Safe, lamports credited directly to the invoice's verified seller
    #[account(mut, address = invoice.seller)]
    pub seller: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleInvoice<'info> {
    #[account(
        mut,
        seeds = [b"invoice", invoice.seller.as_ref(), invoice.invoice_id.as_bytes()],
        bump = invoice.bump
    )]
    pub invoice: Account<'info, InvoiceEscrow>,
    #[account(
        mut,
        seeds = [b"factoring_pool", pool.name.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Account<'info, FactoringPool>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Safe, lamports credited to the recorded seller
    #[account(mut, address = invoice.seller)]
    pub seller: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct FactoringPool {
    pub admin: Pubkey,
    pub total_liquidity: u64,
    pub allocated_liquidity: u64,
    pub fee_rate_bps: u16,
    pub bump: u8,
    #[max_len(32)]
    pub name: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum InvoiceStatus {
    Registered,
    Factored,
    Settled,
    Disputed,
}

#[account]
#[derive(InitSpace)]
pub struct InvoiceEscrow {
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub factor: Pubkey,
    #[max_len(32)]
    pub invoice_id: String,
    pub ksef_hash: [u8; 32],
    pub total_amount: u64,
    pub advance_amount: u64,
    pub factored_fee: u64,
    pub advance_rate_bps: u16,
    pub due_timestamp: i64,
    pub status: InvoiceStatus,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub fee_rate_bps: u16,
}

#[event]
pub struct LiquidityDeposited {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
}

#[event]
pub struct InvoiceCreated {
    pub invoice_pda: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub invoice_id: String,
    pub total_amount: u64,
    pub ksef_hash: [u8; 32],
    pub due_timestamp: i64,
}

#[event]
pub struct InvoiceFactored {
    pub invoice_pda: Pubkey,
    pub factor: Pubkey,
    pub net_payout: u64,
    pub advance_amount: u64,
    pub factored_fee: u64,
}

#[event]
pub struct InvoiceSettled {
    pub invoice_pda: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub total_settled: u64,
    pub residual_to_seller: u64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum AuraError {
    #[msg("Invalid string length exceeded limit")]
    InvalidStringLength,
    #[msg("Excessive fee rate specified. Max is 1000 bps (10%)")]
    ExcessiveFeeRate,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Advance rate must be between 1 and 9000 bps (90%)")]
    InvalidAdvanceRate,
    #[msg("Due date must be in the future")]
    InvalidDueDate,
    #[msg("Arithmetic overflow occurred")]
    ArithmeticOverflow,
    #[msg("Arithmetic underflow occurred")]
    ArithmeticUnderflow,
    #[msg("Invoice is not in Registered state")]
    InvoiceNotEligible,
    #[msg("Invoice has passed its due date")]
    InvoiceExpired,
    #[msg("Factoring pool has insufficient unallocated liquidity")]
    InsufficientPoolLiquidity,
    #[msg("Invoice is not in Factored state")]
    InvoiceNotFactored,
    #[msg("Signer is not the authorized buyer for this invoice")]
    UnauthorizedBuyer,
}