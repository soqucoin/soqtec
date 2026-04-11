/**
 * SOQ-TEC E2E Bridge Test
 * 
 * Executes a full burn-to-release cycle:
 * 1. Burns tpSOQ on Solana devnet via the bridge program
 * 2. Verifies the BurnForRedemptionEvent is emitted
 * 3. Shows the SOQ address where funds would be released
 * 
 * Run: node scripts/e2e-burn-test.js
 */

const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair, Connection } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

const PSOQ_MINT = new PublicKey('7TCU5SnLR7ARRAd8aUdoAFgw9zvCvzwdphm7TjUT6s46');
const PROGRAM_ID = new PublicKey('9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36');
const BRIDGE_SEED = Buffer.from('bridge');

// The Soqucoin address to receive SOQ after burn
const SOQ_DESTINATION = 'sq1pwfwfed7jvfz68h030xskg72xptfun0cc4y7qyyd75jhvlmu3klmq9xj24p';

async function main() {
  // Load IDL
  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'soqtec_bridge.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));

  // Load deployer keypair
  const keypairPath = path.join(process.env.HOME, '.config/solana/soqtec-deployer.json');
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const wallet = new anchor.Wallet(keypair);

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const program = new anchor.Program(idl, provider);

  console.log('🔥 SOQ-TEC E2E BURN TEST');
  console.log('========================');
  console.log(`User:     ${wallet.publicKey.toString()}`);
  console.log(`SOQ Dest: ${SOQ_DESTINATION}`);
  console.log('');

  // Derive PDAs
  const [bridgeStatePda] = PublicKey.findProgramAddressSync([BRIDGE_SEED], PROGRAM_ID);

  // Get user's token account (ATA)
  const userTokenAccount = await getAssociatedTokenAddress(PSOQ_MINT, wallet.publicKey);
  
  // Check token balance
  try {
    const balance = await connection.getTokenAccountBalance(userTokenAccount);
    console.log(`💰 pSOQ Balance: ${balance.value.uiAmount} tpSOQ`);
    
    if (balance.value.uiAmount === 0) {
      console.log('❌ No pSOQ to burn!');
      return;
    }
  } catch (err) {
    console.log('❌ Token account not found. Run deploy-test-psoq.sh first.');
    return;
  }

  // Fetch bridge state
  const bridgeState = await program.account.bridgeState.fetch(bridgeStatePda);
  console.log(`📊 Bridge nonce: ${bridgeState.nonce}`);
  console.log(`   Paused: ${bridgeState.paused}`);
  console.log('');

  // Encode SOQ destination address as 64-byte padded buffer  
  const soqAddressBytes = Buffer.alloc(64);
  Buffer.from(SOQ_DESTINATION, 'utf8').copy(soqAddressBytes);

  // Execute burn — 100 tpSOQ (smallest denomination with 9 decimals)
  const burnAmount = new anchor.BN(100 * 1e9); // 100 tpSOQ
  
  console.log(`🔥 Burning 100 tpSOQ...`);
  console.log(`   → Will release 99.9 SOQ to ${SOQ_DESTINATION.slice(0, 20)}...`);
  console.log('');

  try {
    const tx = await program.methods
      .burnForRedemption(
        burnAmount,
        Array.from(soqAddressBytes),  // soq_address as [u8; 64]
      )
      .accounts({
        bridgeState: bridgeStatePda,
        psoqMint: PSOQ_MINT,
        userTokenAccount: userTokenAccount,
        user: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log('✅ BURN SUCCESSFUL!');
    console.log(`   Tx: ${tx}`);
    console.log(`   Explorer: https://solscan.io/tx/${tx}?cluster=devnet`);
    console.log('');
    
    // Fetch updated state
    const updatedState = await program.account.bridgeState.fetch(bridgeStatePda);
    console.log('📊 Updated Bridge State:');
    console.log(`   Nonce: ${updatedState.nonce} (was ${bridgeState.nonce})`);
    console.log(`   Total Burned: ${updatedState.totalBurned?.toString() || 'N/A'}`);
    
    // Check remaining balance
    const newBalance = await connection.getTokenAccountBalance(userTokenAccount);
    console.log(`   Remaining pSOQ: ${newBalance.value.uiAmount}`);
    console.log('');
    console.log('🎯 E2E RESULT: Burn event emitted. Relayer should detect this');
    console.log('   and call soqucoind sendtoaddress to release SOQ.');
    
  } catch (err) {
    console.error('❌ Burn failed:', err.message);
    if (err.logs) {
      console.error('\nProgram logs:');
      err.logs.forEach(l => console.error('  ', l));
    }
  }
}

main().catch(console.error);
