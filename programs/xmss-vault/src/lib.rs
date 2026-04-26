use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};
use anchor_spl::associated_token::AssociatedToken;

pub mod errors;
pub mod merkle;
pub mod state;
pub mod wots;

use errors::XmssError;
use merkle::verify_merkle_proof;
use state::XmssVault;
use wots::{
    wots_verify, construct_withdrawal_message,
    HASH_LEN, FULL_HASH_LEN, NUM_CHAINS,
};

declare_id!("7k4TwwBSZ4a7JA83MgSsqxczU6bpR7qV3uUNGWbTEz8H");

/// XMSS-Lite Revolving Vault Program
///
/// Quantum-resistant SPL token custody using a Merkle tree of WOTS+ keypairs.
/// Each vault supports 2^depth signatures (vs 1 in original Winternitz vault).
///
/// Novel contributions (Patent #64/035,857):
///   Claim 1: XMSS-Lite on Blockchain VM — Merkle tree + on-chain leaf index
///   Claim 2: Direct-Mint-to-Quantum-Vault — zero Ed25519 gap
///   Claim 3: Atomic Vault Rotation via CPI
///   Claim 4: Hybrid PQ Bridge with Hash-Based Custody
#[program]
pub mod xmss_vault {
    use super::*;

    /// Initialize a new XMSS-Lite vault with a Merkle root of WOTS+ public keys
    ///
    /// The user generates the WOTS+ key tree offline, computes the Merkle root,
    /// and provides it here. The vault PDA is seeded with this root.
    ///
    /// Patent Claim 1: "Implementing a Merkle tree of WOTS+ keypairs as a smart
    /// contract with on-chain state management of leaf index"
    pub fn open_xmss_vault(
        ctx: Context<OpenXmssVault>,
        merkle_root: [u8; 32],
        tree_depth: u8,
        bridge_authority: Pubkey,
    ) -> Result<()> {
        require!(tree_depth >= 1 && tree_depth <= 20, XmssError::InvalidTreeDepth);

        let vault_key = ctx.accounts.vault.key();
        let vault = &mut ctx.accounts.vault;
        vault.merkle_root = merkle_root;
        vault.leaf_index = 0;
        vault.tree_depth = tree_depth;
        vault.owner = ctx.accounts.owner.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.token_account = ctx.accounts.vault_token_account.key();
        vault.bridge_authority = bridge_authority;
        vault.is_active = true;
        vault.bump = ctx.bumps.vault;
        vault.created_at = Clock::get()?.unix_timestamp;
        vault.total_operations = 0;

        msg!("XMSS-Lite Vault opened: depth={}, max_sigs={}",
            tree_depth, vault.max_signatures());
        msg!("Merkle root: {:?}", &merkle_root[..8]);

        emit!(VaultOpened {
            vault: vault_key,
            owner: vault.owner,
            merkle_root,
            tree_depth,
            max_signatures: vault.max_signatures(),
            timestamp: vault.created_at,
        });

        Ok(())
    }

    /// Withdraw SPL tokens from vault using WOTS+ signature + Merkle proof
    ///
    /// The user signs a message (amount + recipient + leaf_index) with the WOTS+
    /// key at leaf_index, provides the Merkle proof, and the vault verifies:
    ///   1. WOTS+ signature → recovers public key hash
    ///   2. Merkle proof → proves recovered key is in the tree
    ///   3. Leaf index → matches on-chain counter (prevents reuse)
    ///   4. Increment leaf_index (irreversible, on-chain enforcement)
    pub fn withdraw_from_vault(
        ctx: Context<WithdrawFromVault>,
        amount: u64,
        leaf_index: u16,
        wots_signature_flat: Vec<u8>,
        merkle_proof_flat: Vec<u8>,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;

        // Safety checks
        require!(vault.is_active, XmssError::VaultInactive);
        require!(!vault.is_exhausted(), XmssError::VaultExhausted);
        require!(leaf_index == vault.leaf_index, XmssError::LeafIndexMismatch);
        require!(
            wots_signature_flat.len() == NUM_CHAINS * HASH_LEN,
            XmssError::InvalidSignatureLength
        );
        require!(
            merkle_proof_flat.len() == (vault.tree_depth as usize) * FULL_HASH_LEN,
            XmssError::ProofLengthMismatch
        );

        // Step 1: Construct the signed message
        let message = construct_withdrawal_message(
            amount,
            ctx.accounts.recipient.key.as_ref().try_into().unwrap(),
            leaf_index,
        );

        // Step 2: Verify WOTS+ signature → recover public key hash
        // Unpack flat signature bytes into 32 chains of 28 bytes each
        let mut sig_array = [[0u8; HASH_LEN]; NUM_CHAINS];
        for i in 0..NUM_CHAINS {
            sig_array[i].copy_from_slice(
                &wots_signature_flat[i * HASH_LEN..(i + 1) * HASH_LEN]
            );
        }
        let recovered_pk_hash = wots_verify(&message, &sig_array);

        // Step 3: Verify Merkle proof — recovered key must be in the tree
        // Unpack flat proof bytes into 32-byte sibling hashes
        let depth = vault.tree_depth as usize;
        let mut merkle_proof = Vec::with_capacity(depth);
        for i in 0..depth {
            let mut sibling = [0u8; FULL_HASH_LEN];
            sibling.copy_from_slice(
                &merkle_proof_flat[i * FULL_HASH_LEN..(i + 1) * FULL_HASH_LEN]
            );
            merkle_proof.push(sibling);
        }
        verify_merkle_proof(
            &recovered_pk_hash,
            leaf_index,
            &merkle_proof,
            &vault.merkle_root,
        )?;

        // Step 4: Transfer SPL tokens from vault ATA to recipient
        let merkle_root = vault.merkle_root;
        let bump = vault.bump;
        let seeds = &[
            b"xmss-vault".as_ref(),
            merkle_root.as_ref(),
            &[bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        // Step 5: Increment leaf index (irreversible — prevents key reuse)
        let vault_key = ctx.accounts.vault.key();
        let recipient_key = ctx.accounts.recipient.key();
        let vault = &mut ctx.accounts.vault;
        vault.leaf_index = vault.leaf_index.checked_add(1)
            .ok_or(XmssError::MathOverflow)?;
        vault.total_operations = vault.total_operations.checked_add(1)
            .ok_or(XmssError::MathOverflow)?;

        let remaining = vault.remaining_keys();
        msg!("WOTS+ withdrawal: leaf={}, amount={}, remaining_keys={}",
            leaf_index, amount, remaining);

        emit!(VaultWithdrawal {
            vault: vault_key,
            leaf_index,
            amount,
            recipient: recipient_key,
            remaining_keys: remaining,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposit SPL tokens into vault (no WOTS+ needed — anyone can deposit)
    pub fn deposit_to_vault(
        ctx: Context<DepositToVault>,
        amount: u64,
    ) -> Result<()> {
        require!(ctx.accounts.vault.is_active, XmssError::VaultInactive);

        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token::transfer(cpi_ctx, amount)?;

        msg!("Deposit to vault: amount={}", amount);

        emit!(VaultDeposit {
            vault: ctx.accounts.vault.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Query vault status (view function — returns info via msg!)
    pub fn vault_status(ctx: Context<VaultStatus>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let balance = ctx.accounts.vault_token_account.amount;

        msg!("=== XMSS-Lite Vault Status ===");
        msg!("Active: {}", vault.is_active);
        msg!("Tree Depth: {}", vault.tree_depth);
        msg!("Max Signatures: {}", vault.max_signatures());
        msg!("Used Keys: {}", vault.leaf_index);
        msg!("Remaining Keys: {}", vault.remaining_keys());
        msg!("Token Balance: {}", balance);
        msg!("Total Operations: {}", vault.total_operations);
        msg!("Owner: {}", vault.owner);
        msg!("Merkle Root: {:?}", &vault.merkle_root[..8]);

        Ok(())
    }
}

// ============================================================
// Instruction Contexts
// ============================================================

#[derive(Accounts)]
#[instruction(merkle_root: [u8; 32], tree_depth: u8)]
pub struct OpenXmssVault<'info> {
    #[account(
        init,
        payer = owner,
        space = XmssVault::SIZE,
        seeds = [b"xmss-vault", merkle_root.as_ref()],
        bump
    )]
    pub vault: Account<'info, XmssVault>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct WithdrawFromVault<'info> {
    #[account(
        mut,
        seeds = [b"xmss-vault", vault.merkle_root.as_ref()],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ XmssError::Unauthorized,
    )]
    pub vault: Account<'info, XmssVault>,

    #[account(
        mut,
        constraint = vault_token_account.key() == vault.token_account @ XmssError::MintMismatch,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == vault.token_mint @ XmssError::MintMismatch,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// CHECK: Recipient wallet address (used in message construction)
    pub recipient: AccountInfo<'info>,

    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositToVault<'info> {
    #[account(
        seeds = [b"xmss-vault", vault.merkle_root.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, XmssVault>,

    #[account(
        mut,
        constraint = vault_token_account.key() == vault.token_account @ XmssError::MintMismatch,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_token_account.mint == vault.token_mint @ XmssError::MintMismatch,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct VaultStatus<'info> {
    #[account(
        seeds = [b"xmss-vault", vault.merkle_root.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, XmssVault>,

    #[account(
        constraint = vault_token_account.key() == vault.token_account @ XmssError::MintMismatch,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct VaultOpened {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub merkle_root: [u8; 32],
    pub tree_depth: u8,
    pub max_signatures: u16,
    pub timestamp: i64,
}

#[event]
pub struct VaultWithdrawal {
    pub vault: Pubkey,
    pub leaf_index: u16,
    pub amount: u64,
    pub recipient: Pubkey,
    pub remaining_keys: u16,
    pub timestamp: i64,
}

#[event]
pub struct VaultDeposit {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}
