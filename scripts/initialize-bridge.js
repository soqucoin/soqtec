/**
 * Initialize SOQ-TEC Bridge on Solana Devnet
 */

const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair, Connection } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const PSOQ_MINT = new PublicKey('7TCU5SnLR7ARRAd8aUdoAFgw9zvCvzwdphm7TjUT6s46');
const PROGRAM_ID = new PublicKey('9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36');

async function main() {
  // Load IDL
  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'soqtec_bridge.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));

  // Load deployer keypair
  const keypairPath = path.join(process.env.HOME, '.config/solana/soqtec-deployer.json');
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const wallet = new anchor.Wallet(keypair);

  // Connect to devnet
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });

  const program = new anchor.Program(idl, provider);

  console.log('🚀 Initializing SOQ-TEC Bridge on devnet...');
  console.log(`   Program:   ${PROGRAM_ID.toString()}`);
  console.log(`   pSOQ Mint: ${PSOQ_MINT.toString()}`);
  console.log(`   Authority: ${wallet.publicKey.toString()}`);

  // Derive BridgeState PDA
  const [bridgeStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge')],
    PROGRAM_ID
  );
  console.log(`   Bridge PDA: ${bridgeStatePda.toString()}`);

  try {
    // Check if already initialized
    const existing = await connection.getAccountInfo(bridgeStatePda);
    if (existing) {
      console.log('⚠️  Bridge already initialized! Fetching state...');
      const state = await program.account.bridgeState.fetch(bridgeStatePda);
      console.log('   State:', JSON.stringify({
        authority: state.authority.toString(),
        mint: state.mint.toString(),
        threshold: state.threshold,
        validatorCount: state.validatorCount,
        paused: state.paused,
        nonce: state.nonce.toString(),
      }, null, 2));
      return;
    }

    // Initialize bridge
    // For hackathon: use deployer as all 3 validators
    // Production: each validator has a separate Dilithium key
    const validators = [
      wallet.publicKey,  // validator 1
      wallet.publicKey,  // validator 2 (same for testing)
      wallet.publicKey,  // validator 3 (same for testing)
    ];

    const tx = await program.methods
      .initialize(
        2,           // threshold (2-of-3)
        validators,  // validator pubkeys
        new anchor.BN('1000000000000000') // daily_limit: 1M SOQ (9 decimals)
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
    const state = await program.account.bridgeState.fetch(bridgeStatePda);
    console.log(`\n📊 Bridge State:`);
    console.log(`   Authority:  ${state.authority.toString()}`);
    console.log(`   Mint:       ${state.mint.toString()}`);
    console.log(`   Threshold:  ${state.threshold}`);
    console.log(`   Validators: ${state.validatorCount}`);
    console.log(`   Paused:     ${state.paused}`);
    console.log(`   Nonce:      ${state.nonce.toString()}`);
  } catch (err) {
    console.error('❌ Error:', err.message || err);
    if (err.logs) {
      console.error('Program logs:', err.logs.join('\n'));
    }
  }
}

main().catch(console.error);
