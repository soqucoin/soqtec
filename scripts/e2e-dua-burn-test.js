/**
 * SOQ-TEC E2E DUA Pipeline Test
 * 
 * Burns pSOQ on Solana devnet and verifies the full pipeline:
 *   Solana burn → Helius webhook → DUA Router → PAUL/Direct → L1 SOQ release
 * 
 * Run: node scripts/e2e-dua-burn-test.js [amount]
 */

const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair, Connection } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

const PSOQ_MINT = new PublicKey('7TCU5SnLR7ARRAd8aUdoAFgw9zvCvzwdphm7TjUT6s46');
const PROGRAM_ID = new PublicKey('9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36');
const BRIDGE_SEED = Buffer.from('bridge');

// Bridge vault address on Soqucoin L1 (testnet3)
const SOQ_DESTINATION = 'sq1pz3trxfdq7vnrduqt25uc6nzdn8m05d03pe0xnf3w0w2mn4u3xlesxy0hsc';

// Relayer DUA status endpoint
const RELAYER_URL = 'https://soqtec-relay.soqu.org';

async function main() {
  const burnAmountUi = parseInt(process.argv[2]) || 10;
  
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

  console.log('');
  console.log('╔═════════════════════════════════════════════════════╗');
  console.log('║   🔥 SOQ-TEC E2E DUA PIPELINE TEST                 ║');
  console.log('║   Solana burn → Helius → DUA → PAUL → L1 release  ║');
  console.log('╚═════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  User:       ${wallet.publicKey.toString()}`);
  console.log(`  SOQ Dest:   ${SOQ_DESTINATION.slice(0, 30)}...`);
  console.log(`  Burn Amount: ${burnAmountUi} tpSOQ`);
  console.log(`  Program:    ${PROGRAM_ID.toString().slice(0, 12)}...`);
  console.log('');

  // Derive PDAs
  const [bridgeStatePda] = PublicKey.findProgramAddressSync([BRIDGE_SEED], PROGRAM_ID);

  // Get user's token account (ATA)
  const userTokenAccount = await getAssociatedTokenAddress(PSOQ_MINT, wallet.publicKey);
  
  // Check balance
  const balance = await connection.getTokenAccountBalance(userTokenAccount);
  console.log(`  💰 pSOQ Balance: ${balance.value.uiAmount?.toLocaleString()} tpSOQ`);
  
  if (balance.value.uiAmount === 0 || balance.value.uiAmount < burnAmountUi) {
    console.log(`  ❌ Insufficient balance! Need ${burnAmountUi}, have ${balance.value.uiAmount}`);
    return;
  }

  // Bridge state
  const bridgeState = await program.account.bridgeState.fetch(bridgeStatePda);
  console.log(`  📊 Bridge nonce: ${bridgeState.nonce}`);
  console.log(`  📊 Bridge paused: ${bridgeState.paused}`);
  
  // DUA status before burn
  console.log('');
  console.log('  ── Pre-burn DUA status ──');
  try {
    const resp = await fetch(`${RELAYER_URL}/api/dua/status`);
    const dua = await resp.json();
    console.log(`  Pipeline: enabled=${dua.enabled}, halted=${dua.halted}`);
    console.log(`  Adapters: ${dua.adapters?.map(a => `${a.chainId}(healthy=${a.healthy})`).join(', ')}`);
    console.log(`  Releases: ${dua.releases?.total || 0} total (${dua.releases?.paul || 0} PAUL, ${dua.releases?.direct || 0} direct)`);
    console.log(`  Seen-set: ${dua.seenSetSize || 0} events`);
  } catch (err) {
    console.log(`  ⚠️  Could not reach DUA status: ${err.message}`);
  }

  // Execute burn
  console.log('');
  console.log(`  🔥 BURNING ${burnAmountUi} tpSOQ on Solana devnet...`);
  
  const soqAddressBytes = Buffer.alloc(64);
  Buffer.from(SOQ_DESTINATION, 'utf8').copy(soqAddressBytes);
  
  const burnAmount = new anchor.BN(burnAmountUi * 1e9); // 9 decimals
  const startTime = Date.now();

  try {
    const tx = await program.methods
      .burnForRedemption(
        burnAmount,
        Array.from(soqAddressBytes),
      )
      .accounts({
        bridgeState: bridgeStatePda,
        psoqMint: PSOQ_MINT,
        userTokenAccount: userTokenAccount,
        user: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const burnMs = Date.now() - startTime;
    console.log('');
    console.log('  ✅ BURN CONFIRMED ON SOLANA');
    console.log(`  Tx:       ${tx}`);
    console.log(`  Time:     ${burnMs}ms`);
    console.log(`  Explorer: https://solscan.io/tx/${tx}?cluster=devnet`);
    
    // Now wait for the DUA pipeline to detect and process it
    console.log('');
    console.log('  ── Waiting for DUA pipeline detection ──');
    console.log('  Helius webhook should fire within ~2s...');
    console.log('  RPC poll fallback runs every 5s...');
    console.log('');

    // Poll DUA status for up to 60 seconds
    let detected = false;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      
      try {
        const resp = await fetch(`${RELAYER_URL}/api/dua/status`);
        const dua = await resp.json();
        const releases = dua.releases || {};
        
        console.log(`  [${elapsed}s] Releases: total=${releases.total} paul=${releases.paul} direct=${releases.direct} pending=${releases.pending}`);
        
        if (releases.total > 0 || releases.pending > 0) {
          detected = true;
          console.log('');
          console.log('  🎉 DUA PIPELINE FIRED!');
          
          // Get release details
          const relResp = await fetch(`${RELAYER_URL}/api/dua/releases`);
          const relData = await relResp.json();
          if (relData.releases?.length > 0) {
            const latest = relData.releases[relData.releases.length - 1];
            console.log(`  Release method: ${latest.method}`);
            console.log(`  SOQ txid:       ${latest.soqTxid}`);
            console.log(`  Amount:         ${latest.netAmount} SOQ`);
            console.log(`  Recipient:      ${latest.recipient?.slice(0, 30)}...`);
          }
          break;
        }
      } catch (err) {
        console.log(`  [${elapsed}s] DUA poll error: ${err.message}`);
      }
    }

    if (!detected) {
      console.log('');
      console.log('  ⚠️  DUA pipeline did not fire within 60s.');
      console.log('  Check relayer logs: journalctl -u soqtec-relayer -f');
      console.log('  The burn IS recorded on Solana — check the tx above.');
    }

    // Final balance
    const newBalance = await connection.getTokenAccountBalance(userTokenAccount);
    console.log('');
    console.log(`  💰 Remaining pSOQ: ${newBalance.value.uiAmount?.toLocaleString()} tpSOQ`);
    console.log(`  🔥 Total burned:   ${burnAmountUi} tpSOQ`);
    
  } catch (err) {
    console.error('  ❌ Burn failed:', err.message);
    if (err.logs) {
      console.error('\n  Program logs:');
      err.logs.forEach(l => console.error('    ', l));
    }
  }

  console.log('');
}

main().catch(console.error);
