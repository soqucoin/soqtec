use anchor_lang::prelude::*;

#[error_code]
pub enum XmssError {
    #[msg("Invalid Merkle proof — root mismatch")]
    InvalidMerkleProof,
    #[msg("Invalid WOTS+ signature — public key recovery failed")]
    InvalidWotsSignature,
    #[msg("Leaf index mismatch — key already used (replay protection)")]
    LeafIndexMismatch,
    #[msg("Vault exhausted — all keys have been used, rotate required")]
    VaultExhausted,
    #[msg("Vault is not active")]
    VaultInactive,
    #[msg("Invalid tree depth — must be 1..20")]
    InvalidTreeDepth,
    #[msg("Merkle proof length does not match tree depth")]
    ProofLengthMismatch,
    #[msg("Invalid WOTS+ signature length")]
    InvalidSignatureLength,
    #[msg("Unauthorized — not vault owner")]
    Unauthorized,
    #[msg("Unauthorized — not bridge authority")]
    UnauthorizedBridge,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Vault still has remaining keys — cannot rotate")]
    VaultNotExhausted,
    #[msg("Token mint mismatch")]
    MintMismatch,
    #[msg("Invalid message length for WOTS+ signing")]
    InvalidMessageLength,
}
