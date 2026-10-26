// The experiment: for each selected leader window, build one batch of K tagged memo transactions
// (the "probes"), send them in a random order shortly before the window opens, and record everything.
//
// Arms (rotated per window, see README "Design"):
//   F  fee ladder, one shared payer   -> all probes write-lock the same account (they conflict)
//   T  equal fee, one shared payer    -> conflicting, priority tied: isolates arrival/send order
//   N  fee ladder, K distinct payers  -> no account conflicts between probes
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { rpc, sleep } from './rpc.ts';
import { rng, shuffle } from './rng.ts';
import { buildProbeTx, keypairFromSeed, maxFeeLamports, type Keypair, type SignedTx } from './solana.ts';
import { SpendLedger, SpendCapExceeded } from './ledger.ts';
import { leaderWindows, SlotTracker, type LeaderWindow } from './schedule.ts';
import { clientGroup, snapshotValidators, stakeByGroup, type ValidatorInfo } from './validators.ts';
import { TpuSender } from './tpu.ts';

export interface ProbeRecord {
  runId: string;
  batchId: string;
  arm: string;
  probeIdx: number; // index inside the batch (stable id)
  sendSeq: number; // position in the send order
  cuPrice: string; // micro-lamports per CU
  cuLimit: number;
  maxFee: string; // lamports, what the spend cap charged
  payer: string;
  signature: string;
  memo: string;
  targetIdentity: string;
  targetClient: string;
  windowStart: number;
  leadSlots: number; // we sent when our tip was this many slots before the window
  path: string; // "tpu" (direct QUIC to the leader) or "rpc" (sendTransaction)
  sentAtMs: number; // wall clock when handed to the HTTP client / sidecar
  sentAtUs: string | null; // tpu path: microsecond timestamp taken by the sidecar right before opening the stream
  sentAtHr: string; // process.hrtime.bigint() for intra-batch ordering
  tipSlotAtSend: number;
  sendRpc: string; // rpc URL, or the leader TPU address for the tpu path
  sendResult: string; // signature echoed by RPC, or error text; "dry-run" in dry-run mode
  live: boolean;
}

// Fixed 12-byte memo tag: "itb" + 7 base36 chars of the window slot + arm + probe index.
// Fixed length matters: the Memo program charges ~350 CU per byte, and every probe must cost the same CU.
export function probeTag(windowStart: number, arm: string, probeIdx: number): string {
  const slotPart = (windowStart % 36 ** 7).toString(36).padStart(7, '0');
  return `itb${slotPart}${arm}${probeIdx.toString(36)}`;
}

export function subPayers(main: Uint8Array, n: number): Keypair[] {
  return Array.from({ length: n }, (_, i) =>
    keypairFromSeed(createHash('sha256').update(main).update(`inside-the-block/subpayer/${i}`).digest()),
  );
}

export function selectTargets(vals: ValidatorInfo[], cfg: Config): ValidatorInfo[] {
  if (cfg.pinnedValidators.length) {
    const pinned = vals.filter((v) => cfg.pinnedValidators.includes(v.identity));
    if (pinned.length !== cfg.pinnedValidators.length) throw new Error('some PIN_VALIDATORS not found among voting validators');
    return pinned;
  }
  const out: ValidatorInfo[] = [];
  for (const client of cfg.targetClients) {
    // dominant version of this client = the version holding the most stake
    const ofClient = vals.filter((v) => v.clientId === client && v.activatedStakeSol >= cfg.minActivatedStakeSol);
    if (!ofClient.length) continue;
    const stakeByVersion = new Map<string, number>();
    for (const v of ofClient) stakeByVersion.set(v.version, (stakeByVersion.get(v.version) ?? 0) + v.activatedStakeSol);
    const version = [...stakeByVersion.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // highest stake = most leader windows per hour = fastest to repeat
    out.push(...ofClient.filter((v) => v.version === version).slice(0, cfg.validatorsPerClient));
  }
  return out;
}

export interface RunContext {
  cfg: Config;
  runId: string;
  runDir: string;
  payer: Keypair;
  subs: Keypair[];
  ledger: SpendLedger | null; // null in dry-run
}

async function sendRaw(url: string, tx: SignedTx): Promise<string> {
  try {
    return await rpc<string>(
      url,
      'sendTransaction',
      // skipPreflight: no simulation delay; maxRetries 0: the RPC must not re-broadcast and reshuffle our order
      [tx.wire.toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
      0,
    );
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

export async function runExperiment(ctx: RunContext): Promise<void> {
  const { cfg, runDir } = ctx;
  const rand = rng(cfg.seed);
  mkdirSync(runDir, { recursive: true });

  writeFileSync(join(runDir, 'config.json'), JSON.stringify({ ...cfg, live: ctx.ledger !== null, payer: ctx.payer.publicKey }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  const vals = await snapshotValidators(cfg.rpcUrl);
  writeFileSync(join(runDir, 'validators-start.json'), JSON.stringify(vals, null, 1));
  log('snapshot', { validators: vals.length, groups: stakeByGroup(vals).slice(0, 10) });

  const targets = selectTargets(vals, cfg);
  writeFileSync(join(runDir, 'targets.json'), JSON.stringify(targets, null, 1));
  for (const t of targets) log('target', { identity: t.identity, group: clientGroup(t), stakeSol: Math.round(t.activatedStakeSol) });

  const { epoch, windows } = await leaderWindows(cfg.rpcUrl, targets.map((t) => t.identity));
  const tracker = new SlotTracker(cfg.rpcUrl, cfg.wsUrl);
  await tracker.start();
  const horizonEnd = tracker.slot + cfg.horizonSlots;
  const epochEnd = epoch.absoluteSlot - epoch.slotIndex + epoch.slotsInEpoch;
  const byIdentity = new Map(targets.map((t) => [t.identity, t]));

  // Pick windows: per validator up to batchesPerValidator, in time order, at least 10 slots apart globally
  // so batches never overlap and the public RPC rate limit is respected.
  const counts = new Map<string, number>();
  const plan: LeaderWindow[] = [];
  let lastStart = -Infinity;
  for (const w of windows) {
    if (w.startSlot <= tracker.slot + Math.max(...cfg.leadSlots) + 2 || w.startSlot >= Math.min(horizonEnd, epochEnd)) continue;
    if ((counts.get(w.identity) ?? 0) >= cfg.batchesPerValidator) continue;
    if (w.startSlot - lastStart < 10) continue;
    plan.push(w);
    counts.set(w.identity, (counts.get(w.identity) ?? 0) + 1);
    lastStart = w.startSlot;
  }
  // measured slot duration (Alpenglow changed it), only used for the time estimate in the log
  const perf = await rpc<{ numSlots: number; samplePeriodSecs: number }[]>(cfg.rpcUrl, 'getRecentPerformanceSamples', [10]);
  const secPerSlot = perf.reduce((a, p) => a + p.samplePeriodSecs, 0) / Math.max(1, perf.reduce((a, p) => a + p.numSlots, 0));
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan.map((w) => ({ ...w, client: clientGroup(byIdentity.get(w.identity)!) })), null, 1));
  log('plan', {
    windows: plan.length,
    firstSlot: plan[0]?.startSlot,
    lastSlot: plan.at(-1)?.startSlot,
    secPerSlot: Number(secPerSlot.toFixed(3)),
    approxMinutes: plan.length ? Math.round(((plan.at(-1)!.startSlot - tracker.slot) * secPerSlot) / 60) : 0,
    perValidator: Object.fromEntries(counts),
  });

  // Arm N needs funded sub-payers (`fund --live`); without them it is dropped instead of failing every batch.
  let arms = cfg.arms;
  if (ctx.ledger && arms.includes('N')) {
    const low = [];
    for (const s of ctx.subs) {
      const r = await rpc<{ value: number }>(cfg.rpcUrl, 'getBalance', [s.publicKey, { commitment: 'confirmed' }]);
      if (r.value < 1_000_000) low.push(s.publicKey);
    }
    if (low.length) {
      log('arm.N_dropped', { reason: 'sub-payers not funded, run `fund --live` first', low });
      arms = arms.filter((a) => a !== 'N');
    }
  }

  const probesFile = join(runDir, 'probes.jsonl');
  const windowsFile = join(runDir, 'windows.jsonl');
  let blockhash = '';
  let blockhashAt = 0;
  let armIdx = 0;
  let windowIdx = 0;
  const tpu = cfg.sendPaths.includes('tpu') ? new TpuSender(cfg.tpuSenderBin) : null;

  try {
    for (const w of plan) {
      const target = byIdentity.get(w.identity)!;
      const path = cfg.sendPaths[Math.floor(armIdx / arms.length) % cfg.sendPaths.length];
      const arm = arms[armIdx++ % arms.length];
      // refresh blockhash every ~20s; it stays valid ~60s (150 blocks)
      if (Date.now() - blockhashAt > 20_000) {
        const r = await rpc<{ value: { blockhash: string } }>(cfg.rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
        blockhash = r.value.blockhash;
        blockhashAt = Date.now();
      }
      // lead rotates on a slower cycle than arm and path, so every arm meets every lead
      // (rotating both per window made arm and lead identical whenever their list lengths matched)
      const lead = cfg.leadSlots[Math.floor(windowIdx++ / (arms.length * cfg.sendPaths.length)) % cfg.leadSlots.length];
      const sendAt = w.startSlot - lead;
      if (tracker.slot > sendAt) {
        log('window.missed', { start: w.startSlot, tip: tracker.slot });
        appendFileSync(windowsFile, JSON.stringify({ ...w, client: clientGroup(target), arm, status: 'missed', tipSlot: tracker.slot }) + '\n');
        continue;
      }

      // Build + sign the whole batch before the window, so sending is just I/O.
      const batchId = `${w.startSlot}`;
      const k = cfg.batchSize;
      const fees: bigint[] =
        arm === 'T'
          ? Array.from({ length: k }, () => cfg.feeLadder[Math.floor(cfg.feeLadder.length / 2)])
          : shuffle(cfg.feeLadder.slice(0, k), rand); // fee of probe i is independent of its send position
      const sendOrder = shuffle(Array.from({ length: k }, (_, i) => i), rand);
      const probes = fees.map((cuPrice, probeIdx) => {
        const payer = arm === 'N' ? ctx.subs[probeIdx % ctx.subs.length] : ctx.payer;
        const memo = probeTag(w.startSlot, arm, probeIdx);
        const tx = buildProbeTx({ payer, blockhash, cuLimit: cfg.cuLimit, cuPriceMicroLamports: cuPrice, memo });
        return { probeIdx, cuPrice, payer, memo, tx, maxFee: maxFeeLamports(cfg.cuLimit, cuPrice) };
      });

      if (ctx.ledger && !ctx.ledger.canAfford(probes.map((p) => p.maxFee))) {
        log('spendcap.stop', { remaining: ctx.ledger.remaining, needed: probes.reduce((a, p) => a + p.maxFee, 0n) });
        break;
      }

      // tpu path: open the QUIC connection now (also in dry-run), so the handshake is not inside the window
      let tpuAddr: string | null = null;
      if (path === 'tpu') {
        tpuAddr = target.tpuQuic;
        const c = tpuAddr ? await tpu!.connect(tpuAddr) : { ok: false, err: 'no tpuQuic in gossip' };
        if (!c.ok) {
          log('tpu.connect_failed', { start: w.startSlot, addr: tpuAddr, err: c.err });
          appendFileSync(windowsFile, JSON.stringify({ ...w, client: clientGroup(target), arm, path, status: 'connect_failed', err: c.err }) + '\n');
          continue;
        }
      }

      const tipBefore = await tracker.waitFor(sendAt);
      // Too late (e.g. our own network dropped and the tracker jumped): the window is gone or almost gone.
      // Sending now would hit some other leader, so the batch is skipped and nothing is charged.
      if (tipBefore > w.startSlot + 1) {
        log('window.late_skipped', { start: w.startSlot, tip: tipBefore });
        appendFileSync(windowsFile, JSON.stringify({ ...w, client: clientGroup(target), arm, path, status: 'late_skipped', tipSlot: tipBefore }) + '\n');
        continue;
      }
      const ordered = sendOrder.map((i) => probes[i]);
      const records: ProbeRecord[] = ordered.map((p, seq) => ({
        runId: ctx.runId, batchId, arm, probeIdx: p.probeIdx, sendSeq: seq,
        cuPrice: p.cuPrice.toString(), cuLimit: cfg.cuLimit, maxFee: p.maxFee.toString(),
        payer: p.payer.publicKey, signature: p.tx.signature, memo: p.memo,
        targetIdentity: w.identity, targetClient: clientGroup(target), windowStart: w.startSlot, leadSlots: lead,
        path, sentAtMs: Date.now(), sentAtUs: null, sentAtHr: process.hrtime.bigint().toString(), tipSlotAtSend: tracker.slot,
        sendRpc: path === 'tpu' ? tpuAddr! : cfg.sendRpcUrls[seq % cfg.sendRpcUrls.length],
        sendResult: 'dry-run', live: ctx.ledger !== null,
      }));
      const pending: Promise<void>[] = [];
      if (ctx.ledger) {
        // charge the whole batch first: if the cap would be exceeded, nothing of this batch leaves
        for (const p of ordered) ctx.ledger.charge(p.tx.signature, p.maxFee, `probe:${arm}:${path}`);
        if (path === 'tpu') {
          const replies = await tpu!.sendBatch(tpuAddr!, cfg.sendGapMs, ordered.map((p) => ({ id: p.tx.signature, tx: p.tx.wire.toString('base64') })));
          replies.forEach((r, k) => {
            records[k].sendResult = r.ok ? 'quic-ok' : `error: ${r.err}`;
            records[k].sentAtUs = r.t_us ?? null;
          });
        } else {
          for (let seq = 0; seq < ordered.length; seq++) {
            const rec = records[seq];
            rec.sentAtMs = Date.now();
            rec.sentAtHr = process.hrtime.bigint().toString();
            rec.tipSlotAtSend = tracker.slot;
            pending.push(sendRaw(rec.sendRpc, ordered[seq].tx).then((r) => { rec.sendResult = r; }));
            await sleep(cfg.sendGapMs);
          }
        }
      } else {
        await sleep(cfg.sendGapMs * ordered.length); // same pacing in dry-run, so the dry-run timing is representative
      }
      await Promise.all(pending);
      for (const r of records) appendFileSync(probesFile, JSON.stringify(r) + '\n');
      appendFileSync(windowsFile, JSON.stringify({
        ...w, client: clientGroup(target), arm, path, tpuAddr, leadSlots: lead, status: 'sent', tipSlotAtFirstSend: records[0].tipSlotAtSend,
        tipSlotAtLastSend: tracker.slot, sendSpanMs: records.at(-1)!.sentAtMs - records[0].sentAtMs, live: ctx.ledger !== null,
      }) + '\n');
      log('batch', { start: w.startSlot, client: clientGroup(target), arm, path, tip: tipBefore, live: ctx.ledger !== null, sendErrors: records.filter((r) => r.sendResult.startsWith('error')).length });
    }
  } catch (e) {
    if (e instanceof SpendCapExceeded) log('spendcap.abort', { error: e.message });
    else throw e;
  } finally {
    tracker.stop();
    tpu?.stop();
    const end = await snapshotValidators(cfg.rpcUrl).catch(() => []);
    writeFileSync(join(runDir, 'validators-end.json'), JSON.stringify(end, null, 1));
  }
}
