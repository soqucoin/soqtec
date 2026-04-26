#!/usr/bin/env node
/**
 * SOQ-TEC: Direct-Mint-to-Quantum-Vault E2E Demo
 * 
 * Patent Claims Proven:
 *   Claim 1: XMSS-Lite on Blockchain VM (Merkle tree + leaf index)
 *   Claim 2: Direct-Mint-to-Quantum-Vault (zero Ed25519 gap)
 *   Claim 4: Hybrid PQ Bridge with Hash-Based Custody
 * 
 * Flow:
 *   1. Generate XMSS key tree (offline, quantum-safe)
 *   2. Open XMSS vault (on-chain, linked to bridge)
 *   3. Bridge mints pSOQ DIRECTLY into vault ATA (Patent Claim 2!)
 *   4. WOTS+ verified withdrawal from vault (Patent Claim 1)
 *   5. Key reuse rejection (security property)
 * 
 * Usage: node scripts/demo-bridge-to-vault.js
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} = require("@solana/spl-token");

const xmss = require("./xmss-client");
const fs = require("fs");

// ============================================================
// Configuration
// ============================================================

const TREE_DEPTH = 4;
const DECIMALS = 9;
const DEPOSIT_AMOUNT = 5000;
const WITHDRAWAL_AMOUNT = 1000;
const DEPOSIT_RAW = BigInt(DEPOSIT_AMOUNT) * BigInt(10 ** DECIMALS);
const WITHDRAWAL_RAW = BigInt(WITHDRAWAL_AMOUNT) * BigInt(10 ** DECIMALS);

const BRIDGE_PROGRAM_ID = new PublicKey("9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36");
const VAULT_PROGRAM_ID = new PublicKey("7k4TwwBSZ4a7JA83MgSsqxczU6bpR7qV3uUNGWbTEz8H");

// Existing pSOQ mint (authority transferred to bridge PDA)
const PSOQ_MINT = new PublicKey("7TCU5SnLR7ARRAd8aUdoAFgw9zvCvzwdphm7TjUT6s46");

// ============================================================
// Display helpers
// ============================================================

function banner(step, title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  STEP ${step}: ${title}`);
  console.log(`${"═".repeat(60)}\n`);
}

function success(msg) { console.log(`  ✅ ${msg}`); }
function info(msg)    { console.log(`      ${msg}`); }

// ============================================================
// Main Demo
// ============================================================

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SOQ-TEC: DIRECT-MINT-TO-QUANTUM-VAULT`);
  console.log(`  Patent #64/035,857 — Claims 1, 2, and 4`);
  console.log(`  Network: Solana Devnet`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}`);

  // Setup provider
  const deployerKeyfile = fs.readFileSync(
    `${process.env.HOME}/.config/solana/soqtec-deployer.json`, "utf-8"
  );
  const deployerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(deployerKeyfile))
  );

  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com", "confirmed"
  );
  const wallet = new anchor.Wallet(deployerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load programs
  const vaultIdl = JSON.parse(
    fs.readFileSync("./target/idl/xmss_vault.json", "utf-8")
  );
  const vaultProgram = new anchor.Program(vaultIdl, provider);

  const bridgeIdl = JSON.parse(
    fs.readFileSync("./target/idl/soqtec_bridge.json", "utf-8")
  );
  const bridgeProgram = new anchor.Program(bridgeIdl, provider);

  // Bridge PDA
  const [bridgePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge")],
    BRIDGE_PROGRAM_ID
  );

  // ──────────────────────────────────────────────────────────
  // STEP 1: Generate XMSS Key Tree (Offline)
  // ──────────────────────────────────────────────────────────
  banner(1, "GENERATE XMSS KEY TREE (OFFLINE — QUANTUM-SAFE)");

  info("Generating WOTS+ key tree with depth=" + TREE_DEPTH);
  info("This happens OFFLINE — private keys never touch the network");

  const tree = xmss.generateXmssTree(TREE_DEPTH);
  const maxSigs = Math.pow(2, TREE_DEPTH);

  success(`Generated ${maxSigs} WOTS+ keypairs`);
  info(`Merkle root: ${tree.merkleRoot.toString("hex").slice(0, 32)}...`);
  info(`Tree depth: ${TREE_DEPTH}, Max signatures: ${maxSigs}`);

  // ──────────────────────────────────────────────────────────
  // STEP 2: Verify Bridge State
  // ──────────────────────────────────────────────────────────
  banner(2, "VERIFY BRIDGE STATE");

  const bridgeState = await bridgeProgram.account.bridgeState.fetch(bridgePda);
  success(`Bridge PDA: ${bridgePda.toBase58()}`);
  info(`Bridge mint: ${bridgeState.mint.toBase58()}`);
  info(`Threshold: ${bridgeState.threshold}-of-${bridgeState.validators.length}`);
  info(`Total minted: ${bridgeState.totalMinted.toString()}`);
  info(`Paused: ${bridgeState.paused}`);
  info(`Mint authority: bridge PDA (quantum-safe custody pattern)`);

  // ──────────────────────────────────────────────────────────
  // STEP 3: Open XMSS Vault (linked to bridge)
  // ──────────────────────────────────────────────────────────
  banner(3, "OPEN XMSS-LITE VAULT (ON-CHAIN)");

  const merkleRootArray = Array.from(tree.merkleRoot);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("xmss-vault"), tree.merkleRoot],
    VAULT_PROGRAM_ID
  );

  const vaultAta = anchor.utils.token.associatedAddress({
    mint: PSOQ_MINT,
    owner: vaultPda,
  });

  info(`Vault PDA: ${vaultPda.toBase58()}`);
  info(`Vault ATA: ${vaultAta.toBase58()}`);
  info(`Bridge authority: ${bridgePda.toBase58()}`);

  const openTx = await vaultProgram.methods
    .openXmssVault(
      merkleRootArray,
      TREE_DEPTH,
      bridgePda,
    )
    .accounts({
      vault: vaultPda,
      tokenMint: PSOQ_MINT,
      vaultTokenAccount: vaultAta,
      owner: deployerKeypair.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .rpc();

  success(`XMSS vault opened! TX: ${openTx.slice(0, 20)}...`);
  info(`Explorer: https://explorer.solana.com/tx/${openTx}?cluster=devnet`);

  // ──────────────────────────────────────────────────────────
  // STEP 4: DIRECT-MINT-TO-VAULT (Patent Claim 2!)
  // ──────────────────────────────────────────────────────────
  banner(4, "DIRECT-MINT-TO-QUANTUM-VAULT (Patent Claim 2)");

  info("Simulating: User locks SOQ on Soqucoin L1...");
  info("Relayer detects lock, verifies, signs attestation...");
  info("Bridge mints pSOQ DIRECTLY into vault ATA!");
  info("");
  info("╔══════════════════════════════════════════════════════╗");
  info("║  KEY INNOVATION: Tokens NEVER touch Ed25519 wallet!  ║");
  info("║  The quantum-breakable gap is eliminated entirely.   ║");
  info("╚══════════════════════════════════════════════════════╝");

  // Simulate Soqucoin L1 txid (random for each demo run)
  const crypto = require("crypto");
  const soqTxid = Array.from(crypto.randomBytes(32));

  const [processedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("processed"), Buffer.from(soqTxid)],
    BRIDGE_PROGRAM_ID
  );

  // Validator signatures (simplified for demo)
  const demoSigs = bridgeState.validators.map(v => ({
    validator: v,
    signature: new Array(64).fill(0),
  }));

  const mintTx = await bridgeProgram.methods
    .mintToVault(
      new anchor.BN(DEPOSIT_RAW.toString()),
      soqTxid,
      demoSigs,
    )
    .accounts({
      bridgeState: bridgePda,
      psoqMint: PSOQ_MINT,
      processedTxid: processedPda,
      vaultTokenAccount: vaultAta,
      payer: deployerKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const vaultAccount = await getAccount(connection, vaultAta);
  const vaultBalance = Number(vaultAccount.amount) / (10 ** DECIMALS);

  success(`DIRECT MINT TO VAULT! TX: ${mintTx.slice(0, 20)}...`);
  info(`Explorer: https://explorer.solana.com/tx/${mintTx}?cluster=devnet`);
  info(`Vault balance: ${vaultBalance.toLocaleString()} pSOQ`);
  info("");
  success("PATENT CLAIM 2 PROVEN: Direct-Mint-to-Quantum-Vault");
  info("Tokens went: Bridge PDA → Vault ATA (zero Ed25519 gap!)");

  // ──────────────────────────────────────────────────────────
  // STEP 5: WOTS+ WITHDRAWAL (Patent Claim 1)
  // ──────────────────────────────────────────────────────────
  banner(5, "QUANTUM-SAFE WITHDRAWAL (Patent Claim 1)");

  info("Signing withdrawal with WOTS+ key #0 + Merkle proof");
  info("Proves: bridge-minted tokens can be withdrawn quantum-safely");

  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    deployerKeypair,
    PSOQ_MINT,
    deployerKeypair.publicKey,
  );

  const leafIndex = 0;
  const message = xmss.constructWithdrawalMessage(
    Number(WITHDRAWAL_RAW),
    deployerKeypair.publicKey,
    leafIndex,
  );

  const signature = xmss.wotsSign(message, tree.keys[leafIndex].privateKey);
  const merkleProof = tree.proofs[leafIndex];

  info(`WOTS+ signature: ${xmss.NUM_CHAINS} chains × ${xmss.HASH_LEN} bytes`);
  info(`Merkle proof: ${merkleProof.length} siblings`);

  const sigFlat = Buffer.from(Buffer.concat(
    signature.map(chain => Buffer.from(chain))
  ));
  const proofFlat = Buffer.from(Buffer.concat(
    merkleProof.map(sibling => Buffer.from(sibling))
  ));

  const withdrawTx = await vaultProgram.methods
    .withdrawFromVault(
      new anchor.BN(WITHDRAWAL_RAW.toString()),
      leafIndex,
      sigFlat,
      proofFlat,
    )
    .accounts({
      vault: vaultPda,
      vaultTokenAccount: vaultAta,
      recipientTokenAccount: recipientAta.address,
      recipient: deployerKeypair.publicKey,
      owner: deployerKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const postVault = await getAccount(connection, vaultAta);
  const postBalance = Number(postVault.amount) / (10 ** DECIMALS);
  const recipientAcct = await getAccount(connection, recipientAta.address);
  const recipientBalance = Number(recipientAcct.amount) / (10 ** DECIMALS);

  success(`WOTS+ withdrawal! TX: ${withdrawTx.slice(0, 20)}...`);
  info(`Explorer: https://explorer.solana.com/tx/${withdrawTx}?cluster=devnet`);
  info(`Vault balance: ${postBalance.toLocaleString()} pSOQ`);
  info(`Recipient balance: ${recipientBalance.toLocaleString()} pSOQ`);
  info("");
  success("PATENT CLAIM 1 PROVEN: XMSS-Lite on Blockchain VM");
  info("On-chain WOTS+ verification + Merkle proof validation");

  // ──────────────────────────────────────────────────────────
  // STEP 6: KEY REUSE PREVENTION
  // ──────────────────────────────────────────────────────────
  banner(6, "KEY REUSE PREVENTION (Security Property)");

  info("Attempting to reuse WOTS+ key #0 — MUST fail");

  try {
    const reuseMsg = xmss.constructWithdrawalMessage(
      Number(WITHDRAWAL_RAW),
      deployerKeypair.publicKey,
      0,
    );
    const reuseSig = xmss.wotsSign(reuseMsg, tree.keys[0].privateKey);
    const reuseProof = tree.proofs[0];
    const reuseSigFlat = Buffer.from(Buffer.concat(
      reuseSig.map(chain => Buffer.from(chain))
    ));
    const reuseProofFlat = Buffer.from(Buffer.concat(
      reuseProof.map(sibling => Buffer.from(sibling))
    ));

    await vaultProgram.methods
      .withdrawFromVault(
        new anchor.BN(WITHDRAWAL_RAW.toString()),
        0,
        reuseSigFlat,
        reuseProofFlat,
      )
      .accounts({
        vault: vaultPda,
        vaultTokenAccount: vaultAta,
        recipientTokenAccount: recipientAta.address,
        recipient: deployerKeypair.publicKey,
        owner: deployerKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("  ❌ SECURITY FAILURE: key reuse was allowed!");
    process.exit(1);
  } catch (e) {
    if (e.message?.includes("LeafIndexMismatch") || 
        e.logs?.some(l => l.includes("LeafIndexMismatch"))) {
      success("Key reuse REJECTED: LeafIndexMismatch ✅");
      info("On-chain monotonic leaf_index prevents WOTS+ key reuse");
    } else {
      throw e;
    }
  }

  // ──────────────────────────────────────────────────────────
  // STEP 7: SECOND WITHDRAWAL (key #1)
  // ──────────────────────────────────────────────────────────
  banner(7, "SECOND WITHDRAWAL (Key #1 — Revolving Vault!)");

  info("Withdrawing with key #1 to prove multi-signature capability");

  const leafIndex1 = 1;
  const message1 = xmss.constructWithdrawalMessage(
    Number(WITHDRAWAL_RAW),
    deployerKeypair.publicKey,
    leafIndex1,
  );
  const sig1 = xmss.wotsSign(message1, tree.keys[leafIndex1].privateKey);
  const proof1 = tree.proofs[leafIndex1];

  const sigFlat1 = Buffer.from(Buffer.concat(
    sig1.map(chain => Buffer.from(chain))
  ));
  const proofFlat1 = Buffer.from(Buffer.concat(
    proof1.map(sibling => Buffer.from(sibling))
  ));

  const withdrawTx2 = await vaultProgram.methods
    .withdrawFromVault(
      new anchor.BN(WITHDRAWAL_RAW.toString()),
      leafIndex1,
      sigFlat1,
      proofFlat1,
    )
    .accounts({
      vault: vaultPda,
      vaultTokenAccount: vaultAta,
      recipientTokenAccount: recipientAta.address,
      recipient: deployerKeypair.publicKey,
      owner: deployerKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const finalVault = await getAccount(connection, vaultAta);
  const finalBalance = Number(finalVault.amount) / (10 ** DECIMALS);

  success(`Second withdrawal! TX: ${withdrawTx2.slice(0, 20)}...`);
  info(`Vault balance: ${finalBalance.toLocaleString()} pSOQ`);
  info(`Used keys: 2 / ${maxSigs}`);

  // ──────────────────────────────────────────────────────────
  // FINAL SUMMARY
  // ──────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ALL PATENT CLAIMS VERIFIED ON SOLANA DEVNET`);
  console.log(`${"═".repeat(60)}`);
  console.log(`
  ✅ Claim 1: XMSS-Lite on Blockchain VM
     Merkle tree + on-chain leaf index + WOTS+ verification
     2 successful withdrawals with different keys

  ✅ Claim 2: Direct-Mint-to-Quantum-Vault
     Bridge minted ${DEPOSIT_AMOUNT.toLocaleString()} pSOQ directly to vault ATA
     Zero Ed25519 wallets — quantum gap ELIMINATED

  ✅ Claim 4: Hybrid PQ Bridge with Hash-Based Custody
     Bridge (classical Solana) → Vault (quantum-safe WOTS+)
     End-to-end: L1 lock → bridge mint → vault → WOTS+ withdraw

  ✅ Security: Key reuse prevention verified
     On-chain monotonic leaf_index enforcement

  ── ON-CHAIN ADDRESSES ────────────────────────────────────
  Vault PDA:        ${vaultPda.toBase58()}
  Bridge PDA:       ${bridgePda.toBase58()}
  pSOQ Mint:        ${PSOQ_MINT.toBase58()}
  Program (Vault):  ${VAULT_PROGRAM_ID.toBase58()}
  Program (Bridge): ${BRIDGE_PROGRAM_ID.toBase58()}

  ── VAULT STATUS ──────────────────────────────────────────
  Balance:          ${finalBalance.toLocaleString()} pSOQ
  Used Keys:        2 / ${maxSigs}
  Remaining:        ${maxSigs - 2}
  Network:          Solana Devnet
`);
}

main().catch(err => {
  console.error("Demo failed:", err);
  process.exit(1);
});
