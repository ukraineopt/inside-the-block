// Analysis. Unit of evidence = an ordered PAIR of our own probes that landed in the SAME block.
// For each pair we ask two yes/no questions:
//   priority-concordant: did the probe with the higher compute-unit price land earlier?
//   send-concordant:     did the probe we sent earlier land earlier?
// Pairs inside one batch are not independent, so confidence intervals are bootstrapped over batches.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonl, type TrimmedBlock } from './collect.ts';
import { rng } from './rng.ts';
import type { ProbeRecord } from './experiment.ts';
import { feeVsArrivalSvg } from './figures.ts';
import { mkdirSync } from 'node:fs';

interface Landed extends ProbeRecord {
  leaderClient: string; // client group of the leader that actually produced the block
  slot: number;
  index: number; // position inside the block
  leader: string | null;
  ok: boolean;
}

interface PairStats {
  n: number;
  concordant: number;
}

export interface GroupResult {
  group: string;
  arm: string;
  path: string;
  batches: number;
  probesSent: number;
  probesLanded: number;
  sameBlockPairs: number;
  priority: { rate: number | null; ci: [number, number] | null; pairs: number };
  send: { rate: number | null; ci: [number, number] | null; pairs: number };
  inTargetLeader: number; // landed probes whose block was produced by the targeted leader
  medianGapTxs: number | null; // foreign txs between consecutive probes of a batch in the same block
}

function loadBlocks(dir: string): Map<number, TrimmedBlock> {
  const m = new Map<number, TrimmedBlock>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) {
    const b = JSON.parse(readFileSync(join(dir, f), 'utf8')) as TrimmedBlock;
    m.set(b.slot, b);
  }
  return m;
}

function pairStats(probes: Landed[], key: (p: Landed) => bigint): PairStats {
  const s: PairStats = { n: 0, concordant: 0 };
  for (let a = 0; a < probes.length; a++) for (let b = a + 1; b < probes.length; b++) {
    const pa = probes[a], pb = probes[b];
    if (pa.slot !== pb.slot) continue;
    const ka = key(pa), kb = key(pb);
    if (ka === kb) continue;
    s.n++;
    // "higher key should come first"
    const firstIsHigher = (pa.index < pb.index) === (ka > kb);
    if (firstIsHigher) s.concordant++;
  }
  return s;
}

function bootstrap(batches: PairStats[], seed = 7, iters = 2000): [number, number] | null {
  const valid = batches.filter((b) => b.n > 0);
  if (!valid.length) return null;
  const rand = rng(seed);
  const rates: number[] = [];
  for (let it = 0; it < iters; it++) {
    let n = 0, c = 0;
    for (let k = 0; k < valid.length; k++) {
      const b = valid[Math.floor(rand() * valid.length)];
      n += b.n;
      c += b.concordant;
    }
    rates.push(c / n);
  }
  rates.sort((a, b) => a - b);
  return [rates[Math.floor(iters * 0.025)], rates[Math.floor(iters * 0.975)]];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function analyze(dataDir: string): { results: GroupResult[]; landed: Landed[]; passive: PassiveResult[] } {
  const blocks = loadBlocks(join(dataDir, 'blocks'));
  const runsDir = join(dataDir, 'runs');
  const probes: ProbeRecord[] = [];
  if (existsSync(runsDir)) for (const r of readdirSync(runsDir)) probes.push(...readJsonl<ProbeRecord>(join(runsDir, r, 'probes.jsonl')));
  // index every probe signature found in any stored block
  const where = new Map<string, { slot: number; index: number; leader: string | null; ok: boolean }>();
  for (const b of blocks.values()) for (const t of b.txs) if (t.memo?.startsWith('itb')) where.set(t.sig, { slot: b.slot, index: t.i, leader: b.leader, ok: t.ok });
  const live = probes.filter((p) => p.live);
  const snaps = snapshots(dataDir);
  const landed: Landed[] = live.filter((p) => where.has(p.signature)).map((p) => {
    const w = where.get(p.signature)!;
    return { ...p, ...w, leaderClient: w.leader ? groupForRun(snaps, p.runId, w.leader) : 'unknown' };
  });

  // Evidence is attributed to whoever BUILT the block, not to whom we aimed at:
  // a probe that spills into the next leader's block is evidence about that next leader.
  const groups = new Map<string, Landed[]>();
  for (const p of landed) {
    const k = `${p.leaderClient}\u0000${p.arm}\u0000${p.path ?? 'rpc'}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const results: GroupResult[] = [];
  for (const [k, ps] of groups) {
    const [group, arm, path] = k.split('\u0000');
    const batchIds = [...new Set(ps.map((p) => `${p.runId}/${p.batchId}`))];
    const sentToGroup = live.filter((p) => p.targetClient === group && p.arm === arm && (p.path ?? 'rpc') === path).length;
    const prio: PairStats[] = [], send: PairStats[] = [];
    const gaps: number[] = [];
    let inTarget = 0;
    for (const bid of batchIds) {
      const lb = ps.filter((p) => `${p.runId}/${p.batchId}` === bid);
      prio.push(pairStats(lb, (p) => BigInt(p.cuPrice)));
      send.push(pairStats(lb, (p) => -BigInt(p.sendSeq))); // earlier send = "higher"
      inTarget += lb.filter((p) => p.leader === p.targetIdentity).length;
      const bySlot = new Map<number, number[]>();
      for (const p of lb) bySlot.set(p.slot, [...(bySlot.get(p.slot) ?? []), p.index]);
      for (const idx of bySlot.values()) {
        idx.sort((a, b) => a - b);
        for (let i = 1; i < idx.length; i++) gaps.push(idx[i] - idx[i - 1] - 1);
      }
    }
    const sum = (xs: PairStats[]) => xs.reduce((a, b) => ({ n: a.n + b.n, concordant: a.concordant + b.concordant }), { n: 0, concordant: 0 });
    const P = sum(prio), S = sum(send);
    results.push({
      group, arm, path, batches: batchIds.length, probesSent: sentToGroup,
      probesLanded: ps.length,
      sameBlockPairs: S.n,
      priority: { rate: P.n ? P.concordant / P.n : null, ci: bootstrap(prio), pairs: P.n },
      send: { rate: S.n ? S.concordant / S.n : null, ci: bootstrap(send), pairs: S.n },
      inTargetLeader: inTarget,
      medianGapTxs: median(gaps),
    });
  }
  results.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || a.arm.localeCompare(b.arm));
  return { results, landed, passive: passiveAnalysis(blocks, dataDir) };
}

// Supplementary (not primary evidence): in every collected block, how well does position follow the
// compute-unit price of ALL other non-vote transactions? Spearman rho between index and cuPrice.
export interface PassiveResult {
  group: string;
  blocks: number;
  meanRho: number | null;
  medianTxs: number | null;
}

function spearman(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 10) return null;
  const rank = (v: number[]) => {
    const idx = v.map((val, i) => [val, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

// leader identity -> client group AT THE TIME OF MEASUREMENT. Validators upgrade (between 25.10 and
// 29.10 several moved to 4.4.0-rc.1 / 26.10.5), so each run uses its own start snapshot, and a block
// outside any run uses the latest snapshot taken before it.
interface Snapshot {
  run: string;
  t: number; // ms, run start
  groups: Map<string, string>;
}

function snapshots(dataDir: string): Snapshot[] {
  const out: Snapshot[] = [];
  const runsDir = join(dataDir, 'runs');
  if (existsSync(runsDir)) for (const r of readdirSync(runsDir).sort()) {
    const f = join(runsDir, r, 'validators-start.json');
    if (!existsSync(f)) continue;
    const groups = new Map<string, string>();
    for (const v of JSON.parse(readFileSync(f, 'utf8')) as { identity: string; clientId: string; version: string }[]) {
      groups.set(v.identity, `${v.clientId} ${v.version}`);
    }
    // run id = ISO time with ':' and '.' replaced by '-', e.g. 2026-10-25T11-57-49-live
    const iso = r.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3') + 'Z';
    out.push({ run: r, t: Date.parse(iso), groups });
  }
  return out.sort((a, b) => a.t - b.t);
}

function groupForRun(snaps: Snapshot[], run: string, identity: string): string {
  return snaps.find((s) => s.run === run)?.groups.get(identity) ?? 'unknown';
}

function groupAtTime(snaps: Snapshot[], tMs: number | null, identity: string): string {
  let best = snaps[0];
  for (const s of snaps) if (tMs !== null && s.t <= tMs) best = s;
  return best?.groups.get(identity) ?? 'unknown';
}

function passiveAnalysis(blocks: Map<number, TrimmedBlock>, dataDir: string): PassiveResult[] {
  const snaps = snapshots(dataDir);
  const acc = new Map<string, { rhos: number[]; sizes: number[] }>();
  for (const b of blocks.values()) {
    if (b.skipped || !b.leader) continue;
    const g = groupAtTime(snaps, b.blockTime === null ? null : b.blockTime * 1000, b.leader);
    const txs = b.txs.filter((t) => !t.isVote);
    // -index so that rho > 0 means "higher price sits earlier"
    const rho = spearman(txs.map((t) => Number(t.cuPrice ?? 0)), txs.map((t) => -t.i));
    const a = acc.get(g) ?? { rhos: [], sizes: [] };
    if (rho !== null) a.rhos.push(rho);
    a.sizes.push(b.txCount);
    acc.set(g, a);
  }
  return [...acc.entries()].map(([group, a]) => ({
    group, blocks: a.sizes.length,
    meanRho: a.rhos.length ? a.rhos.reduce((x, y) => x + y, 0) / a.rhos.length : null,
    medianTxs: median(a.sizes),
  })).sort((a, b) => a.group.localeCompare(b.group));
}

// The decisive comparison: pairs in one block where the HIGHER-fee probe left our sidecar at the same time
// or LATER than the lower-fee one. If the leader orders by fee, the higher-fee probe still comes first;
// if it orders by arrival, it comes second. Bucketed by how much later it was sent (tpu path only,
// where the sidecar timestamps every stream in microseconds).
export interface FeeVsArrival {
  group: string;
  arm: string;
  bucket: string;
  pairs: number;
  batches: number;
  feeWins: number | null;
  ci: [number, number] | null;
}

const BUCKETS: [string, number, number][] = [
  ['same burst (<1 ms)', 0, 1_000],
  ['1-20 ms later', 1_000, 20_000],
  ['20-50 ms later', 20_000, 50_000],
  ['50-150 ms later', 50_000, 150_000],
];

// lead (slots before the window at send time) per run, for records written before it was stored per probe
function runLeads(dataDir: string): Map<string, number> {
  const m = new Map<string, number>();
  const runsDir = join(dataDir, 'runs');
  if (existsSync(runsDir)) for (const r of readdirSync(runsDir)) {
    const f = join(runsDir, r, 'config.json');
    if (!existsSync(f)) continue;
    const c = JSON.parse(readFileSync(f, 'utf8')) as { leadSlots: number | number[] };
    if (typeof c.leadSlots === 'number') m.set(r, c.leadSlots);
    else if (c.leadSlots.length === 1) m.set(r, c.leadSlots[0]);
  }
  return m;
}

export function feeVsArrival(landed: Landed[], leads: Map<string, number> = new Map()): FeeVsArrival[] {
  const byBlock = new Map<string, Landed[]>();
  for (const p of landed) {
    if (p.path !== 'tpu' || !p.sentAtUs) continue;
    const k = `${p.runId}/${p.batchId}/${p.slot}`;
    byBlock.set(k, [...(byBlock.get(k) ?? []), p]);
  }
  const acc = new Map<string, Map<string, PairStats>>(); // key -> batch -> stats
  for (const [blockKey, ps] of byBlock) {
    const batch = blockKey.split('/').slice(0, 2).join('/');
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
      const fa = BigInt(ps[a].cuPrice), fb = BigInt(ps[b].cuPrice);
      if (fa === fb) continue;
      const [hi, lo] = fa > fb ? [ps[a], ps[b]] : [ps[b], ps[a]];
      const dt = Number(BigInt(hi.sentAtUs!) - BigInt(lo.sentAtUs!));
      if (dt < 0) continue; // higher fee was sent earlier: both rules agree, no information
      let bucket = BUCKETS.find(([, lo_, hi_]) => dt >= lo_ && dt < hi_)?.[0];
      if (!bucket) continue;
      // for bursts, WHEN they reach the leader matters: queued before its slot, or trickling in mid-block
      if (bucket === BUCKETS[0][0]) bucket += `, sent ${hi.leadSlots ?? leads.get(hi.runId) ?? '?'} slot(s) early`;
      const key = `${hi.leaderClient}\u0000${hi.arm}\u0000${bucket}`;
      const m = acc.get(key) ?? new Map<string, PairStats>();
      const st = m.get(batch) ?? { n: 0, concordant: 0 };
      st.n++;
      if (hi.index < lo.index) st.concordant++;
      m.set(batch, st);
      acc.set(key, m);
    }
  }
  const out: FeeVsArrival[] = [];
  for (const [key, m] of acc) {
    const [group, arm, bucket] = key.split('\u0000');
    const all = [...m.values()];
    const n = all.reduce((x, y) => x + y.n, 0), c = all.reduce((x, y) => x + y.concordant, 0);
    out.push({ group, arm, bucket, pairs: n, batches: all.length, feeWins: n ? c / n : null, ci: bootstrap(all) });
  }
  const rank = (x: string) => (x.startsWith('same burst') ? 0 : BUCKETS.findIndex((b) => b[0] === x));
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.arm.localeCompare(b.arm) || rank(a.bucket) - rank(b.bucket) || a.bucket.localeCompare(b.bucket));
}

// "Sorted runs": read the fees of one batch's probes in block order and count the maximal stretches
// in which the fee never increases. 1 = the whole batch is sorted by fee; a random order of 8 distinct
// fees gives 4.5 on average. A scheduler that sorts by priority within each pass and takes passes in
// arrival order produces a few sorted stretches: that is what vanilla Agave's greedy scheduler predicts.
export interface SortedRuns {
  group: string;
  mode: string;
  batches: number;
  meanRuns: number;
  fullySorted: number;
}

function descendingRuns(fees: bigint[]): number {
  let runs = 1;
  for (let i = 1; i < fees.length; i++) if (fees[i] > fees[i - 1]) runs++;
  return runs;
}

export function sortedRuns(landed: Landed[], modes: Map<string, string>): SortedRuns[] {
  const byBlock = new Map<string, Landed[]>();
  for (const p of landed) {
    if (p.arm !== 'F' || p.path !== 'tpu') continue;
    const k = `${p.runId}/${p.batchId}/${p.slot}`;
    byBlock.set(k, [...(byBlock.get(k) ?? []), p]);
  }
  const acc = new Map<string, number[]>();
  for (const ps of byBlock.values()) {
    if (ps.length !== 8) continue; // only complete batches in one block, so the random baseline is 4.5
    ps.sort((a, b) => a.index - b.index);
    const lead = ps[0].leadSlots;
    const base = ps[0].sendGapMs !== undefined ? (ps[0].sendGapMs === 0 ? 'burst' : `spaced ${ps[0].sendGapMs} ms`) : (modes.get(ps[0].runId) ?? '?');
    const mode = base + (lead !== undefined && base === 'burst' ? `, ${lead} slot(s) early` : '');
    const key = `${ps[0].leaderClient}\u0000${mode}`;
    acc.set(key, [...(acc.get(key) ?? []), descendingRuns(ps.map((p) => BigInt(p.cuPrice)))]);
  }
  return [...acc.entries()].map(([k, r]) => {
    const [group, mode] = k.split('\u0000');
    return { group, mode, batches: r.length, meanRuns: r.reduce((a, b) => a + b, 0) / r.length, fullySorted: r.filter((x) => x === 1).length };
  }).sort((a, b) => a.group.localeCompare(b.group) || a.mode.localeCompare(b.mode));
}

// timing mode per run from config.json: "spaced 15 ms" or "burst"
function runModes(dataDir: string): Map<string, string> {
  const m = new Map<string, string>();
  const runsDir = join(dataDir, 'runs');
  if (existsSync(runsDir)) for (const r of readdirSync(runsDir)) {
    const f = join(runsDir, r, 'config.json');
    if (!existsSync(f)) continue;
    const c = JSON.parse(readFileSync(f, 'utf8')) as { sendGapMs: number; timings?: { gapMs: number; lead: number }[] };
    if (c.timings?.length) m.set(r, 'mixed ' + c.timings.map((t) => `${t.gapMs}ms@${t.lead}`).join(' '));
    else m.set(r, c.sendGapMs === 0 ? 'burst' : `spaced ${c.sendGapMs} ms`);
  }
  return m;
}

// Same fee-vs-arrival question, split by the validator that built the block: are validators of one
// client consistent with each other, or is it one operator's configuration?
export interface PerValidator {
  leader: string;
  group: string;
  burstPairs: number;
  burstFeeWins: number | null;
  laterPairs: number; // higher-fee probe sent >= 1 ms later
  laterFeeWins: number | null;
}

export function perValidator(landed: Landed[]): PerValidator[] {
  const byBlock = new Map<string, Landed[]>();
  for (const p of landed) {
    if (p.arm !== 'F' || p.path !== 'tpu' || !p.sentAtUs || !p.leader) continue;
    const k = `${p.runId}/${p.batchId}/${p.slot}`;
    byBlock.set(k, [...(byBlock.get(k) ?? []), p]);
  }
  const acc = new Map<string, { group: string; b: [number, number]; l: [number, number] }>();
  for (const ps of byBlock.values()) for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
    const fa = BigInt(ps[a].cuPrice), fb = BigInt(ps[b].cuPrice);
    if (fa === fb) continue;
    const [hi, lo] = fa > fb ? [ps[a], ps[b]] : [ps[b], ps[a]];
    const dt = Number(BigInt(hi.sentAtUs!) - BigInt(lo.sentAtUs!));
    if (dt < 0) continue;
    const e = acc.get(hi.leader!) ?? { group: hi.leaderClient, b: [0, 0], l: [0, 0] };
    const slot = dt < 1_000 ? e.b : e.l;
    slot[0]++;
    if (hi.index < lo.index) slot[1]++;
    acc.set(hi.leader!, e);
  }
  return [...acc.entries()].map(([leader, e]) => ({
    leader, group: e.group,
    burstPairs: e.b[0], burstFeeWins: e.b[0] ? e.b[1] / e.b[0] : null,
    laterPairs: e.l[0], laterFeeWins: e.l[0] ? e.l[1] / e.l[0] : null,
  })).sort((a, b) => a.group.localeCompare(b.group) || b.burstPairs + b.laterPairs - a.burstPairs - a.laterPairs);
}

// One complete batch per client and condition, with explorer links, so anyone can look at the block.
export function examples(landed: Landed[], leads: Map<string, number>, modes: Map<string, string>): string[] {
  const byBlock = new Map<string, Landed[]>();
  for (const p of landed) {
    if (p.arm !== 'F' || p.path !== 'tpu') continue;
    const k = `${p.runId}/${p.batchId}/${p.slot}`;
    byBlock.set(k, [...(byBlock.get(k) ?? []), p]);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const blocks = [...byBlock.values()].filter((ps) => ps.length === 8).sort((a, b) => a[0].slot - b[0].slot);
  for (const ps of blocks) {
    ps.sort((a, b) => a.index - b.index);
    const mode = ps[0].sendGapMs !== undefined ? (ps[0].sendGapMs === 0 ? 'burst' : `spaced ${ps[0].sendGapMs} ms`) : (modes.get(ps[0].runId) ?? '?');
    const cond = mode === 'burst' ? `burst, ${ps[0].leadSlots ?? leads.get(ps[0].runId)} slot(s) early` : mode;
    const key = `${ps[0].leaderClient}|${cond}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fees = ps.map((p) => (p.cuPrice === '0' ? '0' : `${Number(p.cuPrice) / 1000}k`)).join(', ');
    const sends = ps.map((p) => p.sendSeq).join(', ');
    out.push(`| ${ps[0].leaderClient} | ${cond} | [${ps[0].slot}](https://solscan.io/block/${ps[0].slot}) | ${ps[0].index}-${ps.at(-1)!.index} | ${fees} | ${sends} | [first probe](https://solscan.io/tx/${ps[0].signature}) |`);
  }
  return out.sort();
}

// Replication: the three key cells per client, separately for each measurement day (UTC).
export function replication(landed: Landed[], leads: Map<string, number>): string[] {
  const days = [...new Set(landed.map((p) => new Date(p.sentAtMs).toISOString().slice(0, 10)))].sort();
  const rows: string[] = [];
  const groups = [...new Set(landed.map((p) => p.leaderClient))].sort();
  const cell = (r: FeeVsArrival[], pred: (b: string) => boolean) => {
    const sel = r.filter((x) => x.arm === 'F' && pred(x.bucket));
    const n = sel.reduce((a, x) => a + x.pairs, 0);
    if (!n) return 'n/a';
    const w = sel.reduce((a, x) => a + (x.feeWins ?? 0) * x.pairs, 0);
    return `${((100 * w) / n).toFixed(0)}% (${n})`;
  };
  for (const g of groups) for (const d of days) {
    const r = feeVsArrival(landed.filter((p) => p.leaderClient === g && new Date(p.sentAtMs).toISOString().startsWith(d)), leads);
    if (!r.length) continue;
    rows.push(`| ${g} | ${d} | ${cell(r, (b) => b.startsWith('same burst') && b.includes('2 slot'))} | ${cell(r, (b) => b.startsWith('same burst') && b.includes('1 slot'))} | ${cell(r, (b) => b === '20-50 ms later' || b === '50-150 ms later')} |`);
  }
  return rows;
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ci = (c: [number, number] | null) => (c ? `${pct(c[0])} to ${pct(c[1])}` : 'n/a');

// Window check (works in dry-run too): was every targeted window really produced by the targeted leader,
// and how far ahead of the window did we (would we) send?
export interface WindowCheck {
  group: string;
  windows: number;
  slotsByTarget: number;
  slotsByOther: number;
  slotsNoLeaderInfo: number; // block without a Fee reward entry: producer cannot be confirmed
  slotsSkipped: number;
  slotsNotCollected: number;
  sendOffsets: Record<string, number>; // (window start - tip slot at first send) -> count
}

export function windowChecks(dataDir: string): WindowCheck[] {
  const blocks = loadBlocks(join(dataDir, 'blocks'));
  const runsDir = join(dataDir, 'runs');
  const m = new Map<string, WindowCheck>();
  if (!existsSync(runsDir)) return [];
  for (const r of readdirSync(runsDir)) {
    for (const w of readJsonl<{ identity: string; startSlot: number; client: string; status: string; tipSlotAtFirstSend?: number }>(join(runsDir, r, 'windows.jsonl'))) {
      if (w.status !== 'sent') continue;
      const c = m.get(w.client) ?? { group: w.client, windows: 0, slotsByTarget: 0, slotsByOther: 0, slotsNoLeaderInfo: 0, slotsSkipped: 0, slotsNotCollected: 0, sendOffsets: {} };
      c.windows++;
      for (let k = 0; k < 4; k++) {
        const b = blocks.get(w.startSlot + k);
        if (!b) c.slotsNotCollected++;
        else if (b.skipped) c.slotsSkipped++;
        else if (b.leader === null) c.slotsNoLeaderInfo++;
        else if (b.leader === w.identity) c.slotsByTarget++;
        else c.slotsByOther++;
      }
      const off = String(w.startSlot - (w.tipSlotAtFirstSend ?? w.startSlot));
      c.sendOffsets[off] = (c.sendOffsets[off] ?? 0) + 1;
      m.set(w.client, c);
    }
  }
  return [...m.values()].sort((a, b) => a.group.localeCompare(b.group));
}

export function writeAnalysis(dataDir: string, outPath: string): void {
  const { results, landed, passive } = analyze(dataDir);
  const lines: string[] = [];
  lines.push('# Analysis (generated by `itb analyze`, do not edit by hand)', '');
  lines.push(`Generated: ${new Date().toISOString()}`, '');
  lines.push('## Runs', '');
  lines.push('| run | mode | first send (UTC) | last send (UTC) | batches sent | probes sent | probes landed | windows skipped (late/missed/connect) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const runsDir = join(dataDir, 'runs');
  const landedSigs = new Set(landed.map((p) => p.signature));
  const modes = runModes(dataDir);
  if (existsSync(runsDir)) for (const r of readdirSync(runsDir).sort()) {
    const ps = readJsonl<ProbeRecord>(join(runsDir, r, 'probes.jsonl')).filter((p) => p.live);
    if (!ps.length) continue;
    const ws = readJsonl<{ status: string }>(join(runsDir, r, 'windows.jsonl'));
    const t = ps.map((p) => p.sentAtMs).sort((a, b) => a - b);
    const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
    const batches = new Set(ps.map((p) => p.batchId)).size;
    lines.push(`| ${r} | ${modes.get(r) ?? '?'} | ${iso(t[0])} | ${iso(t.at(-1)!)} | ${batches} | ${ps.length} | ${ps.filter((p) => landedSigs.has(p.signature)).length} | ${ws.filter((w) => w.status !== 'sent').length} |`);
  }
  lines.push('');
  lines.push('## Window check: did we target the right leader at the right time?', '');
  lines.push('| client group | windows | slots produced by target | by another leader | no Fee reward (producer unconfirmed) | skipped | not collected | slots between tip and window start at first send |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const c of windowChecks(dataDir)) {
    lines.push(`| ${c.group} | ${c.windows} | ${c.slotsByTarget} | ${c.slotsByOther} | ${c.slotsNoLeaderInfo} | ${c.slotsSkipped} | ${c.slotsNotCollected} | ${Object.entries(c.sendOffsets).map(([k, v]) => `${k}: ${v}`).join(', ')} |`);
  }
  lines.push('');
  lines.push('## Primary evidence: our own probes, same-block pairs', '');
  lines.push('| block leader client | path | arm | batches | sent while targeting this client | landed in blocks of this client | of which the targeted leader | same-block pairs | higher fee first (95% CI) | earlier send first (95% CI) | median foreign txs between our probes |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.group} | ${r.path} | ${r.arm} | ${r.batches} | ${r.probesSent} | ${r.probesLanded} | ${r.inTargetLeader} | ${r.sameBlockPairs} | ${pct(r.priority.rate)} (${ci(r.priority.ci)}) | ${pct(r.send.rate)} (${ci(r.send.ci)}) | ${r.medianGapTxs ?? 'n/a'} |`);
  }
  lines.push('', 'Arm T has equal fees by design, so its "higher fee first" column is always n/a.', '');
  lines.push('## Fee vs arrival (tpu path): the higher-fee probe was sent at the same time or LATER', '');
  lines.push('"higher fee still first" near 100% = ordered by fee; near 0% = ordered by arrival; near 50% = neither explains the order.', '');
  lines.push('| block leader client | arm | higher-fee probe sent | pairs | batches | higher fee still first (95% CI) |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of feeVsArrival(landed, runLeads(dataDir))) lines.push(`| ${r.group} | ${r.arm} | ${r.bucket} | ${r.pairs} | ${r.batches} | ${pct(r.feeWins)} (${ci(r.ci)}) |`);
  lines.push('');
  lines.push('## Sorted runs (arm F, tpu path, complete batches of 8 in one block)', '');
  lines.push('Fees read in block order, number of stretches where the fee never increases. 1 = fully sorted by fee, 4.5 = expected for a random order.', '');
  lines.push('| block leader client | timing mode | batches | mean sorted runs | fully sorted batches |');
  lines.push('|---|---|---|---|---|');
  const leads = runLeads(dataDir);
  const withLead = landed.map((p) => ({ ...p, leadSlots: p.leadSlots ?? leads.get(p.runId) ?? p.leadSlots }));
  for (const r of sortedRuns(withLead, runModes(dataDir))) lines.push(`| ${r.group} | ${r.mode} | ${r.batches} | ${r.meanRuns.toFixed(2)} | ${r.fullySorted} |`);
  lines.push('');
  lines.push('## Replication by measurement day (arm F, tpu path)', '');
  lines.push('Share of pairs with the higher-fee probe first (pairs in brackets). Days are UTC.', '');
  lines.push('| block leader client | day | burst, queued (2 slots early) | burst, mid-block (1 slot early) | higher fee sent 20-150 ms later |');
  lines.push('|---|---|---|---|---|');
  for (const r of replication(landed, runLeads(dataDir))) lines.push(r);
  lines.push('');
  lines.push('## Per validator (arm F, tpu path): is it the client or the operator?', '');
  lines.push('| block leader | client | pairs, same burst | higher fee first | pairs, higher fee sent 1-150 ms later | higher fee first |');
  lines.push('|---|---|---|---|---|---|');
  for (const v of perValidator(landed)) lines.push(`| \`${v.leader}\` | ${v.group} | ${v.burstPairs} | ${pct(v.burstFeeWins)} | ${v.laterPairs} | ${pct(v.laterFeeWins)} |`);
  lines.push('');
  lines.push('## Examples: one complete batch (arm F, 8 probes in one block) per client and condition', '');
  lines.push('Fees (micro-lamports per CU, in thousands) and our send order, both read in block order. Open the block on Solscan to see the probes in place.', '');
  lines.push('| block leader client | condition | block | positions | fees in block order | send order in block order | tx |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const e of examples(withLead, leads, runModes(dataDir))) lines.push(e);
  lines.push('');
  lines.push('## Supplementary: all non-vote transactions in collected blocks', '');
  lines.push('| leader client group | blocks | mean Spearman rho (price vs earlier position) | median txs per block |');
  lines.push('|---|---|---|---|');
  for (const p of passive) lines.push(`| ${p.group} | ${p.blocks} | ${p.meanRho === null ? 'n/a' : p.meanRho.toFixed(3)} | ${p.medianTxs ?? 'n/a'} |`);
  writeFileSync(outPath, lines.join('\n') + '\n');
  // figure panels ordered by stake share, from the first validator snapshot of each campaign
  const stakeOrder = (day: string) => {
    const run = existsSync(runsDir) ? readdirSync(runsDir).sort().find((r) => r.startsWith(day) && existsSync(join(runsDir, r, 'validators-start.json'))) : undefined;
    const share = new Map<string, number>();
    if (run) for (const v of JSON.parse(readFileSync(join(runsDir, run, 'validators-start.json'), 'utf8')) as { clientId: string; version: string; stakeShare: number }[]) {
      share.set(`${v.clientId} ${v.version}`, (share.get(`${v.clientId} ${v.version}`) ?? 0) + v.stakeShare);
    }
    return [...share.entries()].map(([group, sh]) => ({ group, share: sh })).sort((a, b) => b.share - a.share);
  };
  mkdirSync(join(dataDir, 'figures'), { recursive: true });
  // one figure per measurement campaign (UTC days, a gap of more than one day starts a new campaign),
  // because ordering rules can change between campaigns (Harmonic did between 25.10 and 29.10)
  const days = [...new Set(landed.map((p) => new Date(p.sentAtMs).toISOString().slice(0, 10)))].sort();
  const campaigns: string[][] = [];
  for (const d of days) {
    const last = campaigns.at(-1);
    if (last && Date.parse(d) - Date.parse(last.at(-1)!) <= 86_400_000) last.push(d);
    else campaigns.push([d]);
  }
  for (const c of campaigns) {
    const sel = landed.filter((p) => c.includes(new Date(p.sentAtMs).toISOString().slice(0, 10)));
    const label = c.length > 1 ? `${c[0]} to ${c.at(-1)}` : c[0];
    writeFileSync(join(dataDir, 'figures', `fee-vs-arrival-${c[0]}.svg`), feeVsArrivalSvg(feeVsArrival(sel, runLeads(dataDir)), stakeOrder(c[0]), label));
  }
  writeFileSync(join(dataDir, 'landed-probes.json'), JSON.stringify(landed, null, 1));
}
