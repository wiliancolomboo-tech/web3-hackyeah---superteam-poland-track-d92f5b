use anchor_lang::prelude::*;

#[event]
pub struct AgreementInitialized {
    pub agreement_key: Pubkey,
    pub client: Pubkey,
    pub contractor: Pubkey,
    pub arbiter: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub agreement_id: String,
}

#[event]
pub struct MilestoneSubmitted {
    pub agreement_key: Pubkey,
    pub submission_hash: [u8; 32],
    pub submitted_at: i64,
}

#[event]
pub struct MilestoneApproved {
    pub agreement_key: Pubkey,
    pub contractor: Pubkey,
    pub net_payout: u64,
    pub fee_paid: u64,
}

#[event]
pub struct DisputeOpened {
    pub agreement_key: Pubkey,
    pub disputed_by: Pubkey,
    pub opened_at: i64,
}

#[event]
pub struct DisputeResolved {
    pub agreement_key: Pubkey,
    pub arbiter: Pubkey,
    pub contractor_amount: u64,
    pub client_amount: u64,
    pub fee_paid: u64,
}

#[event]
pub struct TimeoutClaimed {
    pub agreement_key: Pubkey,
    pub recipient: Pubkey,
    pub refund_amount: u64,
}