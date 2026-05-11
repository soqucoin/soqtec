/**
 * Cross-verification script: Generate test vectors from JS xmss-client.js
 * to validate the Dart WOTS+ implementation produces identical output.
 *
 * Run: node scripts/cross-verify-wots.js
 */

const { keccakTruncated, keccakFull, hashChain, msgToDigits,
        generateWotsKeypair, wotsSign, wotsVerify,
        generateXmssTree, constructWithdrawalMessage,
        HASH_LEN, FULL_HASH_LEN, NUM_CHAINS } = require('./xmss-client');

// Fixed seed (0, 1, 2, ..., 31) — matches Dart test
const testSeed = Buffer.alloc(32);
for (let i = 0; i < 32; i++) testSeed[i] = i;

console.log('=== WOTS+ Cross-Verification Test Vectors ===\n');

// Test 1: keccakTruncated([1,2,3,4])
const t1 = keccakTruncated(Buffer.from([1, 2, 3, 4]));
console.log(`keccakTruncated([1,2,3,4]) = ${t1.toString('hex')}`);

// Test 2: keccakFull([1,2,3,4])
const t2 = keccakFull(Buffer.from([1, 2, 3, 4]));
console.log(`keccakFull([1,2,3,4]) = ${t2.toString('hex')}`);

// Test 3: hashChain with 3 steps
const t3Input = keccakTruncated(Buffer.from([1, 2, 3]));
const t3 = hashChain(t3Input, 3);
console.log(`hashChain(keccak_t([1,2,3]), 3) = ${t3.toString('hex')}`);

// Test 4: msgToDigits
const t4Msg = Buffer.alloc(20);
t4Msg[0] = 0xAB;
t4Msg[1] = 0xCD;
const t4 = msgToDigits(t4Msg);
console.log(`msgToDigits(0xAB, 0xCD, 0...) = [${t4.slice(0, 6).join(',')}...]`);

// Test 5: WOTS+ keypair from test seed
const keypair = generateWotsKeypair(testSeed);
console.log(`\nWOTS+ Keypair (seed = 0..31):`);
console.log(`  sk[0]  = ${keypair.privateKey[0].toString('hex')}`);
console.log(`  pk[0]  = ${keypair.publicKey[0].toString('hex')}`);
console.log(`  pkHash = ${keypair.publicKeyHash.toString('hex')}`);

// Test 6: Sign + verify
const message = keccakTruncated(Buffer.from('test message'));
const sig = wotsSign(message, keypair.privateKey);
const verified = wotsVerify(message, sig, keypair.publicKeyHash);
console.log(`\nSign/Verify:`);
console.log(`  message = ${message.toString('hex')}`);
console.log(`  sig[0]  = ${sig[0].toString('hex')}`);
console.log(`  verified = ${verified}`);

// Test 7: XMSS tree with depth=2
const tree = generateXmssTree(2, testSeed);
console.log(`\nXMSS Tree (depth=2, seed=0..31):`);
console.log(`  merkleRoot = ${tree.merkleRoot.toString('hex')}`);
console.log(`  leaf[0] = ${tree.leaves[0].toString('hex')}`);
console.log(`  leaf[1] = ${tree.leaves[1].toString('hex')}`);
console.log(`  proof[0][0] = ${tree.proofs[0][0].toString('hex')}`);

// Test 8: Withdrawal message
const recipient = Buffer.alloc(32);
recipient[0] = 0xFF;
const wMsg = constructWithdrawalMessage(1000000000, { toBuffer: () => recipient }, 0);
console.log(`\nWithdrawal message (1B lamports, leaf=0):`);
console.log(`  message = ${wMsg.toString('hex')}`);

console.log('\n=== Done — compare these with Dart test output ===');
