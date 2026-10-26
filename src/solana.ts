// Dependency-free legacy transaction building and ed25519 signing (node:crypto).
// Every transaction this project sends is one of two shapes:
//   probe:    [SetComputeUnitLimit, SetComputeUnitPrice, Memo(tag)]   payer = only signer
//   transfer: [SetComputeUnitLimit, SetComputeUnitPrice, System.Transfer]
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { b58decode, b58encode } from './b58.ts';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const LAMPORTS_PER_SIGNATURE = 5000;

export interface Keypair {
  publicKey: string;
  pubkeyBytes: Uint8Array;
  privateKey: KeyObject;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function keypairFromSeed(seed: Uint8Array): Keypair {
  if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const pubkeyBytes = new Uint8Array(spki.subarray(spki.length - 32));
  return { publicKey: b58encode(pubkeyBytes), pubkeyBytes, privateKey };
}

// Solana CLI keypair file: JSON array of 64 bytes (32 seed + 32 pubkey).
export function loadKeypairFile(path: string): Keypair {
  const arr = JSON.parse(readFileSync(path, 'utf8')) as number[];
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`${path}: expected a 64-byte JSON array keypair`);
  const kp = keypairFromSeed(Uint8Array.from(arr.slice(0, 32)));
  if (kp.publicKey !== b58encode(Uint8Array.from(arr.slice(32)))) throw new Error(`${path}: pubkey does not match seed`);
  return kp;
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

interface CompiledIx {
  programIndex: number;
  accounts: number[];
  data: Uint8Array;
}

function serializeMessage(
  header: [number, number, number],
  keys: string[],
  blockhash: string,
  ixs: CompiledIx[],
): Buffer {
  const parts: (Buffer | Uint8Array)[] = [Buffer.from(header), Buffer.from(compactU16(keys.length))];
  for (const k of keys) parts.push(b58decode(k));
  parts.push(b58decode(blockhash));
  parts.push(Buffer.from(compactU16(ixs.length)));
  for (const ix of ixs) {
    parts.push(Buffer.from([ix.programIndex]));
    parts.push(Buffer.from(compactU16(ix.accounts.length)), Buffer.from(ix.accounts));
    parts.push(Buffer.from(compactU16(ix.data.length)), ix.data);
  }
  return Buffer.concat(parts);
}

export interface SignedTx {
  signature: string;
  wire: Buffer;
}

function signMessage(payer: Keypair, message: Buffer): SignedTx {
  const sig = sign(null, message, payer.privateKey);
  return { signature: b58encode(sig), wire: Buffer.concat([Buffer.from(compactU16(1)), sig, message]) };
}

export function computeBudgetIxData(cuLimit: number, cuPriceMicroLamports: bigint): [Uint8Array, Uint8Array] {
  return [
    Buffer.concat([Buffer.from([2]), u32le(cuLimit)]),
    Buffer.concat([Buffer.from([3]), u64le(cuPriceMicroLamports)]),
  ];
}

export function buildProbeTx(p: {
  payer: Keypair;
  blockhash: string;
  cuLimit: number;
  cuPriceMicroLamports: bigint;
  memo: string;
}): SignedTx {
  // keys: [payer (signer, writable), ComputeBudget (ro), Memo (ro)]
  const keys = [p.payer.publicKey, COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM];
  const [limit, price] = computeBudgetIxData(p.cuLimit, p.cuPriceMicroLamports);
  const msg = serializeMessage([1, 0, 2], keys, p.blockhash, [
    { programIndex: 1, accounts: [], data: limit },
    { programIndex: 1, accounts: [], data: price },
    { programIndex: 2, accounts: [], data: Buffer.from(p.memo, 'utf8') },
  ]);
  return signMessage(p.payer, msg);
}

export function buildTransferTx(p: {
  from: Keypair;
  to: string;
  lamports: bigint;
  blockhash: string;
  cuLimit: number;
  cuPriceMicroLamports: bigint;
}): SignedTx {
  // keys: [from (signer, writable), to (writable), ComputeBudget (ro), System (ro)]
  const keys = [p.from.publicKey, p.to, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM];
  const [limit, price] = computeBudgetIxData(p.cuLimit, p.cuPriceMicroLamports);
  const msg = serializeMessage([1, 0, 2], keys, p.blockhash, [
    { programIndex: 2, accounts: [], data: limit },
    { programIndex: 2, accounts: [], data: price },
    { programIndex: 3, accounts: [0, 1], data: Buffer.concat([u32le(2), u64le(p.lamports)]) },
  ]);
  return signMessage(p.from, msg);
}

// Upper bound of what a single-signature tx can cost: base fee + ceil(price * limit / 1e6).
export function maxFeeLamports(cuLimit: number, cuPriceMicroLamports: bigint, signatures = 1): bigint {
  const prio = (cuPriceMicroLamports * BigInt(cuLimit) + 999_999n) / 1_000_000n;
  return BigInt(LAMPORTS_PER_SIGNATURE * signatures) + prio;
}
