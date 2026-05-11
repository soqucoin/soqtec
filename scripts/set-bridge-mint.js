/**
 * Set Bridge Mint — Updates the bridge_state.mint to match SoquShield's pSOQ mint
 * 
 * The bridge was initialized with mint 7TCU5SnLR7ARRAd8aUdoAFgw9zvCvzwdphm7TjUT6s46
 * but SoquShield uses 6gk5DxEkFXszk2naw9JpZa9DPy5XG9fBGBwfhhS1mMS6
 * 
 * This causes the BurnForRedemption constraint to fail:
 *   constraint = user_token_account.mint == bridge_state.mint
 * 
 * Usage: node scripts/set-bridge-mint.js
 */

const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const BRIDGE_PROGRAM_ID = new PublicKey("9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36");
const NEW_MINT = new PublicKey("6gk5DxEkFXszk2naw9JpZa9DPy5XG9fBGBwfhhS1mMS6");
const DEVNET_URL = "https://devnet.helius-rpc.com/?api-key=ea8d9de9-6ac5-429b-8225-4bc669e0c8d3";

async function main() {
  console.log("=== SET BRIDGE MINT ===");
  console.log(`New mint: ${NEW_MINT.toBase58()}`);

  const connection = new Connection(DEVNET_URL, "confirmed");
  const walletPath = path.join(process.env.HOME, ".config/solana/soqtec-deployer.json");
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "soqtec_bridge.json"), "utf-8")
  );
  const program = new anchor.Program(idl, provider);

  const [bridgeStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge")],
    BRIDGE_PROGRAM_ID
  );

  console.log(`Bridge State PDA: ${bridgeStatePda.toBase58()}`);

  // Read current state
  const stateBefore = await program.account.bridgeState.fetch(bridgeStatePda);
  console.log(`Current mint: ${stateBefore.mint.toBase58()}`);

  if (stateBefore.mint.toBase58() === NEW_MINT.toBase58()) {
    console.log("✅ Mint already correct — no action needed");
    return;
  }

  // Call set_mint
  const tx = await program.methods
    .setMint(NEW_MINT)
    .accounts({
      bridgeState: bridgeStatePda,
      authority: walletKeypair.publicKey,
    })
    .rpc();

  console.log(`✅ Mint updated! TX: ${tx}`);

  // Verify
  const stateAfter = await program.account.bridgeState.fetch(bridgeStatePda);
  console.log(`New mint (verified): ${stateAfter.mint.toBase58()}`);
  console.log(`Match: ${stateAfter.mint.toBase58() === NEW_MINT.toBase58() ? "✅" : "❌"}`);
}

main().catch(e => {
  console.error(`❌ Error: ${e.message}`);
  if (e.logs) e.logs.forEach(l => console.log(`  ${l}`));
  process.exit(1);
});
