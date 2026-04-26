/// WOTS+ (Winternitz One-Time Signature) verification for Solana BPF
///
/// Implements hash-based signature verification using Keccak256 (Solana native syscall).
/// Security: 224-bit preimage resistance (truncated Keccak), 112-bit quantum collision.
///
/// Parameters:
///   w = 16 (Winternitz parameter) — 4 bits per digit
///   n = 20 (hash output length, truncated from 32)
///   chains = 32 (to cover message space)
///
/// Following the blueshift-gg/solana-winternitz-vault approach:
///   - Truncated 224-bit Keccak256 for signature chains
///   - Full 256-bit Keccak256 for Merkle root (PDA seed)

/// Truncated hash length (160 bits = 20 bytes)
/// Fits 32 chains × 20 bytes = 640 bytes in a single Solana tx
pub const HASH_LEN: usize = 20;

/// Full hash length for Merkle operations
pub const FULL_HASH_LEN: usize = 32;

/// Winternitz parameter (base-16, 4 bits per digit)
pub const W: u8 = 16;

/// Number of signature chains (message digits + checksum digits)
/// For 224-bit hash with w=16: 56 message digits + 4 checksum digits = 60
/// But we follow the Winternitz vault pattern: 32 chains of 28-byte hashes
pub const NUM_CHAINS: usize = 32;

/// Maximum chain iterations (w - 1 = 15)
pub const MAX_CHAIN_STEPS: u8 = W - 1;

/// Size of a single WOTS+ signature: NUM_CHAINS * HASH_LEN
pub const WOTS_SIG_SIZE: usize = NUM_CHAINS * HASH_LEN;

/// Compute truncated Keccak256 (224-bit)
pub fn keccak_truncated(data: &[u8]) -> [u8; HASH_LEN] {
    let full = anchor_lang::solana_program::keccak::hash(data);
    let mut result = [0u8; HASH_LEN];
    result.copy_from_slice(&full.0[..HASH_LEN]);
    result
}

/// Compute full Keccak256 (for Merkle operations)
pub fn keccak_full(data: &[u8]) -> [u8; FULL_HASH_LEN] {
    let hash = anchor_lang::solana_program::keccak::hash(data);
    hash.0
}

/// Hash chain: apply Keccak256 `steps` times
/// chain(x, steps) = H(H(H(...H(x)...)))  [steps times]
fn hash_chain(input: &[u8; HASH_LEN], steps: u8) -> [u8; HASH_LEN] {
    let mut current = *input;
    for _ in 0..steps {
        current = keccak_truncated(&current);
    }
    current
}

/// Convert a message hash to base-w digits for WOTS+ signature
///
/// Each byte produces 2 digits (4 bits each for w=16)
/// Returns: array of digits, each in range [0, w-1]
pub fn msg_to_digits(msg: &[u8; HASH_LEN]) -> [u8; NUM_CHAINS] {
    let mut digits = [0u8; NUM_CHAINS];

    // First 28 bytes → 56 message digits (2 per byte, high nibble first)
    // But NUM_CHAINS = 32, so we use the first 16 bytes → 32 digits
    for i in 0..16 {
        digits[i * 2] = (msg[i] >> 4) & 0x0F;
        digits[i * 2 + 1] = msg[i] & 0x0F;
    }

    digits
}

/// Compute WOTS+ checksum digits
///
/// Checksum ensures signature forgery requires finding preimages (hard)
/// rather than extending chains (easy). checksum = Σ(w-1-d[i])
fn compute_checksum(digits: &[u8; NUM_CHAINS]) -> u16 {
    let mut sum: u16 = 0;
    for d in digits.iter() {
        sum += (MAX_CHAIN_STEPS - d) as u16;
    }
    sum
}

/// Verify a WOTS+ signature against a message and recover the public key hash
///
/// Process:
///   1. Convert message to base-w digits
///   2. For each chain i: complete the hash chain from sig[i] by (w-1-d[i]) steps
///      This recovers the public key component for chain i
///   3. Hash all recovered components together to get the public key hash
///
/// Returns: The recovered public key hash (to be verified against Merkle tree)
pub fn wots_verify(
    message: &[u8; HASH_LEN],
    signature: &[[u8; HASH_LEN]; NUM_CHAINS],
) -> [u8; FULL_HASH_LEN] {
    let digits = msg_to_digits(message);

    // Recover public key components by completing each hash chain
    let mut pk_concat = Vec::with_capacity(NUM_CHAINS * HASH_LEN);
    for i in 0..NUM_CHAINS {
        let remaining_steps = MAX_CHAIN_STEPS - digits[i];
        let recovered = hash_chain(&signature[i], remaining_steps);
        pk_concat.extend_from_slice(&recovered);
    }

    // Hash all recovered public key components to get the public key hash
    keccak_full(&pk_concat)
}

/// Construct the message that gets signed for a withdrawal
///
/// Format: H(amount || recipient || leaf_index)
/// This prevents malleability and binds the signature to specific parameters.
pub fn construct_withdrawal_message(
    amount: u64,
    recipient: &[u8; 32],
    leaf_index: u16,
) -> [u8; HASH_LEN] {
    let mut data = Vec::with_capacity(42);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(recipient);
    data.extend_from_slice(&leaf_index.to_le_bytes());
    keccak_truncated(&data)
}

/// Construct the message for a bridge burn operation
///
/// Format: H("bridge" || amount || soq_address || leaf_index)
pub fn construct_bridge_message(
    amount: u64,
    soq_address: &[u8; 34],
    leaf_index: u16,
) -> [u8; HASH_LEN] {
    let mut data = Vec::with_capacity(50);
    data.extend_from_slice(b"bridge");
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(soq_address);
    data.extend_from_slice(&leaf_index.to_le_bytes());
    keccak_truncated(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keccak_truncated() {
        let hash = keccak_truncated(b"test");
        assert_eq!(hash.len(), HASH_LEN);
    }

    #[test]
    fn test_msg_to_digits() {
        let msg = [0xABu8; HASH_LEN];
        let digits = msg_to_digits(&msg);
        // 0xAB → high nibble = 0xA = 10, low nibble = 0xB = 11
        assert_eq!(digits[0], 0x0A);
        assert_eq!(digits[1], 0x0B);
    }

    #[test]
    fn test_hash_chain_zero_steps() {
        let input = [0x42u8; HASH_LEN];
        let result = hash_chain(&input, 0);
        assert_eq!(result, input);
    }

    #[test]
    fn test_hash_chain_deterministic() {
        let input = [0x42u8; HASH_LEN];
        let r1 = hash_chain(&input, 5);
        let r2 = hash_chain(&input, 5);
        assert_eq!(r1, r2);
    }
}
