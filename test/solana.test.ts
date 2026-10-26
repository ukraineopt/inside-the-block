import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { b58decode, b58encode } from '../src/b58.ts';
import { buildProbeTx, keypairFromSeed, maxFeeLamports } from '../src/solana.ts';
import { probeTag } from '../src/experiment.ts';

test('base58 roundtrip incl. leading zeros', () => {
  for (const hex of ['', '00', '0000ff', 'deadbeef', '00'.repeat(32)]) {
    const b = Buffer.from(hex, 'hex');
    assert.deepEqual(Buffer.from(b58decode(b58encode(b))), b);
  }
  assert.equal(b58encode(new Uint8Array(32)), '11111111111111111111111111111111');
});

test('known ed25519 vector: seed of zeros -> pubkey', () => {
  // RFC 8032 is for messages; the pubkey for the all-zero seed is a widely published constant.
  const kp = keypairFromSeed(new Uint8Array(32));
  assert.equal(Buffer.from(kp.pubkeyBytes).toString('hex'), '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29');
});

test('probe tx: signature verifies over the message, layout is legacy single-signer', () => {
  const kp = keypairFromSeed(new Uint8Array(32).fill(7));
  const tx = buildProbeTx({ payer: kp, blockhash: '11111111111111111111111111111111', cuLimit: 8000, cuPriceMicroLamports: 1000n, memo: probeTag(460812345, 'F', 3) });
  assert.equal(tx.wire[0], 1); // one signature
  const sig = tx.wire.subarray(1, 65);
  const msg = tx.wire.subarray(65);
  assert.deepEqual([...msg.subarray(0, 3)], [1, 0, 2]); // header
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), kp.pubkeyBytes]), format: 'der', type: 'spki' });
  assert.ok(verify(null, msg, pub, sig));
  assert.equal(b58encode(sig), tx.signature);
});

test('probe tag has fixed length 12', () => {
  for (const s of [0, 1, 460812345, 36 ** 7 + 5]) for (const i of [0, 7]) assert.equal(probeTag(s, 'T', i).length, 12);
});

test('max fee = 5000 + ceil(price*limit/1e6)', () => {
  assert.equal(maxFeeLamports(8000, 0n), 5000n);
  assert.equal(maxFeeLamports(8000, 500_000n), 9000n);
  assert.equal(maxFeeLamports(8000, 1n), 5001n); // rounds up
});
