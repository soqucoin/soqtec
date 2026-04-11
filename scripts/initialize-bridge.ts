/**
 * Initialize SOQ-TEC Bridge on Solana Devnet
 * 
 * This script:
 * 1. Derives the BridgeState PDA
 * 2. Calls initialize_bridge() with our test pSOQ mint
 * 3. Sets threshold to 2-of-3 validators
 * 4. Logs the resulting on-chain state
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import idl from '../relayer/src/idl/soqtec_bridge.json';

const PSOQ_MINT = new PublicKey('7TCU5SnLR7ARRAd8aUdoAFgw9zvCvzwdphm7TjUT6s46');
const PROGRAM_ID = new PublicKey('9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36');

async function main() {
  // Load deployer keypair
  const keypairPath = `${process.env.HOME}/.config/solana/soqtec-deployer.json`;
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(keypairData)));

  // Connect to devnet
  const connection = new anchor.web3.Connection('https://api.devnet.solana.com', 'confirmed');
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });

  const program = new Program(idl as any, provider);

  console.log('🚀 Initializing SOQ-TEC Bridge on devnet...');
  console.log(`   Program:  ${PROGRAM_ID.toString()}`);
  console.log(`   pSOQ Mint: ${PSOQ_MINT.toString()}`);
  console.log(`   Authority: ${wallet.publicKey.toString()}`);

  // Derive BridgeState PDA
  const [bridgeStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_state')],
    PROGRAM_ID
  );
  console.log(`   Bridge PDA: ${bridgeStatePda.toString()}`);

  try {
    // Check if already initialized
    const existing = await connection.getAccountInfo(bridgeStatePda);
    if (existing) {
      console.log('⚠️  Bridge already initialized! Fetching state...');
      const state = await (program.account as any).bridgeState.fetch(bridgeStatePda);
      console.log('   Current state:', JSON.stringify(state, null, 2));
      return;
    }

    // Initialize bridge
    const tx = await (program.methods as any)
      .initializeBridge(
        2,   // threshold (2-of-3)
        3,   // validator count
      )
      .accounts({
        bridgeState: bridgeStatePda,
        psoqMint: PSOQ_MINT,
        authority: wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log(`\n✅ Bridge initialized!`);
    console.log(`   Tx: ${tx}`);

    // Fetch and display state
    const state = await (program.account as any).bridgeState.fetch(bridgeStatePda);
    console.log(`\n📊 Bridge State:`);
    console.log(`   Authority:  ${state.authority.toString()}`);
    console.log(`   Mint:       ${state.mint.toString()}`);
    console.log(`   Threshold:  ${state.threshold}`);
    console.log(`   Validators: ${state.validatorCount}`);
    console.log(`   Paused:     ${state.paused}`);
    console.log(`   Nonce:      ${state.nonce}`);
  } catch (err: any) {
    console.error('❌ Error:', err.message || err);
    if (err.logs) {
      console.error('Program logs:', err.logs);
    }
  }
}

main().catch(console.error);
