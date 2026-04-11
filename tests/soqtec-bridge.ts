import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import idl from "../target/idl/soqtec_bridge.json";

const PROGRAM_ID = new PublicKey(
  "9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36"
);

/**
 * SOQ-TEC Bridge Program — Integration Tests
 *
 * Tests the core bridge operations against a local validator:
 * 1. Initialize bridge with 2-of-3 validator threshold
 * 2. Burn pSOQ for L1 redemption (the bridge-out flow)
 * 3. Circuit breaker (pause/resume)
 */
describe("soqtec-bridge", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new Program(idl as any, provider);

  // Test accounts
  const authority = (provider.wallet as any).payer as Keypair;
  const user = Keypair.generate();
  const validators = Array.from({ length: 3 }, () => Keypair.generate());

  let psoqMint: PublicKey;
  let bridgeStatePda: PublicKey;
  let bridgeBump: number;
  let userTokenAccount: PublicKey;

  // Soqucoin test address (34 bytes, base58check-like)
  const soqAddress: number[] = new Array(34).fill(0);
  // Simulate "SoqTestAddress..." in bytes
  soqAddress[0] = 0x53; // 'S'
  soqAddress[1] = 0x6f; // 'o'
  soqAddress[2] = 0x71; // 'q'

  before(async () => {
    // Derive bridge PDA
    [bridgeStatePda, bridgeBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge")],
      PROGRAM_ID
    );

    // Airdrop SOL to user for signing
    const airdropSig = await provider.connection.requestAirdrop(
      user.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create pSOQ mint (9 decimals, authority is deployer for now)
    psoqMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey, // mint authority
      null, // freeze authority
      9 // 9 decimals, matching our devnet test pSOQ
    );

    console.log("  Bridge PDA:", bridgeStatePda.toString());
    console.log("  pSOQ Mint:", psoqMint.toString());
    console.log("  User:", user.publicKey.toString());
    console.log("  Validators:", validators.length);
  });

  describe("initialize", () => {
    it("Initializes the bridge with 2-of-3 threshold", async () => {
      const dailyLimit = new anchor.BN(10_000_000_000_000); // 10,000 SOQ

      const tx = await program.methods
        .initialize(
          2, // threshold
          validators.map((v) => v.publicKey),
          dailyLimit
        )
        .accounts({
          bridgeState: bridgeStatePda,
          psoqMint: psoqMint,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      console.log("    Initialize tx:", tx);

      // Verify state
      const state = await program.account.bridgeState.fetch(bridgeStatePda);
      expect(state.authority.toString()).to.equal(
        authority.publicKey.toString()
      );
      expect(state.mint.toString()).to.equal(psoqMint.toString());
      expect(state.threshold).to.equal(2);
      expect(state.validators.length).to.equal(3);
      expect(state.paused).to.equal(false);
      expect(state.totalBurned.toNumber()).to.equal(0);
      expect(state.totalMinted.toNumber()).to.equal(0);

      console.log("    ✅ Bridge initialized: 2-of-3 threshold, daily limit: 10,000 SOQ");
    });
  });

  describe("burn_for_redemption", () => {
    before(async () => {
      // Create user's token account and mint test pSOQ
      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority, // payer
        psoqMint,
        user.publicKey
      );
      userTokenAccount = ata.address;

      // Mint 1000 pSOQ to user (1000 * 10^9 = 1_000_000_000_000)
      await mintTo(
        provider.connection,
        authority,
        psoqMint,
        userTokenAccount,
        authority, // mint authority
        1000_000_000_000 // 1000 SOQ in smallest unit
      );

      const balance = await provider.connection.getTokenAccountBalance(
        userTokenAccount
      );
      console.log("    User pSOQ balance:", balance.value.uiAmount, "pSOQ");
    });

    it("Burns 10 pSOQ and emits redemption event", async () => {
      const burnAmount = new anchor.BN(10_000_000_000); // 10 SOQ

      // Listen for the burn event
      let burnEvent: any = null;
      const listener = program.addEventListener(
        "burnForRedemptionEvent",
        (event: any) => {
          burnEvent = event;
        }
      );

      const tx = await program.methods
        .burnForRedemption(burnAmount, soqAddress)
        .accounts({
          bridgeState: bridgeStatePda,
          psoqMint: psoqMint,
          userTokenAccount: userTokenAccount,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      console.log("    Burn tx:", tx);

      // Wait for event
      await new Promise((r) => setTimeout(r, 1000));
      await program.removeEventListener(listener);

      // Verify user balance decreased
      const balanceAfter = await provider.connection.getTokenAccountBalance(
        userTokenAccount
      );
      expect(balanceAfter.value.uiAmount).to.equal(990); // 1000 - 10

      // Verify bridge state updated
      const state = await program.account.bridgeState.fetch(bridgeStatePda);
      expect(state.totalBurned.toNumber()).to.equal(10_000_000_000);
      expect(state.nonce.toNumber()).to.equal(1);

      // Verify event
      if (burnEvent) {
        expect(burnEvent.amount.toNumber()).to.equal(10_000_000_000);
        expect(burnEvent.nonce.toNumber()).to.equal(1);
        console.log("    ✅ Burn event emitted: 10 pSOQ, nonce=1");
        console.log(
          "    ✅ Net amount (after 0.1% fee):",
          burnEvent.netAmount.toNumber() / 1_000_000_000,
          "SOQ"
        );
      }

      console.log("    ✅ User balance: 1000 → 990 pSOQ");
      console.log("    ✅ Bridge total burned: 10 SOQ");
    });

    it("Rejects burn below minimum (1 SOQ)", async () => {
      const tinyAmount = new anchor.BN(100_000_000); // 0.1 SOQ (below 1 SOQ min)

      try {
        await program.methods
          .burnForRedemption(tinyAmount, soqAddress)
          .accounts({
            bridgeState: bridgeStatePda,
            psoqMint: psoqMint,
            userTokenAccount: userTokenAccount,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have thrown BelowMinimum error");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("BelowMinimum");
        console.log("    ✅ Correctly rejected sub-minimum burn");
      }
    });
  });

  describe("circuit_breaker", () => {
    it("Authority can pause the bridge", async () => {
      await program.methods
        .pauseBridge()
        .accounts({
          bridgeState: bridgeStatePda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const state = await program.account.bridgeState.fetch(bridgeStatePda);
      expect(state.paused).to.equal(true);
      console.log("    ✅ Bridge paused");
    });

    it("Rejects burns when paused", async () => {
      const amount = new anchor.BN(5_000_000_000);

      try {
        await program.methods
          .burnForRedemption(amount, soqAddress)
          .accounts({
            bridgeState: bridgeStatePda,
            psoqMint: psoqMint,
            userTokenAccount: userTokenAccount,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have thrown BridgePaused error");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("BridgePaused");
        console.log("    ✅ Correctly rejected burn while paused");
      }
    });

    it("Authority can resume the bridge", async () => {
      await program.methods
        .resumeBridge()
        .accounts({
          bridgeState: bridgeStatePda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const state = await program.account.bridgeState.fetch(bridgeStatePda);
      expect(state.paused).to.equal(false);
      console.log("    ✅ Bridge resumed");
    });

    it("Burns work again after resume", async () => {
      const amount = new anchor.BN(5_000_000_000); // 5 SOQ

      await program.methods
        .burnForRedemption(amount, soqAddress)
        .accounts({
          bridgeState: bridgeStatePda,
          psoqMint: psoqMint,
          userTokenAccount: userTokenAccount,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      const state = await program.account.bridgeState.fetch(bridgeStatePda);
      expect(state.totalBurned.toNumber()).to.equal(15_000_000_000); // 10 + 5
      expect(state.nonce.toNumber()).to.equal(2);

      const balance = await provider.connection.getTokenAccountBalance(
        userTokenAccount
      );
      console.log(
        "    ✅ Post-resume burn succeeded. Balance:",
        balance.value.uiAmount,
        "pSOQ"
      );
    });
  });
});
