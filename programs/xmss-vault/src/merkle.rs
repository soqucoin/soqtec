/// Merkle tree proof verification for XMSS-Lite vault
///
/// Verifies that a leaf (WOTS+ public key hash) belongs to a Merkle tree
/// with a known root. This enables the vault to support 2^depth different
/// WOTS+ keypairs while storing only the 32-byte root on-chain.
///
/// Patent: Provisional Application #64/035,857 — Claim 1
///   "Implementing a Merkle tree of WOTS+ keypairs as a smart contract
///    with on-chain state management of leaf index to prevent
///    cryptographic key reuse."

use crate::wots::{keccak_full, FULL_HASH_LEN};
use crate::errors::XmssError;

/// Verify a Merkle proof for a given leaf at a specific index
///
/// Arguments:
///   - leaf_hash: The hash of the leaf node (WOTS+ public key hash)
///   - leaf_index: Position of the leaf in the tree (0-indexed)
///   - proof: Array of sibling hashes along the path from leaf to root
///   - expected_root: The on-chain Merkle root to verify against
///
/// Returns: Ok(()) if proof is valid, Err if mismatch
pub fn verify_merkle_proof(
    leaf_hash: &[u8; FULL_HASH_LEN],
    leaf_index: u16,
    proof: &Vec<[u8; FULL_HASH_LEN]>,
    expected_root: &[u8; FULL_HASH_LEN],
) -> Result<(), anchor_lang::error::Error> {
    let mut current = *leaf_hash;
    let mut idx = leaf_index as u32;

    for sibling in proof.iter() {
        let mut combined = [0u8; FULL_HASH_LEN * 2];

        if idx % 2 == 0 {
            // Current node is left child
            combined[..FULL_HASH_LEN].copy_from_slice(&current);
            combined[FULL_HASH_LEN..].copy_from_slice(sibling);
        } else {
            // Current node is right child
            combined[..FULL_HASH_LEN].copy_from_slice(sibling);
            combined[FULL_HASH_LEN..].copy_from_slice(&current);
        }

        current = keccak_full(&combined);
        idx /= 2;
    }

    if current == *expected_root {
        Ok(())
    } else {
        Err(XmssError::InvalidMerkleProof.into())
    }
}

/// Compute Merkle root from a set of leaf hashes (client-side / test helper)
///
/// This is used offline to generate the Merkle root for vault initialization.
/// NOT called on-chain (too expensive), but useful for testing.
#[cfg(test)]
pub fn compute_merkle_root(leaves: &[[u8; FULL_HASH_LEN]]) -> [u8; FULL_HASH_LEN] {
    if leaves.len() == 1 {
        return leaves[0];
    }

    let mut layer: Vec<[u8; FULL_HASH_LEN]> = leaves.to_vec();

    // Pad to power of 2 if needed
    while layer.len() & (layer.len() - 1) != 0 || layer.len() < 2 {
        layer.push([0u8; FULL_HASH_LEN]);
    }

    while layer.len() > 1 {
        let mut next_layer = Vec::new();
        for pair in layer.chunks(2) {
            let mut combined = [0u8; FULL_HASH_LEN * 2];
            combined[..FULL_HASH_LEN].copy_from_slice(&pair[0]);
            combined[FULL_HASH_LEN..].copy_from_slice(&pair[1]);
            next_layer.push(keccak_full(&combined));
        }
        layer = next_layer;
    }

    layer[0]
}

/// Generate Merkle proof for a specific leaf index (client-side / test helper)
#[cfg(test)]
pub fn generate_merkle_proof(
    leaves: &[[u8; FULL_HASH_LEN]],
    index: usize,
) -> Vec<[u8; FULL_HASH_LEN]> {
    let mut proof = Vec::new();
    let mut layer: Vec<[u8; FULL_HASH_LEN]> = leaves.to_vec();

    // Pad to power of 2
    while layer.len() & (layer.len() - 1) != 0 || layer.len() < 2 {
        layer.push([0u8; FULL_HASH_LEN]);
    }

    let mut idx = index;

    while layer.len() > 1 {
        // Sibling index
        let sibling_idx = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
        if sibling_idx < layer.len() {
            proof.push(layer[sibling_idx]);
        } else {
            proof.push([0u8; FULL_HASH_LEN]);
        }

        // Compute next layer
        let mut next_layer = Vec::new();
        for pair in layer.chunks(2) {
            let mut combined = [0u8; FULL_HASH_LEN * 2];
            combined[..FULL_HASH_LEN].copy_from_slice(&pair[0]);
            combined[FULL_HASH_LEN..].copy_from_slice(&pair[1]);
            next_layer.push(keccak_full(&combined));
        }
        layer = next_layer;
        idx /= 2;
    }

    proof
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merkle_root_two_leaves() {
        let leaf0 = keccak_full(b"leaf0");
        let leaf1 = keccak_full(b"leaf1");
        let root = compute_merkle_root(&[leaf0, leaf1]);

        // Verify manually
        let mut combined = [0u8; 64];
        combined[..32].copy_from_slice(&leaf0);
        combined[32..].copy_from_slice(&leaf1);
        let expected = keccak_full(&combined);
        assert_eq!(root, expected);
    }

    #[test]
    fn test_merkle_proof_verification() {
        let leaves: Vec<[u8; 32]> = (0..4u8)
            .map(|i| keccak_full(&[i]))
            .collect();

        let root = compute_merkle_root(&leaves);

        // Verify each leaf
        for i in 0..4 {
            let proof = generate_merkle_proof(&leaves, i);
            let result = verify_merkle_proof(&leaves[i], i as u16, &proof, &root);
            assert!(result.is_ok(), "Proof failed for leaf {}", i);
        }
    }

    #[test]
    fn test_merkle_proof_wrong_leaf_fails() {
        let leaves: Vec<[u8; 32]> = (0..4u8)
            .map(|i| keccak_full(&[i]))
            .collect();

        let root = compute_merkle_root(&leaves);
        let proof = generate_merkle_proof(&leaves, 0);

        // Use wrong leaf — should fail
        let wrong_leaf = keccak_full(b"wrong");
        let result = verify_merkle_proof(&wrong_leaf, 0, &proof, &root);
        assert!(result.is_err());
    }

    #[test]
    fn test_merkle_proof_wrong_index_fails() {
        let leaves: Vec<[u8; 32]> = (0..4u8)
            .map(|i| keccak_full(&[i]))
            .collect();

        let root = compute_merkle_root(&leaves);
        let proof = generate_merkle_proof(&leaves, 0);

        // Use correct leaf but wrong index — should fail
        let result = verify_merkle_proof(&leaves[0], 1, &proof, &root);
        assert!(result.is_err());
    }
}
