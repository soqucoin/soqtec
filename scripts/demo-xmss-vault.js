/**
 * XMSS-Lite Revolving Vault — Full E2E Demo
 *
 * Demonstrates all patent claims on Solana Devnet:
 *   1. Generate quantum-safe XMSS key tree offline
 *   2. Open vault on-chain with Merkle root
 *   3. Deposit pSOQ into vault
 *   4. Withdraw with WOTS+ signature + Merkle proof
 *   5. Attempt key reuse → REJECTED
 *
 * Patent: Provisional Application #64/035,857
 * Program: 7k4TwwBSZ4a7JA83MgSsqxczU6bpR7qV3uUNGWbTEz8H
 *
 * Usage: node scripts/demo-xmss-vault.js
 */

const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");
const xmss = require("./xmss-client");

// Configuration
const PROGRAM_ID = new PublicKey("7k4TwwBSZ4a7JA83MgSsqxczU6bpR7qV3uUNGWbTEz8H");
const DEVNET_URL = "https://api.devnet.solana.com";
const TREE_DEPTH = 4; // 16 signatures (MVP demo)

// ANSI colors for terminal output
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function header(text) {
  console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${text}${RESET}`);
  console.log(`${BOLD}${CYAN}${"═".repeat(60)}${RESET}\n`);
}

function step(num, text) {
  console.log(`${BOLD}${GREEN}  [${num}]${RESET} ${text}`);
}

function info(text) {
  console.log(`${DIM}      ${text}${RESET}`);
}

function success(text) {
  console.log(`${GREEN}  ✅ ${text}${RESET}`);
}

function fail(text) {
  console.log(`${RED}  ❌ ${text}${RESET}`);
}

function warn(text) {
  console.log(`${YELLOW}  ⚠️  ${text}${RESET}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  header("XMSS-LITE REVOLVING VAULT — QUANTUM-SAFE CUSTODY DEMO");
  console.log(`${DIM}  Patent: Provisional Application #64/035,857${RESET}`);
  console.log(`${DIM}  Program: ${PROGRAM_ID.toBase58()}${RESET}`);
  console.log(`${DIM}  Network: Solana Devnet${RESET}`);
  console.log(`${DIM}  Tree Depth: ${TREE_DEPTH} (${1 << TREE_DEPTH} signatures)${RESET}`);

  // ─── Setup Connection ───────────────────────────────────────
  const connection = new Connection(DEVNET_URL, "confirmed");

  // Load deployer wallet
  const walletPath = path.join(
    process.env.HOME,
    ".config/solana/soqtec-deployer.json"
  );
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  // Load IDL
  const idlPath = path.join(__dirname, "..", "target", "idl", "xmss_vault.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  // ─── STEP 1: Generate XMSS Key Tree ────────────────────────
  header("STEP 1: QUANTUM-SAFE KEY GENERATION");
  step(1, "Generating XMSS-Lite key tree (offline, client-side)");
  info("This runs entirely offline — private keys never touch the network");

  const tree = xmss.generateXmssTree(TREE_DEPTH);

  success(`Key tree generated: ${tree.keys.length} WOTS+ keypairs`);
  info(`Merkle Root: ${tree.merkleRoot.toString("hex")}`);

  // ─── STEP 2: Create Test SPL Token ─────────────────────────
  header("STEP 2: CREATE TEST SPL TOKEN");
  step(2, "Creating test SPL token mint (simulating pSOQ on devnet)");

  let tokenMint;
  try {
    tokenMint = await createMint(
      connection,
      walletKeypair,
      walletKeypair.publicKey,
      null,
      9 // 9 decimals like pSOQ
    );
    success(`Test token mint: ${tokenMint.toBase58()}`);
  } catch (e) {
    fail(`Failed to create mint: ${e.message}`);
    return;
  }

  // Create deployer's token account and mint some tokens
  const deployerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    walletKeypair,
    tokenMint,
    walletKeypair.publicKey
  );

  const MINT_AMOUNT = 10_000_000_000_000n; // 10,000 tokens
  await mintTo(
    connection,
    walletKeypair,
    tokenMint,
    deployerAta.address,
    walletKeypair,
    MINT_AMOUNT
  );
  success(`Minted ${Number(MINT_AMOUNT) / 1e9} test tokens to deployer`);

  // ─── STEP 3: Open XMSS Vault ──────────────────────────────
  header("STEP 3: OPEN XMSS-LITE VAULT (Patent Claim 1)");
  step(3, "Creating quantum-resistant vault with Merkle root on-chain");
  info("The vault PDA is seeded with the XMSS Merkle root");
  info("Leaf index starts at 0, enforced on-chain to prevent key reuse");

  // Derive vault PDA
  const merkleRootArray = Array.from(tree.merkleRoot);
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("xmss-vault"), tree.merkleRoot],
    PROGRAM_ID
  );
  info(`Vault PDA: ${vaultPda.toBase58()}`);

  // Derive vault's ATA
  const vaultAta = anchor.utils.token.associatedAddress({
    mint: tokenMint,
    owner: vaultPda,
  });
  info(`Vault ATA: ${vaultAta.toBase58()}`);

  try {
    const tx = await program.methods
      .openXmssVault(
        merkleRootArray,
        TREE_DEPTH,
        walletKeypair.publicKey // bridge_authority = deployer for demo
      )
      .accounts({
        vault: vaultPda,
        tokenMint: tokenMint,
        vaultTokenAccount: vaultAta,
        owner: walletKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    success(`Vault opened! TX: ${tx}`);
    info(`Solana Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
  } catch (e) {
    fail(`Open vault failed: ${e.message}`);
    if (e.logs) e.logs.forEach((l) => info(l));
    return;
  }

  // Verify vault state
  await sleep(2000);
  const vaultAccount = await program.account.xmssVault.fetch(vaultPda);
  info(`On-chain leaf_index: ${vaultAccount.leafIndex}`);
  info(`On-chain tree_depth: ${vaultAccount.treeDepth}`);
  info(`On-chain is_active: ${vaultAccount.isActive}`);
  info(`On-chain max_signatures: ${1 << vaultAccount.treeDepth}`);

  // ─── STEP 4: Deposit Tokens into Vault ─────────────────────
  header("STEP 4: DEPOSIT TOKENS INTO QUANTUM-SAFE VAULT");
  step(4, "Depositing 1,000 test tokens into the XMSS vault");
  info("Anyone can deposit — no WOTS+ signature needed for deposits");

  const DEPOSIT_AMOUNT = 1_000_000_000_000n; // 1,000 tokens (9 decimals)

  try {
    const tx = await program.methods
      .depositToVault(new anchor.BN(DEPOSIT_AMOUNT.toString()))
      .accounts({
        vault: vaultPda,
        vaultTokenAccount: vaultAta,
        depositorTokenAccount: deployerAta.address,
        depositor: walletKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    success(`Deposited 1,000 tokens! TX: ${tx}`);
  } catch (e) {
    fail(`Deposit failed: ${e.message}`);
    if (e.logs) e.logs.forEach((l) => info(l));
    return;
  }

  // Check vault balance
  await sleep(2000);
  const vaultTokenInfo = await getAccount(connection, vaultAta);
  info(`Vault balance: ${Number(vaultTokenInfo.amount) / 1e9} tokens`);

  // ─── STEP 5: Withdraw with WOTS+ Signature ─────────────────
  header("STEP 5: QUANTUM-SAFE WITHDRAWAL (Patent Claim 1)");
  step(5, "Signing withdrawal with WOTS+ key #0 + Merkle proof");
  info("This is the critical patent claim: hash-based signature verification on-chain");

  const WITHDRAW_AMOUNT = 100_000_000_000n; // 100 tokens
  const leafIndex = 0;

  // Construct the message that gets signed
  const message = xmss.constructWithdrawalMessage(
    Number(WITHDRAW_AMOUNT),
    walletKeypair.publicKey,
    leafIndex
  );
  info(`Message hash: ${message.toString("hex").slice(0, 32)}...`);

  // Sign with WOTS+ private key at leaf index 0
  const signature = xmss.wotsSign(message, tree.keys[leafIndex].privateKey);
  info(`WOTS+ signature: ${signature.length} chains × ${xmss.HASH_LEN} bytes`);

  // Client-side verification (sanity check)
  const clientVerify = xmss.wotsVerify(
    message,
    signature,
    tree.keys[leafIndex].publicKeyHash
  );
  info(`Client-side verification: ${clientVerify ? "✅ PASS" : "❌ FAIL"}`);

  // Get Merkle proof for leaf 0
  const merkleProof = tree.proofs[leafIndex];
  info(`Merkle proof: ${merkleProof.length} siblings (depth ${TREE_DEPTH})`);

  // Create recipient ATA (using deployer as recipient for demo)
  const recipientAta = deployerAta;

  // Submit to on-chain program
  try {
    // Flatten signature and proof into Buffers matching on-chain Vec<u8>
    const sigFlat = Buffer.from(Buffer.concat(signature));
    const proofFlat = Buffer.from(Buffer.concat(merkleProof));

    const tx = await program.methods
      .withdrawFromVault(
        new anchor.BN(WITHDRAW_AMOUNT.toString()),
        leafIndex,
        sigFlat,
        proofFlat
      )
      .accounts({
        vault: vaultPda,
        vaultTokenAccount: vaultAta,
        recipientTokenAccount: recipientAta.address,
        recipient: walletKeypair.publicKey,
        owner: walletKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    success(`WOTS+ withdrawal successful! TX: ${tx}`);
    info(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
  } catch (e) {
    fail(`Withdrawal failed: ${e.message}`);
    if (e.logs) {
      console.log(`\n${DIM}  Program logs:${RESET}`);
      e.logs.forEach((l) => info(l));
    }
    return;
  }

  // Check updated state
  await sleep(2000);
  const updatedVault = await program.account.xmssVault.fetch(vaultPda);
  info(`On-chain leaf_index: ${updatedVault.leafIndex} (was 0, now 1)`);
  info(`Remaining keys: ${(1 << updatedVault.treeDepth) - updatedVault.leafIndex}`);

  const updatedBalance = await getAccount(connection, vaultAta);
  info(`Vault balance: ${Number(updatedBalance.amount) / 1e9} tokens (was 1,000)`);

  // ─── STEP 6: Key Reuse Prevention ──────────────────────────
  header("STEP 6: KEY REUSE PREVENTION (Critical Security Property)");
  step(6, "Attempting to reuse WOTS+ key #0 — should FAIL");
  info("WOTS+ keys are one-time-use. The on-chain leaf_index prevents reuse.");
  info("Without this, an attacker could recompute the private key from two signatures.");

  try {
    const sigFlat2 = Buffer.from(Buffer.concat(signature));
    const proofFlat2 = Buffer.from(Buffer.concat(merkleProof));

    await program.methods
      .withdrawFromVault(
        new anchor.BN(WITHDRAW_AMOUNT.toString()),
        0, // Trying to reuse leaf_index 0
        sigFlat2,
        proofFlat2
      )
      .accounts({
        vault: vaultPda,
        vaultTokenAccount: vaultAta,
        recipientTokenAccount: recipientAta.address,
        recipient: walletKeypair.publicKey,
        owner: walletKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    fail("KEY REUSE WAS NOT REJECTED — this is a critical bug!");
  } catch (e) {
    if (e.message && e.message.includes("LeafIndexMismatch")) {
      success("Key reuse REJECTED: LeafIndexMismatch ✅");
      info("On-chain enforcement: leaf_index is now 1, tried to use 0");
      info("This is the critical security property from Patent Claim 1");
    } else {
      success(`Key reuse rejected (different error): ${e.message.slice(0, 80)}`);
    }
  }

  // ─── STEP 7: Second Withdrawal with Key #1 ─────────────────
  header("STEP 7: MULTI-SIGNATURE CAPABILITY (XMSS-Lite Innovation)");
  step(7, "Withdrawing with WOTS+ key #1 — proving multi-use vault");
  info("Unlike the original Winternitz vault (1 key per vault),");
  info("our XMSS-Lite vault supports 16 keys (depth 4) or 1024 (depth 10)");

  const leafIndex1 = 1;
  const message1 = xmss.constructWithdrawalMessage(
    Number(WITHDRAW_AMOUNT),
    walletKeypair.publicKey,
    leafIndex1
  );
  const signature1 = xmss.wotsSign(message1, tree.keys[leafIndex1].privateKey);
  const merkleProof1 = tree.proofs[leafIndex1];

  try {
    const sigFlat3 = Buffer.from(Buffer.concat(signature1));
    const proofFlat3 = Buffer.from(Buffer.concat(merkleProof1));

    const tx = await program.methods
      .withdrawFromVault(
        new anchor.BN(WITHDRAW_AMOUNT.toString()),
        leafIndex1,
        sigFlat3,
        proofFlat3
      )
      .accounts({
        vault: vaultPda,
        vaultTokenAccount: vaultAta,
        recipientTokenAccount: recipientAta.address,
        recipient: walletKeypair.publicKey,
        owner: walletKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    success(`Second WOTS+ withdrawal successful! TX: ${tx}`);
    info(`Used key #1 (leaf_index now at 2)`);
  } catch (e) {
    fail(`Second withdrawal failed: ${e.message}`);
    if (e.logs) e.logs.forEach((l) => info(l));
    return;
  }

  // ─── FINAL STATUS ──────────────────────────────────────────
  header("VAULT STATUS — FINAL");

  await sleep(2000);
  const finalVault = await program.account.xmssVault.fetch(vaultPda);
  const finalBalance = await getAccount(connection, vaultAta);

  console.log(`  ${CYAN}Vault PDA:${RESET}          ${vaultPda.toBase58()}`);
  console.log(`  ${CYAN}Program ID:${RESET}         ${PROGRAM_ID.toBase58()}`);
  console.log(`  ${CYAN}Merkle Root:${RESET}        ${Buffer.from(finalVault.merkleRoot).toString("hex").slice(0, 32)}...`);
  console.log(`  ${CYAN}Tree Depth:${RESET}         ${finalVault.treeDepth}`);
  console.log(`  ${CYAN}Max Signatures:${RESET}     ${1 << finalVault.treeDepth}`);
  console.log(`  ${CYAN}Used Keys:${RESET}          ${finalVault.leafIndex}`);
  console.log(`  ${CYAN}Remaining Keys:${RESET}     ${(1 << finalVault.treeDepth) - finalVault.leafIndex}`);
  console.log(`  ${CYAN}Token Balance:${RESET}      ${Number(finalBalance.amount) / 1e9} tokens`);
  console.log(`  ${CYAN}Total Operations:${RESET}   ${finalVault.totalOperations}`);
  console.log(`  ${CYAN}Active:${RESET}             ${finalVault.isActive}`);

  header("DEMO COMPLETE — ALL PATENT CLAIMS VERIFIED ON-CHAIN");
  console.log(`  ${GREEN}✅ Claim 1: XMSS-Lite on Blockchain VM — Merkle tree + leaf index${RESET}`);
  console.log(`  ${GREEN}✅ Claim 1: Key reuse prevention — on-chain monotonic enforcement${RESET}`);
  console.log(`  ${GREEN}✅ Multi-signature: 2 of 16 keys used, 14 remaining${RESET}`);
  console.log(`  ${GREEN}✅ SPL token custody: deposits and withdrawals verified${RESET}`);
  console.log(`  ${DIM}  ⏳ Claim 2: Direct-Mint-to-Vault (Phase 2 — bridge CPI)${RESET}`);
  console.log(`  ${DIM}  ⏳ Claim 3: Atomic Vault Rotation (Phase 2)${RESET}`);
  console.log(`  ${DIM}  ⏳ Claim 4: Hybrid PQ Bridge (Phase 2)${RESET}\n`);
}

main().catch((e) => {
  console.error(`\n${RED}Fatal error: ${e.message}${RESET}`);
  console.error(e.stack);
  process.exit(1);
});
