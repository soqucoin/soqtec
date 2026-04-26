/**
 * Solana Bridge Executor
 * 
 * Handles the Solana-side operations for the SOQ→SOL (bridge-back) direction:
 *   - mint_from_deposit: Mints pSOQ after verifying Soqucoin vault deposits
 *   - update_vault_balance: Periodic PoR attestation on-chain
 * 
 * Uses the Anchor IDL for typed instruction building.
 * Requires the relayer to hold a validator keypair in the bridge's validator set.
 */

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { RelayerConfig } from '../config';

// Bridge program ID — matches declare_id! in lib.rs
const BRIDGE_PROGRAM_ID = new PublicKey('9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36');

export interface MintParams {
    amount: number;          // pSOQ amount in smallest unit (9 decimals)
    soqTxid: Buffer;         // 32-byte Soqucoin transaction hash
    recipientPubkey: string; // Solana address of the pSOQ recipient
}

export interface PorParams {
    vaultBalance: number;    // SOQ balance in smallest unit
    blockHeight: number;     // Soqucoin block height at attestation time
}

export class SolanaBridgeExecutor {
    private connection: Connection;
    private validatorKeypair: Keypair;
    private program: Program | null = null;
    private config: RelayerConfig;
    private bridgeStatePDA: PublicKey | null = null;
    private lastPorBlock: number = 0;
    private porInterval: ReturnType<typeof setInterval> | null = null;

    constructor(config: RelayerConfig) {
        this.config = config;
        this.connection = new Connection(
            config.solanaRpc || 'https://api.devnet.solana.com',
            'confirmed'
        );

        // Load validator keypair
        const keypairPath = config.solanaKeypairPath.replace('~', process.env.HOME || '');
        if (fs.existsSync(keypairPath)) {
            const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
            this.validatorKeypair = Keypair.fromSecretKey(Uint8Array.from(raw));
            logger.info(`[BridgeExec] Validator: ${this.validatorKeypair.publicKey.toBase58()}`);
        } else {
            logger.warn(`[BridgeExec] Keypair not found at ${keypairPath} — bridge-back disabled`);
            this.validatorKeypair = Keypair.generate(); // Placeholder
        }
    }

    async initialize(): Promise<void> {
        try {
            // Derive bridge state PDA
            const [pda] = PublicKey.findProgramAddressSync(
                [Buffer.from('bridge')],
                BRIDGE_PROGRAM_ID
            );
            this.bridgeStatePDA = pda;
            logger.info(`[BridgeExec] Bridge PDA: ${pda.toBase58()}`);

            // Load Anchor program
            const wallet = new Wallet(this.validatorKeypair);
            const provider = new AnchorProvider(this.connection, wallet, {
                commitment: 'confirmed',
            });

            // Load IDL from target
            const idlPath = `${__dirname}/../../target/idl/soqtec_bridge.json`;
            if (fs.existsSync(idlPath)) {
                const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
                this.program = new Program(idl, provider);
                logger.info('[BridgeExec] Anchor program loaded');
            } else {
                logger.warn(`[BridgeExec] IDL not found at ${idlPath} — using raw transactions`);
            }
        } catch (err: any) {
            logger.error('[BridgeExec] Initialization failed:', err.message);
        }
    }

    /**
     * Mint pSOQ to a Solana recipient after verifying an L1 vault deposit.
     * 
     * Called by the queue processor when a SOQUCOIN_TO_SOLANA transfer
     * reaches sufficient confirmations.
     * 
     * Returns the Solana transaction signature.
     */
    async mintFromDeposit(params: MintParams): Promise<string> {
        if (!this.program || !this.bridgeStatePDA) {
            throw new Error('Bridge executor not initialized');
        }

        const recipientPubkey = new PublicKey(params.recipientPubkey);

        // Derive the processed-txid PDA (replay protection)
        const [processedPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('processed'), params.soqTxid],
            BRIDGE_PROGRAM_ID
        );

        // Build validator signature object
        const validatorSig = {
            validator: this.validatorKeypair.publicKey,
            signature: Array.from(new Uint8Array(64)), // Ed25519 sig placeholder
        };

        logger.info(`[BridgeExec] Minting ${params.amount / 1e9} pSOQ to ${params.recipientPubkey}`);

        try {
            const tx = await this.program.methods
                .mintFromDeposit(
                    params.amount,
                    Array.from(params.soqTxid),
                    [validatorSig]
                )
                .accounts({
                    bridgeState: this.bridgeStatePDA,
                    psoqMint: new PublicKey(this.config.psoqMint),
                    recipientTokenAccount: await this.findAssociatedTokenAccount(
                        recipientPubkey,
                        new PublicKey(this.config.psoqMint)
                    ),
                    recipient: recipientPubkey,
                    processedTxid: processedPDA,
                    authority: this.validatorKeypair.publicKey,
                    tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
                    systemProgram: PublicKey.default,
                })
                .signers([this.validatorKeypair])
                .rpc();

            logger.info(`[BridgeExec] Mint success: ${tx}`);
            return tx;
        } catch (err: any) {
            logger.error(`[BridgeExec] Mint failed: ${err.message}`);
            throw err;
        }
    }

    /**
     * Update on-chain Proof of Reserves.
     * 
     * Periodically calls update_vault_balance on the bridge program
     * with the current vault balance and block height from soqucoind.
     * 
     * This creates an on-chain attestation that auditors and the
     * Terminal dashboard can independently verify.
     */
    async updateProofOfReserves(params: PorParams): Promise<string> {
        if (!this.program || !this.bridgeStatePDA) {
            throw new Error('Bridge executor not initialized');
        }

        // Skip if we already attested this block
        if (params.blockHeight <= this.lastPorBlock) {
            return '';
        }

        const validatorSig = {
            validator: this.validatorKeypair.publicKey,
            signature: Array.from(new Uint8Array(64)),
        };

        logger.info(`[BridgeExec] PoR attestation: ${params.vaultBalance / 1e9} SOQ at block ${params.blockHeight}`);

        try {
            const tx = await this.program.methods
                .updateVaultBalance(
                    params.vaultBalance,
                    params.blockHeight,
                    [validatorSig]
                )
                .accounts({
                    bridgeState: this.bridgeStatePDA,
                    authority: this.validatorKeypair.publicKey,
                })
                .signers([this.validatorKeypair])
                .rpc();

            this.lastPorBlock = params.blockHeight;
            logger.info(`[BridgeExec] PoR attestation submitted: ${tx}`);
            return tx;
        } catch (err: any) {
            logger.error(`[BridgeExec] PoR attestation failed: ${err.message}`);
            throw err;
        }
    }

    /**
     * Start periodic PoR attestation.
     * Runs every 5 minutes, fetching vault balance from soqucoind
     * and posting an on-chain attestation.
     */
    startPeriodicPoR(getBalance: () => number, getBlockHeight: () => number): void {
        const POR_INTERVAL = 5 * 60 * 1000; // 5 minutes

        logger.info('[BridgeExec] Starting periodic PoR attestation (every 5 min)');

        this.porInterval = setInterval(async () => {
            try {
                const balance = getBalance();
                const height = getBlockHeight();

                if (height <= 0 || balance < 0) {
                    logger.warn('[BridgeExec] PoR skip — invalid balance/height');
                    return;
                }

                // Convert SOQ to smallest unit (9 decimals)
                const balanceSmallest = Math.floor(balance * 1e9);

                await this.updateProofOfReserves({
                    vaultBalance: balanceSmallest,
                    blockHeight: height,
                });
            } catch (err: any) {
                logger.error(`[BridgeExec] PoR periodic error: ${err.message}`);
            }
        }, POR_INTERVAL);
    }

    stopPeriodicPoR(): void {
        if (this.porInterval) {
            clearInterval(this.porInterval);
            this.porInterval = null;
        }
    }

    /**
     * Find or derive the associated token account for a given owner and mint.
     */
    private async findAssociatedTokenAccount(
        owner: PublicKey,
        mint: PublicKey
    ): Promise<PublicKey> {
        const [ata] = PublicKey.findProgramAddressSync(
            [
                owner.toBuffer(),
                new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
                mint.toBuffer(),
            ],
            new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
        );
        return ata;
    }

    isInitialized(): boolean {
        return this.program !== null && this.bridgeStatePDA !== null;
    }
}
