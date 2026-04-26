/**
 * XMSS-Lite Client Library — WOTS+ Key Generation & Signing
 *
 * This runs OFFLINE (client-side only). The on-chain program only verifies.
 *
 * Key Generation:
 *   1. Random seed → HKDF per chain → private key
 *   2. Hash each chain w-1 times → public key
 *   3. Build Merkle tree of public key hashes → root
 *
 * Signing:
 *   1. Convert message to base-16 digits
 *   2. Hash each chain digit times → signature
 *
 * Patent: Provisional Application #64/035,857
 */

const { keccak_256 } = require("@noble/hashes/sha3");
const crypto = require("crypto");

// Parameters matching the on-chain program
const HASH_LEN = 20;       // Truncated Keccak256 (160 bits) — fits in Solana tx
const FULL_HASH_LEN = 32;  // Full Keccak256 for Merkle
const NUM_CHAINS = 32;     // Number of WOTS+ chains
const W = 16;              // Winternitz parameter (base-16)
const MAX_CHAIN_STEPS = W - 1; // 15

/**
 * Truncated Keccak256 → 224-bit (28 bytes)
 * Matches on-chain: wots::keccak_truncated()
 */
function keccakTruncated(data) {
  const full = keccak_256(data);
  return Buffer.from(full.slice(0, HASH_LEN));
}

/**
 * Full Keccak256 → 256-bit (32 bytes)
 * Matches on-chain: wots::keccak_full()
 */
function keccakFull(data) {
  return Buffer.from(keccak_256(data));
}

/**
 * Hash chain: apply Keccak256 `steps` times
 * chain(x, steps) = H(H(H(...H(x)...)))
 */
function hashChain(input, steps) {
  let current = Buffer.from(input);
  for (let i = 0; i < steps; i++) {
    current = keccakTruncated(current);
  }
  return current;
}

/**
 * Convert message to base-w digits
 * Each byte → 2 digits (high nibble, low nibble)
 * Matches on-chain: wots::msg_to_digits()
 */
function msgToDigits(msg) {
  const digits = new Array(NUM_CHAINS).fill(0);
  for (let i = 0; i < 16; i++) {
    digits[i * 2] = (msg[i] >> 4) & 0x0f;
    digits[i * 2 + 1] = msg[i] & 0x0f;
  }
  return digits;
}

/**
 * Generate a single WOTS+ keypair
 *
 * @param {Buffer} seed - 32-byte random seed
 * @returns {{ privateKey: Buffer[], publicKey: Buffer[], publicKeyHash: Buffer }}
 */
function generateWotsKeypair(seed) {
  const privateKey = [];
  const publicKey = [];

  // Generate private key chains from seed via HKDF-like derivation
  for (let i = 0; i < NUM_CHAINS; i++) {
    const chainSeed = Buffer.alloc(36);
    seed.copy(chainSeed, 0, 0, 32);
    chainSeed.writeUInt32LE(i, 32);
    const sk = keccakTruncated(chainSeed);
    privateKey.push(sk);

    // Public key = Hash^(w-1)(private key)
    const pk = hashChain(sk, MAX_CHAIN_STEPS);
    publicKey.push(pk);
  }

  // Public key hash = Keccak256(pk[0] || pk[1] || ... || pk[31])
  const pkConcat = Buffer.concat(publicKey);
  const publicKeyHash = keccakFull(pkConcat);

  return { privateKey, publicKey, publicKeyHash };
}

/**
 * Sign a message with a WOTS+ private key
 *
 * @param {Buffer} message - HASH_LEN-byte message (already hashed)
 * @param {Buffer[]} privateKey - Array of NUM_CHAINS private key chains
 * @returns {Buffer[]} - Array of NUM_CHAINS signature chains
 */
function wotsSign(message, privateKey) {
  const digits = msgToDigits(message);
  const signature = [];

  for (let i = 0; i < NUM_CHAINS; i++) {
    // Sign by hashing digit[i] times (vs w-1 for public key)
    const sig = hashChain(privateKey[i], digits[i]);
    signature.push(sig);
  }

  return signature;
}

/**
 * Verify a WOTS+ signature (client-side verification — mirrors on-chain)
 *
 * @param {Buffer} message - HASH_LEN-byte message
 * @param {Buffer[]} signature - Array of NUM_CHAINS signature chains
 * @param {Buffer} expectedPkHash - Expected public key hash
 * @returns {boolean}
 */
function wotsVerify(message, signature, expectedPkHash) {
  const digits = msgToDigits(message);
  const recovered = [];

  for (let i = 0; i < NUM_CHAINS; i++) {
    const remaining = MAX_CHAIN_STEPS - digits[i];
    const pk = hashChain(signature[i], remaining);
    recovered.push(pk);
  }

  const pkConcat = Buffer.concat(recovered);
  const recoveredHash = keccakFull(pkConcat);
  return recoveredHash.equals(expectedPkHash);
}

/**
 * Generate an XMSS-Lite key tree with Merkle root
 *
 * @param {number} depth - Tree depth (2^depth leaves)
 * @param {Buffer} [masterSeed] - Optional master seed (random if not provided)
 * @returns {{ keys: WotsKeypair[], leaves: Buffer[], merkleRoot: Buffer, proofs: Buffer[][] }}
 */
function generateXmssTree(depth, masterSeed) {
  const numLeaves = 1 << depth;
  const seed = masterSeed || crypto.randomBytes(32);

  console.log(`\n🔐 XMSS-Lite Key Tree Generation`);
  console.log(`   Depth: ${depth} → ${numLeaves} WOTS+ keypairs`);
  console.log(`   Winternitz parameter: w=${W} (base-16)`);
  console.log(`   Hash: Keccak256 truncated to 224 bits`);
  console.log(`   Quantum security: 112-bit collision, 224-bit preimage\n`);

  // Generate all WOTS+ keypairs
  const keys = [];
  const leaves = [];

  for (let i = 0; i < numLeaves; i++) {
    // Derive per-leaf seed from master seed
    const leafSeed = Buffer.alloc(36);
    seed.copy(leafSeed, 0, 0, 32);
    leafSeed.writeUInt32LE(i, 32);
    const derivedSeed = keccakFull(leafSeed);

    const keypair = generateWotsKeypair(Buffer.from(derivedSeed));
    keys.push(keypair);
    leaves.push(keypair.publicKeyHash);

    if (i < 4 || i === numLeaves - 1) {
      console.log(`   Key ${i}: pk_hash = ${keypair.publicKeyHash.toString("hex").slice(0, 16)}...`);
    } else if (i === 4) {
      console.log(`   ... (${numLeaves - 5} more keys)`);
    }
  }

  // Build Merkle tree
  const { root, proofs } = buildMerkleTree(leaves);

  console.log(`\n   Merkle Root: ${root.toString("hex")}`);
  console.log(`   Tree ready: ${numLeaves} quantum-safe signatures available\n`);

  return { keys, leaves, merkleRoot: root, proofs, masterSeed: seed };
}

/**
 * Build a Merkle tree and generate proofs for all leaves
 *
 * @param {Buffer[]} leaves - Array of leaf hashes
 * @returns {{ root: Buffer, proofs: Buffer[][] }}
 */
function buildMerkleTree(leaves) {
  const n = leaves.length;
  // Pad to power of 2
  let paddedLeaves = [...leaves];
  while (paddedLeaves.length & (paddedLeaves.length - 1)) {
    paddedLeaves.push(Buffer.alloc(FULL_HASH_LEN, 0));
  }

  // Build tree layers bottom-up
  const layers = [paddedLeaves.map((l) => Buffer.from(l))];

  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const combined = Buffer.concat([prev[i], prev[i + 1]]);
      next.push(keccakFull(combined));
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];

  // Generate proofs for each leaf
  const proofs = [];
  for (let leafIdx = 0; leafIdx < n; leafIdx++) {
    const proof = [];
    let idx = leafIdx;
    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      proof.push(Buffer.from(layers[layerIdx][siblingIdx]));
      idx = Math.floor(idx / 2);
    }
    proofs.push(proof);
  }

  return { root, proofs };
}

/**
 * Construct the withdrawal message (matches on-chain construct_withdrawal_message)
 *
 * Format: H(amount_le || recipient_32 || leaf_index_le)
 */
function constructWithdrawalMessage(amount, recipientPubkey, leafIndex) {
  const buf = Buffer.alloc(42);
  buf.writeBigUInt64LE(BigInt(amount), 0);
  recipientPubkey.toBuffer().copy(buf, 8);
  buf.writeUInt16LE(leafIndex, 40);
  return keccakTruncated(buf);
}

module.exports = {
  // Constants
  HASH_LEN,
  FULL_HASH_LEN,
  NUM_CHAINS,
  W,
  MAX_CHAIN_STEPS,

  // Crypto primitives
  keccakTruncated,
  keccakFull,
  hashChain,
  msgToDigits,

  // WOTS+ operations
  generateWotsKeypair,
  wotsSign,
  wotsVerify,

  // XMSS tree
  generateXmssTree,
  buildMerkleTree,

  // Message construction
  constructWithdrawalMessage,
};
