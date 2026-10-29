// Collect: which probes landed (getSignatureStatuses), and the blocks of every target window (getBlock).
// Blocks are stored trimmed (order, fee, CU, compute-budget params, memo of our probes) in data/blocks/<slot>.json.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { b58decode } from './b58.ts';
import { log } from './log.ts';
import { rpc, RpcError, sleep } from './rpc.ts';
import { COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM } from './solana.ts';
import { SLOTS_PER_WINDOW } from './schedule.ts';

export interface BlockTx {
  i: number;
  sig: string;
  fee: number;
  cu: number | null;
  ok: boolean;
  isVote: boolean;
  cuPrice: string | null; // micro-lamports/CU; null = none set. For v1 txs derived from transactionConfig.
  cuLimit: number | null;
  prioFee: number; // lamports actually paid above the base fee (fee - 5000 * signatures)
  costUnits: number | null; // scheduler cost model units (meta.costUnits), the denominator of Agave's priority
  version: string; // "legacy" | "0" | "1"
  nSig: number;
  memo?: string; // only for our probes
}

export interface TrimmedBlock {
  slot: number;
  skipped: boolean;
  leader: string | null; // from the "Fee" reward recipient
  blockTime: number | null;
  blockHeight: number | null;
  parentSlot: number | null;
  blockhash: string | null;
  txCount: number;
  txs: BlockTx[];
}

interface RawBlock {
  blockhash: string;
  parentSlot: number;
  blockTime: number | null;
  blockHeight: number | null;
  rewards?: { pubkey: string; rewardType: string | null }[];
  transactions: {
    version?: number | 'legacy';
    meta: { fee: number; err: unknown; computeUnitsConsumed?: number; costUnits?: number } | null;
    transaction: {
      signatures: string[];
      message: {
        accountKeys: string[];
        instructions: { programIdIndex: number; data: string }[];
        // v1 transactions carry compute-budget settings in the message instead of ComputeBudget instructions
        transactionConfig?: { computeUnitLimit?: number | null; priorityFee?: number | null };
      };
    };
  }[];
}

const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';

export function trimBlock(slot: number, b: RawBlock, ourSigs: Set<string>): TrimmedBlock {
  const leader = b.rewards?.find((r) => r.rewardType === 'Fee')?.pubkey ?? null;
  const txs: BlockTx[] = b.transactions.map((t, i) => {
    const keys = t.transaction.message.accountKeys;
    let cuPrice: string | null = null;
    let cuLimit: number | null = null;
    let memo: string | undefined;
    let isVote = false;
    for (const ix of t.transaction.message.instructions) {
      const prog = keys[ix.programIdIndex];
      if (prog === VOTE_PROGRAM) isVote = true;
      else if (prog === COMPUTE_BUDGET_PROGRAM) {
        const d = Buffer.from(b58decode(ix.data));
        if (d[0] === 2 && d.length >= 5) cuLimit = d.readUInt32LE(1);
        if (d[0] === 3 && d.length >= 9) cuPrice = d.readBigUInt64LE(1).toString();
      } else if (prog === MEMO_PROGRAM && ourSigs.has(t.transaction.signatures[0])) {
        memo = Buffer.from(b58decode(ix.data)).toString('utf8');
      }
    }
    const tc = t.transaction.message.transactionConfig;
    if (tc) {
      if (tc.computeUnitLimit != null) cuLimit = tc.computeUnitLimit;
      if (tc.priorityFee != null && tc.computeUnitLimit) {
        cuPrice = ((BigInt(tc.priorityFee) * 1_000_000n) / BigInt(tc.computeUnitLimit)).toString();
      }
    }
    const nSig = t.transaction.signatures.length;
    const fee = t.meta?.fee ?? 0;
    return {
      i,
      sig: t.transaction.signatures[0],
      fee,
      cu: t.meta?.computeUnitsConsumed ?? null,
      ok: t.meta?.err == null,
      isVote,
      cuPrice,
      cuLimit,
      prioFee: Math.max(0, fee - 5000 * nSig),
      costUnits: t.meta?.costUnits ?? null,
      version: String(t.version ?? 'legacy'),
      nSig,
      ...(memo !== undefined ? { memo } : {}),
    };
  });
  return {
    slot, skipped: false, leader, blockTime: b.blockTime, blockHeight: b.blockHeight,
    parentSlot: b.parentSlot, blockhash: b.blockhash, txCount: txs.length, txs,
  };
}

export async function fetchBlock(rpcUrl: string, slot: number, ourSigs: Set<string>, blocksDir: string): Promise<TrimmedBlock> {
  const path = join(blocksDir, `${slot}.json`);
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8')) as TrimmedBlock;
    // re-fetch only if a probe signature we now know about is in it but its memo was not captured
    if (!cached.txs.some((t) => ourSigs.has(t.sig) && t.memo === undefined)) return cached;
  }
  let tb: TrimmedBlock;
  try {
    const b = await rpc<RawBlock>(rpcUrl, 'getBlock', [
      slot,
      { encoding: 'json', transactionDetails: 'full', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
    ]);
    if (!b) throw new Error(`getBlock ${slot}: empty result`); // public RPC occasionally answers null
    tb = trimBlock(slot, b, ourSigs);
  } catch (e) {
    // -32007 slot skipped / -32009 missing in long-term storage
    if (e instanceof RpcError && (e.code === -32007 || e.code === -32009)) {
      tb = { slot, skipped: true, leader: null, blockTime: null, blockHeight: null, parentSlot: null, blockhash: null, txCount: 0, txs: [] };
    } else throw e;
  }
  writeFileSync(path, JSON.stringify(tb));
  return tb;
}

export interface ProbeStatus {
  signature: string;
  slot: number | null;
  err: unknown;
  confirmationStatus: string | null;
}

export async function signatureStatuses(rpcUrl: string, sigs: string[]): Promise<ProbeStatus[]> {
  const out: ProbeStatus[] = [];
  for (let i = 0; i < sigs.length; i += 32) {
    const chunk = sigs.slice(i, i + 32); // public RPC: 32 sigs ~0.4 s, 128 sigs ~12 s (history lookups)
    const r = await rpc<{ value: ({ slot: number; err: unknown; confirmationStatus: string } | null)[] }>(
      rpcUrl, 'getSignatureStatuses', [chunk, { searchTransactionHistory: true }]);
    r.value.forEach((s, j) => out.push({ signature: chunk[j], slot: s?.slot ?? null, err: s?.err ?? null, confirmationStatus: s?.confirmationStatus ?? null }));
  }
  return out;
}

// Collect everything for one run directory. Idempotent: safe to re-run, cached blocks are reused.
export async function collectRun(rpcUrl: string, runDir: string, blocksDir: string): Promise<void> {
  mkdirSync(blocksDir, { recursive: true });
  const probes = readJsonl<{ signature: string; live: boolean; windowStart: number }>(join(runDir, 'probes.jsonl'));
  const windows = readJsonl<{ startSlot: number; status: string }>(join(runDir, 'windows.jsonl'));
  const liveSigs = probes.filter((p) => p.live).map((p) => p.signature);
  const statuses = liveSigs.length ? await signatureStatuses(rpcUrl, liveSigs) : [];
  writeFileSync(join(runDir, 'statuses.json'), JSON.stringify(statuses, null, 1));
  const ourSigs = new Set(liveSigs);
  const slots = new Set<number>();
  // every slot that holds a probe, plus the first slot of every window (leader check + supplementary data).
  // FULL_WINDOWS=1 fetches all 4 slots of each window (slow on the public RPC: ~5 s per full block).
  const span = process.env.FULL_WINDOWS === '1' ? SLOTS_PER_WINDOW : 1;
  for (const w of windows) if (w.status === 'sent') for (let s = 0; s < span; s++) slots.add(w.startSlot + s);
  for (const s of statuses) if (s.slot !== null) slots.add(s.slot);
  log('collect', { run: runDir, probes: probes.length, landed: statuses.filter((s) => s.slot !== null).length, blocks: slots.size });
  const failed: number[] = [];
  for (const slot of [...slots].sort((a, b) => a - b)) {
    try {
      await fetchBlock(rpcUrl, slot, ourSigs, blocksDir);
    } catch (e) {
      // one bad block must not lose the rest; `collect` is idempotent, re-run it to fill the gaps
      failed.push(slot);
      log('collect.block_failed', { slot, error: String(e) });
    }
    await sleep(150); // be gentle with public RPC
  }
  if (failed.length) log('collect.incomplete', { run: runDir, failed: failed.length, hint: 're-run `collect`' });
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}
