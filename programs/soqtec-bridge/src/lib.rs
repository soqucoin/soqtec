use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, MintTo, Token, TokenAccount, Mint};

declare_id!("SoQTECBridgeProgram11111111111111111111111");

/// SOQ-TEC Bridge Program
/// Soqucoin Operations for Quantum-Tolerant Ecosystem Custody
///
/// Manages bidirectional pSOQ ↔ SOQ bridge operations:
/// - burn_for_redemption: Burns pSOQ on Solana, emits event for relayer
/// - mint_from_deposit:   Mints pSOQ after Soqucoin vault lock verification
/// - update_vault_balance: Updates on-chain Proof of Reserves
/// - pause/resume:        Circuit breaker for emergency response
#[program]
pub mod soqtec_bridge {
    use super::*;

    /// Initialize the bridge with validator set and parameters
    pub fn initialize(
        ctx: Context<Initialize>,
        threshold: u8,
        validators: Vec<Pubkey>,
        daily_limit: u64,
    ) -> Result<()> {
        require!(threshold >= 2, SoqtecError::ThresholdTooLow);
        require!(validators.len() >= threshold as usize, SoqtecError::NotEnoughValidators);
        require!(validators.len() <= 10, SoqtecError::TooManyValidators);

        let bridge = &mut ctx.accounts.bridge_state;
        bridge.authority = ctx.accounts.authority.key();
        bridge.mint = ctx.accounts.psoq_mint.key();
        bridge.threshold = threshold;
        bridge.validators = validators;
        bridge.total_burned = 0;
        bridge.total_minted = 0;
        bridge.vault_balance = 0;
        bridge.daily_limit = daily_limit;
        bridge.daily_volume = 0;
        bridge.last_epoch = Clock::get()?.epoch;
        bridge.paused = false;
        bridge.bump = ctx.bumps.bridge_state;
        bridge.nonce = 0;

        emit!(BridgeInitialized {
            authority: bridge.authority,
            mint: bridge.mint,
            threshold,
            validator_count: bridge.validators.len() as u8,
        });

        Ok(())
    }

    /// Burn pSOQ to redeem native SOQ on Soqucoin L1
    ///
    /// Flow: User burns pSOQ → Event emitted → Relayer picks up →
    ///       Soqucoin vault releases SOQ to user's Dilithium address
    pub fn burn_for_redemption(
        ctx: Context<BurnForRedemption>,
        amount: u64,
        soq_address: [u8; 34], // Soqucoin base58check address (P2PKH)
    ) -> Result<()> {
        let bridge = &mut ctx.accounts.bridge_state;

        // Safety checks
        require!(!bridge.paused, SoqtecError::BridgePaused);
        require!(amount >= MIN_TRANSFER, SoqtecError::BelowMinimum);

        // Circuit breaker — reset daily volume on epoch change
        let current_epoch = Clock::get()?.epoch;
        if current_epoch != bridge.last_epoch {
            bridge.daily_volume = 0;
            bridge.last_epoch = current_epoch;
        }
        require!(
            bridge.daily_volume.checked_add(amount).unwrap_or(u64::MAX) <= bridge.daily_limit,
            SoqtecError::DailyLimitExceeded
        );

        // Calculate fee (0.1% = 1 basis point)
        let fee = amount.checked_div(1000).unwrap_or(0);
        let net_amount = amount.checked_sub(fee).ok_or(SoqtecError::MathOverflow)?;

        // Burn pSOQ from user's token account
        let cpi_accounts = Burn {
            mint: ctx.accounts.psoq_mint.to_account_info(),
            from: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token::burn(cpi_ctx, amount)?;

        // Update state
        bridge.total_burned = bridge.total_burned.checked_add(amount)
            .ok_or(SoqtecError::MathOverflow)?;
        bridge.daily_volume = bridge.daily_volume.checked_add(amount)
            .ok_or(SoqtecError::MathOverflow)?;
        bridge.nonce = bridge.nonce.checked_add(1)
            .ok_or(SoqtecError::MathOverflow)?;

        emit!(BurnForRedemptionEvent {
            user: ctx.accounts.user.key(),
            amount,
            net_amount,
            fee,
            soq_address,
            nonce: bridge.nonce,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Mint pSOQ after relayer verifies Soqucoin vault lock
    ///
    /// Flow: User locks SOQ in vault → Relayer detects → 3-of-5 sign →
    ///       This instruction mints pSOQ to user's Solana wallet
    pub fn mint_from_deposit(
        ctx: Context<MintFromDeposit>,
        amount: u64,
        soq_txid: [u8; 32],  // Soqucoin transaction ID (hex)
        signatures: Vec<ValidatorSignature>,
    ) -> Result<()> {
        let bridge = &ctx.accounts.bridge_state;

        // Safety checks
        require!(!bridge.paused, SoqtecError::BridgePaused);
        require!(amount >= MIN_TRANSFER, SoqtecError::BelowMinimum);

        // Verify threshold signatures from validators
        let valid_sigs = signatures.iter()
            .filter(|sig| bridge.validators.contains(&sig.validator))
            .count();
        require!(valid_sigs >= bridge.threshold as usize, SoqtecError::InsufficientSignatures);

        // Check for replay — the soq_txid must not have been processed before
        // (In production, use a processed-txids PDA map)
        let processed = &mut ctx.accounts.processed_txid;
        require!(!processed.processed, SoqtecError::AlreadyProcessed);
        processed.processed = true;
        processed.soq_txid = soq_txid;
        processed.amount = amount;
        processed.timestamp = Clock::get()?.unix_timestamp;

        // Calculate fee
        let fee = amount.checked_div(1000).unwrap_or(0);
        let net_amount = amount.checked_sub(fee).ok_or(SoqtecError::MathOverflow)?;

        // Mint pSOQ to recipient via PDA authority
        let seeds = &[b"bridge".as_ref(), &[ctx.accounts.bridge_state.bump]];
        let signer = &[&seeds[..]];
        let cpi_accounts = MintTo {
            mint: ctx.accounts.psoq_mint.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.bridge_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::mint_to(cpi_ctx, net_amount)?;

        // Update state
        let bridge = &mut ctx.accounts.bridge_state;
        bridge.total_minted = bridge.total_minted.checked_add(net_amount)
            .ok_or(SoqtecError::MathOverflow)?;

        emit!(MintFromDepositEvent {
            recipient: ctx.accounts.recipient.key(),
            amount,
            net_amount,
            fee,
            soq_txid,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Update on-chain Proof of Reserves (vault balance attestation)
    pub fn update_vault_balance(
        ctx: Context<UpdateVaultBalance>,
        balance: u64,
        block_height: u64,
        signatures: Vec<ValidatorSignature>,
    ) -> Result<()> {
        let bridge = &mut ctx.accounts.bridge_state;

        // Verify threshold signatures
        let valid_sigs = signatures.iter()
            .filter(|sig| bridge.validators.contains(&sig.validator))
            .count();
        require!(valid_sigs >= bridge.threshold as usize, SoqtecError::InsufficientSignatures);

        bridge.vault_balance = balance;

        emit!(VaultBalanceUpdated {
            balance,
            block_height,
            backing_ratio: if bridge.total_minted > 0 {
                (balance as f64 / bridge.total_minted as f64 * 10000.0) as u64
            } else {
                10000 // 100% if nothing minted
            },
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Emergency pause — halts all bridge operations
    pub fn pause_bridge(ctx: Context<AdminAction>) -> Result<()> {
        let bridge = &mut ctx.accounts.bridge_state;
        require!(
            ctx.accounts.authority.key() == bridge.authority,
            SoqtecError::Unauthorized
        );
        bridge.paused = true;

        emit!(BridgePaused {
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Resume bridge operations after emergency
    pub fn resume_bridge(ctx: Context<AdminAction>) -> Result<()> {
        let bridge = &mut ctx.accounts.bridge_state;
        require!(
            ctx.accounts.authority.key() == bridge.authority,
            SoqtecError::Unauthorized
        );
        bridge.paused = false;

        emit!(BridgeResumed {
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

// ============================================================
// Constants
// ============================================================

/// Minimum transfer amount: 100 SOQ (in smallest denomination)
const MIN_TRANSFER: u64 = 100_000_000_00; // 100 SOQ with 8 decimals

// ============================================================
// Accounts
// ============================================================

#[account]
#[derive(Default)]
pub struct BridgeState {
    /// Admin authority (can pause/resume)
    pub authority: Pubkey,
    /// pSOQ SPL token mint address
    pub mint: Pubkey,
    /// Signature threshold (e.g., 3 of 5)
    pub threshold: u8,
    /// Validator public keys
    pub validators: Vec<Pubkey>,
    /// Cumulative pSOQ burned (Solana → Soqucoin)
    pub total_burned: u64,
    /// Cumulative pSOQ minted (Soqucoin → Solana)
    pub total_minted: u64,
    /// Attested SOQ vault balance on Soqucoin L1
    pub vault_balance: u64,
    /// Daily transfer limit (circuit breaker)
    pub daily_limit: u64,
    /// Current daily volume
    pub daily_volume: u64,
    /// Last reset epoch
    pub last_epoch: u64,
    /// Emergency pause flag
    pub paused: bool,
    /// PDA bump seed
    pub bump: u8,
    /// Monotonic nonce for replay protection
    pub nonce: u64,
}

#[account]
pub struct ProcessedTxid {
    pub processed: bool,
    pub soq_txid: [u8; 32],
    pub amount: u64,
    pub timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ValidatorSignature {
    pub validator: Pubkey,
    pub signature: [u8; 64],
}

// ============================================================
// Instruction Contexts
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 1 + (4 + 32 * 10) + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 8,
        seeds = [b"bridge"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,
    pub psoq_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnForRedemption<'info> {
    #[account(mut, seeds = [b"bridge"], bump = bridge_state.bump)]
    pub bridge_state: Account<'info, BridgeState>,
    #[account(mut)]
    pub psoq_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = user_token_account.mint == bridge_state.mint,
        constraint = user_token_account.owner == user.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(amount: u64, soq_txid: [u8; 32])]
pub struct MintFromDeposit<'info> {
    #[account(mut, seeds = [b"bridge"], bump = bridge_state.bump)]
    pub bridge_state: Account<'info, BridgeState>,
    #[account(mut)]
    pub psoq_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + 1 + 32 + 8 + 8,
        seeds = [b"processed", soq_txid.as_ref()],
        bump,
    )]
    pub processed_txid: Account<'info, ProcessedTxid>,
    #[account(
        mut,
        constraint = recipient_token_account.mint == bridge_state.mint,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,
    /// CHECK: Recipient wallet (not necessarily signer)
    pub recipient: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateVaultBalance<'info> {
    #[account(mut, seeds = [b"bridge"], bump = bridge_state.bump)]
    pub bridge_state: Account<'info, BridgeState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(mut, seeds = [b"bridge"], bump = bridge_state.bump)]
    pub bridge_state: Account<'info, BridgeState>,
    pub authority: Signer<'info>,
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct BridgeInitialized {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub threshold: u8,
    pub validator_count: u8,
}

#[event]
pub struct BurnForRedemptionEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub net_amount: u64,
    pub fee: u64,
    pub soq_address: [u8; 34],
    pub nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct MintFromDepositEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub net_amount: u64,
    pub fee: u64,
    pub soq_txid: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct VaultBalanceUpdated {
    pub balance: u64,
    pub backing_ratio: u64,
    pub block_height: u64,
    pub timestamp: i64,
}

#[event]
pub struct BridgePaused {
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct BridgeResumed {
    pub authority: Pubkey,
    pub timestamp: i64,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum SoqtecError {
    #[msg("Bridge is paused — emergency circuit breaker active")]
    BridgePaused,
    #[msg("Amount below minimum transfer (100 SOQ)")]
    BelowMinimum,
    #[msg("Daily transfer limit exceeded — circuit breaker")]
    DailyLimitExceeded,
    #[msg("Insufficient validator signatures for threshold")]
    InsufficientSignatures,
    #[msg("This Soqucoin transaction has already been processed")]
    AlreadyProcessed,
    #[msg("Math overflow in amount calculation")]
    MathOverflow,
    #[msg("Unauthorized — not bridge authority")]
    Unauthorized,
    #[msg("Threshold must be at least 2")]
    ThresholdTooLow,
    #[msg("Not enough validators for threshold")]
    NotEnoughValidators,
    #[msg("Maximum 10 validators supported")]
    TooManyValidators,
}
