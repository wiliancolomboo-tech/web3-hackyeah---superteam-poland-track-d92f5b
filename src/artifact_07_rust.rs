use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";

#[account]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub fee_basis_points: u16, // 15 = 0.15%
    pub bump: u8,
}

impl ProtocolConfig {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowState {
    Funded,
    Submitted,
    Disputed,
    Settled,
    Refunded,
}

#[account]
pub struct EscrowAgreement {
    pub client: Pubkey,
    pub contractor: Pubkey,
    pub arbiter: Pubkey,
    pub token_mint: Pubkey,
    pub agreement_id: String,
    pub total_amount: u64,
    pub deadline: i64,
    pub state: EscrowState,
    pub description_hash: [u8; 32],
    pub submission_hash: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}

impl EscrowAgreement {
    // 8 discriminator + 32 client + 32 contractor + 32 arbiter + 32 mint
    // + (4 + 32) string + 8 amount + 8 deadline + 1 enum + 32 desc + 32 sub + 1 bump + 1 vault_bump
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 36 + 8 + 8 + 1 + 32 + 32 + 1 + 1;
}