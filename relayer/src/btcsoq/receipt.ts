/**
 * BTCSOQ receipt tag codec — the OP_RETURN payload minted alongside every
 * receipt carrier UTXO (DL §4.4: a receipt's lifecycle is reconstructible
 * from chain data + this tag; anyone can rebuild the ledger without our DB).
 *
 * Layout (49 bytes, well under the 80-byte OP_RETURN ceiling):
 *   magic   "BSQ1"          4 bytes   (mirrors the SNS1 purpose-binding style;
 *                                      the signer's mint endpoint refuses
 *                                      anything not BSQ1-prefixed)
 *   op      'M' | 'R'       1 byte    mint | redemption spend
 *   sats    u64 LE          8 bytes   BTC satoshis the receipt is backed by
 *   btcTxid                32 bytes   deposit txid, display order (explorer hex)
 *   vout    u32 LE          4 bytes   deposit output index
 */

export const BSQ_MAGIC = 'BSQ1';
export const BSQ_OP_MINT = 0x4d;    // 'M'
export const BSQ_OP_REDEEM = 0x52;  // 'R'
export const BSQ_TAG_LEN = 49;

export interface BtcsoqTag {
  op: 'mint' | 'redeem';
  sats: bigint;
  btcTxid: string;
  vout: number;
}

export function encodeTag(op: 'mint' | 'redeem', sats: bigint, btcTxid: string, vout: number): Buffer {
  if (!/^[0-9a-f]{64}$/.test(btcTxid)) {
    throw new Error(`encodeTag: malformed txid ${btcTxid}`);
  }
  if (sats < 0n || sats > 0xffffffffffffffffn) {
    throw new Error(`encodeTag: sats out of u64 range: ${sats}`);
  }
  const buf = Buffer.alloc(BSQ_TAG_LEN);
  buf.write(BSQ_MAGIC, 0, 'ascii');
  buf.writeUInt8(op === 'mint' ? BSQ_OP_MINT : BSQ_OP_REDEEM, 4);
  buf.writeBigUInt64LE(sats, 5);
  Buffer.from(btcTxid, 'hex').copy(buf, 13);
  buf.writeUInt32LE(vout, 45);
  return buf;
}

export function decodeTag(buf: Buffer): BtcsoqTag | null {
  if (buf.length !== BSQ_TAG_LEN) return null;
  if (buf.toString('ascii', 0, 4) !== BSQ_MAGIC) return null;
  const opByte = buf.readUInt8(4);
  if (opByte !== BSQ_OP_MINT && opByte !== BSQ_OP_REDEEM) return null;
  return {
    op: opByte === BSQ_OP_MINT ? 'mint' : 'redeem',
    sats: buf.readBigUInt64LE(5),
    btcTxid: buf.subarray(13, 45).toString('hex'),
    vout: buf.readUInt32LE(45),
  };
}

/**
 * The exact scriptPubKey hex the signer's AddOutputOPReturn produces for a
 * 49-byte payload: OP_RETURN (0x6a) + direct push length (0x31) + payload.
 * Used for chain-side recovery matching (find our mint tx after a crash).
 */
export function tagScriptHex(payload: Buffer): string {
  if (payload.length >= 0x4c) {
    throw new Error('tagScriptHex: payload requires OP_PUSHDATA1, unexpected for BSQ tags');
  }
  return '6a' + payload.length.toString(16).padStart(2, '0') + payload.toString('hex');
}

/** Parse a BSQ tag out of an OP_RETURN scriptPubKey hex, if present. */
export function tagFromScriptHex(scriptHex: string): BtcsoqTag | null {
  if (!scriptHex || !scriptHex.startsWith('6a')) return null;
  // Direct-push only (0x31 = 49); BSQ tags never need PUSHDATA1.
  const lenByte = parseInt(scriptHex.slice(2, 4), 16);
  if (lenByte !== BSQ_TAG_LEN) return null;
  const payload = Buffer.from(scriptHex.slice(4), 'hex');
  return decodeTag(payload);
}
