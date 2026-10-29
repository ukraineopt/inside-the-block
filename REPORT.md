# Report: transaction ordering inside Solana mainnet blocks, by client (post-Alpenglow)

Author: Evgen (X [@lower_cryptoboy](https://x.com/lower_cryptoboy)), Dnipro, Ukraine.
Code, raw data and the method: [README.md](README.md). Generated tables: [data/ANALYSIS.md](data/ANALYSIS.md)
(every number below can be regenerated with `docker compose run --rm itb analyze`).

## 1. When and where every measurement was taken

All measurements: **Solana mainnet, 25-26 October 2026 (main campaign) and 29 October 2026 (replication), after the Alpenglow activation**
(21 October 2026, slot 459,653,000). Times are UTC (Kyiv = UTC+2: summer time ended on 25 October 2026 at 04:00, before the first run).
Sender: a home connection in Dnipro, Ukraine; Docker Desktop 29.9.2 on macOS; public mainnet RPC
(`api.mainnet-beta.solana.com`) for schedule, slots, statuses and blocks; direct QUIC to leaders for sending.

| # | Run id (`data/runs/…`) | Date, time (UTC) | Mode | Arms | Path | Batches | Probes sent | Landed |
|---|---|---|---|---|---|---|---|---|
| P1 | 2026-10-25T09-17-55-live | 25.10 09:18-09:20 | spaced 15 ms, 1 slot early | F, T | rpc | 6 | 48 | 24 |
| P2 | 2026-10-25T10-06-40-live | 25.10 10:06-10:08 | spaced 15 ms, 1 slot early | F, T | tpu | 8 | 64 | 40 |
| 1 | 2026-10-25T11-57-49-live | 25.10 11:57-12:59 | spaced 15 ms, 1 slot early | F, T, N | tpu + rpc alternating | 278 | 2,224 | 1,832 |
| 2 | 2026-10-25T16-48-27-live | 25.10 16:48-17:51 | burst (<1 ms), 2 slots early | F, T, N | tpu | 210 | 1,680 | 1,096 |
| 3 | 2026-10-25T18-56-32-live | 25.10 18:56-19:27 | burst, 1 slot early | F, N | tpu | 104 | 832 | 344 |
| 4 | 2026-10-25T20-42-46-live | 25.10 20:44-21:45 | burst, Agave only (see 5.8) | F, T | tpu | 25 | 200 | 56 |
| 5 | 2026-10-26T08-14-32-live | 26.10 08:16-09:53 | burst, 2 slots early, Agave only | F | tpu | 30 | 240 | 32 |

P1 and P2 are pilots; their data is kept and included (they are real mainnet measurements with the
same code), but no conclusion rests on them alone. Per-run settings: `data/runs/<run>/config.json`
(for P1-2 reconstructed from the exact command line and the logged seed, marked as such).

Validators measured (identity, client, stake at measurement time): `data/runs/<run>/targets.json`.
In total **27 targeted validators on 8 client builds** (3 per client, 6 for vanilla Agave), and our probes were found in blocks of **46 different validators**: Agave 4.3.2 (vanilla), AgaveBam
4.3.2, JitoLabs 4.3.2, HarmonicAgave 4.3.2, Rakurai 4.3.2, Firedancer 26.10.4, HarmonicFiredancer
26.10.4, FireBAM 26.10.4. Client = gossip `clientId` + `version` from `getClusterNodes`, snapshotted at
the start and end of every run.

**Spend.** Worst-case fees reserved by the spend cap: 0.0306 SOL for 5,296 transactions (cap 0.05).
Actual on-chain spend (start balance minus everything left on the burner and the 8 sub-payers):
**0.0198 SOL in total** (0.06 SOL funded, 0.0402 SOL returned to the owner's wallet on 26.10.2026 13:36 UTC after `sweep` + `withdraw`, tx `2TuVC8yQf2K1aTsSSx5G6cqJmSBnnqnbPvHHqynq8mfGsqEQPRwECUdfaK4hV5uM5y5nGXH6NwhEXg6U8EZcT8EM`; burner and all 8 sub-payers left at 0). Every live transaction with its worst-case fee: `data/spend-ledger.json`.

**Verification.** `docker compose --profile verify run --rm verify` re-fetches every block that contains
a probe from the public mainnet RPC and compares positions. 26.10.2026: 578 blocks, 0 mismatches.
29.10.2026 (after the replication): 640 blocks, 639 identical on the first pass, 1 not fetched
(`fetch failed`, our network) and identical on a re-check; 0 mismatches.

## 2. Results by client

Numbers are the share of same-block pairs of our probes in which the higher-fee probe is earlier,
with 95% bootstrap confidence intervals over batches. "Burst" cells use only pairs whose two probes
really left within 1 ms of each other (measured per stream by the sidecar), see README "Timing modes".
"F" = probes share one fee payer (they conflict and must be serialized), "N" = 8 different payers.

### Vanilla Agave 4.3.2 (control: the rule is in the open-source code)

The open-source rule: `priority = leader reward * 1e6 / (cost + 1)`, scheduled greedily in priority
order from what is currently buffered ([`transaction_priority.rs`](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/transaction_priority.rs),
`greedy_scheduler.rs` @ v4.3.2). Prediction: fee order among transactions that are buffered at the same
time, arrival order between scheduling passes.

* Burst, 2 slots early (probes buffered before the leader's slot): 71.6% (44.4-98.8%), 6 batches
  (2 in run 2, 4 in run 5); 3 of 6 complete batches fully sorted (mean 1.83 sorted runs). The others
  show the scheduling-pass pattern: `[100, 50, 20, 1, 0]`, then after foreign transactions
  `[500, 250, 5]` (slot 461596244); one batch followed our send order almost exactly (send positions
  1,0,3,2,4,5,7,6, slot 461604816), i.e. every probe was scheduled in its own pass. Landing on direct
  TPU for vanilla Agave in run 5 was only 13% (32 of 240), which caps this sample.
* Burst, 1 slot early (probes arrive while the block is being built, first probe at index ~150-240):
  50.8% (22.7-77.8%), 5 batches, and the order comes in **sorted stretches**: e.g. fees
  `[250, 50, 20]` then `[500, 100, 5, 1, 0]` (slot 461414636). Mean 2.4 sorted runs per batch
  (1 = fully sorted, 4.5 = random).
* Spaced 15 ms: the higher-fee probe still wins 50% of pairs when sent 1-20 ms later, 43% at
  20-50 ms and 24% at 50-150 ms.
* Equal fees (arm T): order is not the send order; no tie-break rule visible at < 1 ms.

Verdict: **consistent with the code**: fee order inside one scheduling pass, arrival order between
passes. Whether our 8 probes fall into one pass depends on when the validator drains them from QUIC,
which a sender cannot fully control; that is why even buffered batches are not always fully sorted.
The control reproduces the known mechanism, which is what makes the other clients' results credible,
but its sample is the smallest (11 complete burst batches) because vanilla Agave rarely includes
unstaked direct traffic.

### AgaveBam 4.3.2 (Jito BAM), 35.6% of stake

* Burst F: **100%** both when buffered (45 pairs, 4 batches) and when arriving mid-block (31 pairs,
  3 batches); every complete batch fully sorted (7/7).
* Burst N (no conflicts): 95.1% (91.3-97.8%), the most fee-ordered of all clients without conflicts.
* Spaced: 67% of pairs at 1-20 ms, 36% at 50-150 ms: arrival still wins with a large enough gap.

Verdict: **strict fee order among transactions present at the same time**, more consistent than
vanilla Agave, also mid-block. This is for transactions sent to the validator's own TPU. What BAM's
TEE node does with bundles / transactions submitted to it is not measured.

### JitoLabs 4.3.2 (Jito-Solana), 22.9% of stake

* Burst F: 74.3% (56.2-89.7%), 15 batches; only 7 of 15 complete batches fully sorted.
* Burst N: 44.4% (29.7-58.4%): **indistinguishable from random** without conflicts.
* Spaced: 22-28% at 1-20 ms, 0-16% at 50-150 ms: arrival dominates.

Verdict: **weak fee preference, strong arrival order**; for independent transactions, no rule
detectable at our resolution.

### HarmonicAgave 4.3.2 (21.6%) and HarmonicFiredancer 26.10.4 (8.7%)

* Spaced F: the higher-fee probe wins 66% / 30% of pairs when sent 1-20 ms later, **10% / 14% at
  20-50 ms and 0% / 0% at 50-150 ms** (58 and 42 pairs). The sharpest arrival rule of all clients.
* Burst F: 91.9% / 94.3%, but **no complete batch was ever fully sorted** (0/7, 0/6; 2.3-2.4 sorted
  runs on average): the probes are sorted in small groups.
* Burst N: 61.6% / 60.7%.
* Both clients advertise the same IP with different ports for their TPU (e.g. 198.13.140.105:12341
  and :12349): transactions enter Harmonic's shared remote TPU / builder.

Verdict: **arrival order with a short batching window (~15-30 ms); fee sorts only within each small
group**. Behaviour is the same for the Agave-based and the Firedancer-based client, which fits the
ordering being done by Harmonic's builder rather than by the validator software.

### Firedancer 26.10.4 (6.4%) and FireBAM 26.10.4 (1.6%)

* Burst F: Firedancer 93.1% (buffered, 12 batches, 10/12 fully sorted), 84.3% (mid-block, 5 batches);
  FireBAM 100% in both (4/4 fully sorted).
* Burst N: Firedancer 67.4% (42.9-89.7%), FireBAM 92.6%.
* Spaced: **~50% regardless of how much later the higher-fee probe was sent** (52%, 57%, 50% for
  1-20, 20-50, 50-150 ms). Neither arrival nor fee explains the order at 15 ms spacing.

Verdict: **fee order when the probes can be compared; at 15 ms spacing no detectable rule**
(a valid null result: neither FIFO nor fee). Unlike Agave/Jito/Harmonic, a 100 ms arrival head start
does not guarantee an earlier position.

### Rakurai 4.3.2 (1.2%)

* Burst F: 89.5% (69.4-100%), 4 batches. Burst N: 75.3% (57.7-90.2%).
* Spaced: 31-53%, no arrival rule.
* Landing on direct TPU was poor (pilot 2: 0/8; run 1: 56%).

Verdict: fee preference, no arrival rule; small sample.

### Client or operator? (per-validator split)

Table "Per validator" in `data/ANALYSIS.md` repeats the fee-vs-arrival comparison per block producer.
Consistent across all validators hit: HarmonicAgave (5 validators) and HarmonicFiredancer (4): 83-100%
in bursts, 8-30% once the higher fee is sent later; AgaveBam (all 4 validators with burst pairs) and FireBAM (2): 100% in bursts.
Not consistent: JitoLabs (burst 100% on `C8Bey3…`, 63-65% on `HEL1US…` and `E1r4Ps…`), Firedancer
(higher fee sent later: 69% on `EvnRmn…`, 0% on `JD549H…`, 17% on `9eGrDo…`), vanilla Agave (burst
33-100% across 4 validators). For these three the per-client verdict is the typical behaviour, and
operator configuration (block-engine / scheduler settings, hardware, load) is a material source of variance
that this design does not separate further.

## 3. Cross-client findings

1. **The moment of arrival matters more than the client for "is it fee-ordered".** Probes that wait
   in the leader's buffer together are fee-ordered by every client (72-100% with conflicts). The same
   probes arriving mid-block are fee-ordered by BAM/FireBAM/Firedancer/Rakurai but split into arrival-ordered
   passes for vanilla Agave.
2. **Arrival order beats fee for Agave, BAM, Jito and Harmonic once the gap is tens of milliseconds**,
   most sharply for Harmonic on 25.10 (not any more on 29.10, section 6). Not for Firedancer, FireBAM
   and Rakurai.
3. **Without a write-lock conflict, position is largely noise** for Jito (44%), Harmonic (61%) and
   Firedancer (67%): independent transactions are executed in parallel and the block records whatever
   finishes first. BAM keeps fee order even here (95%).
4. **Landing does not depend on fee.** Landing rate was identical for all 8 fee levels in every run
   (87% in run 1, 65% in run 2): batches land whole or not at all, so fee-dependent survival does not
   bias the ordering numbers.
5. **Blocks as a whole are not fee-sorted** for any client: Spearman rho between position and CU price
   over all non-vote transactions of 997 collected blocks is between -0.05 and +0.15.
6. **After Alpenglow:** slots are ~212 ms (`getRecentPerformanceSamples`), votes are no longer in
   blocks (0 vote transactions in all collected blocks), 38% of transactions use the v1 format.

## 4. Path comparison (run 1, tpu and rpc alternating)

Public RPC delivers late: in pilot 1, 7 of 8 Firedancer-targeted probes and 8 of 8 HarmonicAgave-
targeted probes landed 4-10 slots after the window started, in other leaders' blocks. Direct QUIC
put 8/8 into the targeted leader's first slot for five clients in pilot 2. Over run 1, landing by
client on the tpu path: Agave 64%, AgaveBam 78%, FireBAM 83%, Firedancer 95%, HarmonicAgave 96%,
HarmonicFiredancer 100%, JitoLabs 96%, Rakurai 56%. Ordering results are reported separately per path in
`data/ANALYSIS.md`; conclusions above use the tpu path.

## 5. What went wrong

1. **Devnet test was skipped.** The devnet faucet returned HTTP 429 ("airdrop limit") on 24.10, so the
   suggested devnet end-to-end step was replaced by `simulateTransaction` checks on mainnet (signature
   verifies, corrupted signature returns `SignatureFailure`, CU consumption measured) and two cheap
   mainnet pilots.
2. **v1 transactions broke the block parser** in the first dry-run (`Transaction version (1) is not
   supported`). Fixed: `maxSupportedTransactionVersion: 1` and parsing of `transactionConfig`.
3. **Public RPC delivers 1-2 s late** (pilot 1): half the probes landed in the wrong leader's block.
   Led to the direct QUIC sender. Evidence is attributed to the leader that built the block, so the
   pilot data is still usable.
4. **Direct TPU was refused or ignored by some validators**: in pilot 2 one vanilla Agave validator
   closed our connection ("closed by peer: dropped"), and one AgaveBam and one Rakurai validator
   accepted the connection but included nothing. With 3 validators per client in later runs, every
   client had landings, but vanilla Agave stayed the hardest (28-64% landing), which is why the control
   needed two extra runs, and even run 5 (Agave only) landed 13%.
5. **Our own internet dropped for ~4 minutes** in run 1 (12:32-12:36 UTC, `fetch failed`). 13 windows
   were missed and one batch was sent 1,162 slots late into another leader's block. Fixed afterwards:
   a batch more than 1 slot late is skipped and not charged. The late batch is kept in the raw data;
   its probes count only for the leader that actually included them.
6. **Collecting blocks timed out** after run 2 (public RPC `getSignatureStatuses` with 256 signatures
   and history search took > 30 s). Fixed: chunks of 32 (0.4 s), and one failed block no longer aborts
   collection (`collect` is idempotent and was re-run).
7. **Public RPC throttling in run 3** (223 retried requests): 18 windows skipped as late, 7 missed,
   landing only 41%.
8. **Design bug in run 4**: arms (F, T) and lead (1, 2 slots) rotated on the same counter with equal
   list lengths, so every F batch was sent 1 slot early and every T batch 2 slots early: the planned
   comparison cell "Agave, F, 2 slots early" got zero batches. Fixed (lead now rotates on a slower cycle)
   and run 5 was added to fill exactly that cell.
9. **The 15 ms spacing in run 1 mixed two questions** (fee rule and arrival). Not a bug, but it made the
   first results ambiguous; runs 2-3 (burst) were added to separate them.
10. **Sending 2 slots early lowers landing** (Agave 64% -> 38%, FireBAM 83% -> 41%): some validators do
    not buffer traffic that far ahead of their slot. This is a trade-off between "probes queued together"
    and "probes land at all".
11. **Small samples** where landing was poor: Rakurai and FireBAM have 2-4 complete batches per cell.
    Their confidence intervals are wide and the report says so.
12. A cosmetic one: the time estimate in the run log assumed 400 ms slots (116 min instead of ~61); now
    measured from `getRecentPerformanceSamples`.

## 6. Replication on 29 October 2026

| # | Run id | Date, time (UTC) | Mode | Arms | Path | Batches | Probes sent | Landed |
|---|---|---|---|---|---|---|---|---|
| 6 | 2026-10-29T17-03-07-live | 29.10 17:03-18:06 | mixed: burst 2 slots early / burst 1 slot early / spaced 15 ms, rotated per window | F | tpu | 145 | 1,160 | 488 |

Same code (plus a QUIC warm-up stream that turned out to change nothing), 3 validators per client,
the three timing conditions interleaved so they share the same hour. 43 of 188 windows were skipped
(34 too late after public-RPC slowdowns: 286 retried requests, 8 missed, 1 connection failure).

| Client | 25-26.10: burst queued / mid-block / higher fee 20-150 ms later | 29.10: same cells |
|---|---|---|
| AgaveBam 4.3.2 | 100% / 100% / 46% | 100% / 100% / 0% |
| FireBAM | 100% / 100% / 100% (26.10.4) | 100% / n/a / 100% (26.10.5) |
| Firedancer 26.10.4 | 93% / 84% / 52% | 73% / 100% / 22% |
| JitoLabs 4.3.2 | 74% / 75% / 45% | 100% / 82% / 63% |
| HarmonicAgave 4.3.2 | 92% / n/a / **3%** | 95% / 94% / **96%** |
| HarmonicFiredancer 26.10.4 | 94% / n/a / **5%** | 94% / 100% / **66%** |
| Rakurai 4.3.2 | 83% / 96% / n/a | 16% / 83% / 33% (small n) |
| Agave 4.3.2 | 100% / 51% / 39% | no landings (0 of 88) |

(pairs per cell: "Replication by measurement day" in `data/ANALYSIS.md`.)

**What held:** every client that landed probes still fee-orders transactions that reach it together.
**What changed:** Harmonic. A higher-fee probe that arrived tens of milliseconds later was almost never
ahead on 25.10 and almost always ahead on 29.10, on the same client versions and partly on the same
validators (`Fd7btg…`: block 461249312 on 25.10 in arrival order; block 462958608 on 29.10 sorted
`500k 250k 100k 50k 20k 5k 1k 0` with the probes arriving scrambled over 130 ms). Since the validator
software did not change, the most likely cause is a change in Harmonic's external builder. This is
the strongest evidence in the study that, for builder-based clients, **the ordering rule is a
property of the builder at a point in time, not of the client software**.

Also observed: between the two days several AgaveBam and Jito validators moved to 4.4.0-rc.1 / 4.4.0
and FireBAM to 26.10.5. The first version of this analysis attributed the 25.10 probes to those new
versions (it used the latest validator snapshot); fixed before publishing: each probe now carries the
client version from the snapshot taken at the start of its own run.

Spend for the replication: see section 1.

## 7. Bottom line

* There is no single "Solana ordering rule" today. For transactions that reach a leader at the same
  moment and compete for the same account, **every client measured orders by fee** (72-100%). This
  matches the open-source Agave rule.
* What differs between clients is **how much arrival time overrides fee**. On 25.10 Harmonic was close to
  strict FIFO beyond ~30 ms (on 29.10 it ordered by fee). Jito, vanilla Agave and BAM let arrival win once the gap is large. Firedancer,
  FireBAM and Rakurai do not let arrival decide.
* **For independent transactions, the in-block position is mostly execution noise** for Jito, Harmonic
  and Firedancer; BAM is the exception.
* **Rules move.** Harmonic (30% of stake) switched from arrival order to fee order between 25.10 and
  29.10 with no client upgrade. Any statement about "how client X orders" needs a date.
* Practical consequence for a user: on most of the stake, paying more helps only against transactions
  that arrive within the same few milliseconds; arriving earlier is worth more than paying more (on
  25.10 most of all on Harmonic leaders; that can change, as 29.10 showed).
