use anchor_lang::prelude::*;

/// XMSS-Lite Vault: Quantum-resistant SPL token custody
///
/// Implements a Merkle tree of WOTS+ keypairs, enabling 2^depth signatures
/// per vault (vs 1 in the original Winternitz vault). On-chain leaf index
/// prevents cryptographic key reuse.
///
/// Patent: Provisional Application #64/035,857 — Claim 1
#[account]
pub struct XmssVault {
    /// Merkle root of the WOTS+ public key tree (PDA seed component)
    pub merkle_root: [u8; 32],
    /// Current leaf index — monotonically incrementing, enforced on-chain
    /// Prevents WOTS+ key reuse (critical for hash-based signature security)
    pub leaf_index: u16,
    /// Tree depth: determines max signatures (2^depth)
    /// MVP: 4 (16 sigs), Production: 10 (1,024 sigs)
    pub tree_depth: u8,
    /// Vault owner (controls withdrawals)
    pub owner: Pubkey,
    /// SPL token mint this vault holds (e.g., pSOQ)
    pub token_mint: Pubkey,
    /// Associated Token Account owned by vault PDA
    pub token_account: Pubkey,
    /// Bridge program authority — can mint directly into vault ATA
    /// Patent: Provisional Application #64/035,857 — Claim 2
    pub bridge_authority: Pubkey,
    /// Whether vault is active (false after rotation)
    pub is_active: bool,
    /// PDA bump seed
    pub bump: u8,
    /// Vault creation timestamp
    pub created_at: i64,
    /// Total operations performed (sign count)
    pub total_operations: u32,
}

impl XmssVault {
    /// Account size: 8 (discriminator) + fields
    pub const SIZE: usize = 8    // Anchor discriminator
        + 32   // merkle_root
        + 2    // leaf_index
        + 1    // tree_depth
        + 32   // owner
        + 32   // token_mint
        + 32   // token_account
        + 32   // bridge_authority
        + 1    // is_active
        + 1    // bump
        + 8    // created_at
        + 4;   // total_operations

    /// Maximum number of signatures this vault supports
    pub fn max_signatures(&self) -> u16 {
        1u16.checked_shl(self.tree_depth as u32).unwrap_or(u16::MAX)
    }

    /// Remaining available signatures
    pub fn remaining_keys(&self) -> u16 {
        self.max_signatures().saturating_sub(self.leaf_index)
    }

    /// Whether the vault has been fully exhausted
    pub fn is_exhausted(&self) -> bool {
        self.leaf_index >= self.max_signatures()
    }
}
