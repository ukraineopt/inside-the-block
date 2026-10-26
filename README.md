# Inside the Block: how Solana mainnet leaders order transactions, per client

A measurement project for the Superteam Ukraine bounty *Inside the Block*. We send our own tagged
transactions ("probes") into the leader windows of chosen mainnet validators, find them in the
produced blocks, and ask, for every pair of our probes in the same block: which one came first, and why.

All measurements were taken on **Solana mainnet on 25-26 October 2026, after the Alpenglow activation
(21 October 2026, slot 459,653,000)**. Nothing pre-Alpenglow is mixed in.
Full dated results, numbers and the "what went wrong" log are in [REPORT.md](REPORT.md).
The machine-generated tables are in [data/ANALYSIS.md](data/ANALYSIS.md).

```
docker compose up                              # mainnet DRY-RUN end to end: nothing is sent, nothing is spent
docker compose --profile test run --rm test    # offline unit tests (tx encoding, spend cap)
docker compose --profile verify run --rm verify   # re-fetch every block with a probe, compare with data/blocks
docker compose run --rm itb analyze            # rebuild data/ANALYSIS.md from the raw data, no network
```

## Short answer

| Client (gossip `clientId` + version) | Stake share 25.10 | If our probes arrive **together** and compete for the same account | If they arrive **15-150 ms apart** | Verdict |
|---|---|---|---|---|
| Agave 4.3.2 (vanilla, control) | 0.9% | ordered by fee within each scheduling pass (sorted stretches) | arrival increasingly wins with the gap | fee-priority among what is queued at the same time (matches the open-source greedy scheduler); smallest sample |
| AgaveBam 4.3.2 (Jito BAM) | 35.6% | ordered by fee | arrival increasingly wins | same as Agave for transactions that reach the validator's own TPU |
| JitoLabs 4.3.2 (Jito-Solana) | 22.9% | mostly by fee, weakest of all | arrival dominates | fee matters weakly, arrival strongly |
| HarmonicAgave 4.3.2 | 21.6% | ordered by fee | **arrival, strictly** (30 ms late = never ahead) | arrival-ordered with a ~15-30 ms batching granularity; fee only breaks ties inside it |
| HarmonicFiredancer 26.10.4 | 8.7% | ordered by fee | **arrival, strictly** | same as HarmonicAgave |
| Firedancer 26.10.4 | 6.4% | ordered by fee | neither arrival nor fee explains the order (~50%) | fee-priority when it can compare; otherwise no detectable rule at our resolution |
| FireBAM 26.10.4 | 1.6% | ordered by fee | ~50% | like Firedancer |
| Rakurai 4.3.2 | 1.2% | mostly by fee | ~50% | weak fee preference, no arrival rule |

Two cross-client observations:

* **Without a write-lock conflict between our probes, position is largely noise for most clients**
  (60% "fee first" for Firedancer/Harmonic, 43% for Jito when they arrive together). Independent
  transactions run on parallel execution threads, and the order in the block is the order in which
  those threads recorded their entries. Agave and BAM keep the most fee order here.
* **Whether a probe lands at all did not depend on its fee** (identical landing rate for every fee
  level, 0 to 500,000 micro-lamports per CU): batches land whole or not at all. So the ordering
  results are not distorted by fee-dependent survival.

The exact numbers with 95% confidence intervals are in [REPORT.md](REPORT.md) and [data/ANALYSIS.md](data/ANALYSIS.md).

## Design

### Probes

Every probe is a legacy transaction with exactly three instructions:

```
SetComputeUnitLimit(8000)  SetComputeUnitPrice(p)  Memo("itb" + 7 chars of window slot + arm + index)
```

* The memo is always **12 bytes**. The Memo program charges ~350 CU per byte (measured with
  `simulateTransaction`: 1 byte 2,073 CU, 12 bytes 6,234 CU, 24 bytes 10,353 CU), so a fixed length makes
  every probe cost exactly the same compute. The only thing that differs between probes of a batch is
  the compute-unit price `p`. Under Agave's rule
  `priority = reward * 1e6 / (cost + 1)` ([`core/src/transaction_priority.rs` @ v4.3.2](https://github.com/anza-xyz/agave/blob/v4.3.2/core/src/transaction_priority.rs))
  this makes "higher price" and "higher priority" the same thing, so the result does not depend on
  whether a client ranks by price, by total fee or by fee per CU.
* Fee ladder (micro-lamports per CU): `0, 1000, 5000, 20000, 50000, 100000, 250000, 500000`.
  Max cost per probe 5,000 + 4,000 lamports.
* Transactions are built and signed in-process with `node:crypto` ed25519 and a 60-line legacy
  serializer: no Solana SDK, so nothing hidden happens between "built" and "sent".

### Batches and arms

One batch = 8 probes sent into one leader window. The fee of probe *i* and its position in the
send order are two **independent** random permutations (seeded, seed in `config.json`). Arms rotate per window:

| Arm | Fees | Payer | What it isolates |
|---|---|---|---|
| **F** | ladder | one shared payer | probes write-lock the same account, so the leader must serialize them: pure scheduler order |
| **N** | ladder | 8 different payers | no conflicts between probes: scheduler order + parallel execution |
| **T** | all equal (50,000) | one shared payer | priority tied: only arrival / tie-break can order them |

### Timing modes (separate runs, recorded in each `data/runs/*/config.json`)

* **Spaced** (run 1): probes leave 15 ms apart, starting when our tip is 1 slot before the window.
* **Burst** (runs 2-3): all 8 leave in < 1 ms, 1 or 2 slots before the window, so they wait in the
  leader's buffer together.

The decisive table ("Fee vs arrival" in `data/ANALYSIS.md`) uses only pairs where the **higher-fee
probe left later or at the same time** as the lower-fee one. If the leader orders by fee, the
higher-fee probe still comes first; if it orders by arrival, it comes second. Bucketing by how much
later it was sent (<1 ms, 1-20, 20-50, 50-150 ms) turns this into a dose-response curve.

### Targets

Client identity comes from gossip: `getClusterNodes` returns `clientId` and `version` for every node.
For each client we pick the 2-3 highest-stake validators (more windows per hour) running that client's
dominant version, with at least 50,000 SOL activated stake. Snapshots of all validators are stored at
the start and end of every run (`validators-start.json`, `validators-end.json`).

## What you will have to account for, and how this design handles it

**Leader schedule and leader types.** `getLeaderSchedule` for the current epoch, leader windows of 4
consecutive slots. We do not trust the schedule alone: every collected block carries the leader's
identity in its `Fee` reward, and the "Window check" table shows that of 949 targeted slots collected,
948 were produced by the targeted validator, 0 by another leader, 0 skipped, and 1 block had no `Fee`
reward entry so its producer could not be confirmed. Evidence is
attributed to the **client of the validator that actually built the block**, never to the one we aimed
at: a probe that spills into the next leader's block counts as evidence about that next leader.
After Alpenglow slots are ~211 ms (measured with `getRecentPerformanceSamples` and block times), not
400 ms, which matters for every timing decision below.

**The path from our backend to the executing node.** Two paths, both implemented, both measured:

* `tpu` (primary): a Rust sidecar (`sender/`, quinn + rustls) opens a QUIC connection to the leader's
  `tpuQuic` address from gossip **before** the window (handshake not in the measurement), then opens
  one unidirectional stream per probe, strictly in send order, and timestamps each stream in
  microseconds. We present a throwaway self-signed ed25519 certificate, so we are an **unstaked** peer
  (lowest stake-weighted QoS tier), exactly like an ordinary user.
* `rpc`: `sendTransaction` to the public mainnet RPC with `skipPreflight` and `maxRetries: 0`.
  The pilot showed this path delivers 1-2 s late (5-10 slots): half of the probes landed in the next
  leaders' blocks. It is kept as a comparison and is reported separately.

What the gossip address actually is differs by client, and that is part of the answer, not noise:
both Harmonic clients advertise the **same IP with different ports** (for example
`198.13.140.105:12341` and `:12349`), so their transactions enter through Harmonic's shared remote
TPU / builder, not the validator itself. BAM validators accepted our direct TPU traffic and ordered it
like Agave; what BAM's own TEE node does with transactions sent to it is not measured here.
Agave holds or drops packets differently depending on how close its leader slot is: sending 2 slots
early instead of 1 cut the landing rate for Agave from 64% to 38% (REPORT.md).

**Interaction of our own transactions with each other.** Controlled by the arms: F forces a
write-lock conflict (shared fee payer), N removes it, T removes the fee difference. All probes of a
batch share one blockhash and differ in memo, so they never deduplicate. All have identical CU limit,
signature count, account count and size.

**Competition inside the block.** We never compare our probe with someone else's transaction:
only the relative order of our own probes inside one block. Foreign transactions between our probes
are counted (median per group in the tables). Agave publishes a priority floor and drops low-priority
packets upstream when saturated (`SchedulerPriorityFloor` in v4.3.2), which could bias *which* probes
survive; we checked: the landing rate was identical across all 8 fee levels in every run.
As supplementary context we also correlate position with compute-unit price for **all** non-vote
transactions of every collected block (mean Spearman rho between -0.05 and +0.15 for every client, 997 blocks):
blocks as a whole are not sorted by fee, which is why the controlled probes are needed.
After Alpenglow, votes are no longer transactions in blocks (0 vote transactions in all collected
blocks); 38% of transactions are the new v1 format, whose fee is in `transactionConfig` rather than in
ComputeBudget instructions, and the parser handles both.

**Send order.** Randomized independently of fee in every batch, recorded per probe (`sendSeq`,
`sentAtUs` from the sidecar). The spaced/burst comparison is the experiment on send order itself.

**Noise versus rule.** The unit of evidence is a pair of our probes in the same block. Pairs within a
batch are not independent, so all confidence intervals are bootstrapped over batches (2,000 resamples).
A rule is claimed only where the interval is far from 50% and the effect is consistent between runs;
"~50%, no detectable rule" is reported as a result, not hidden (Firedancer, FireBAM and Rakurai in the
spaced mode). Batches that could not reach their window (our network dropped for 4 minutes in run 1)
are skipped instead of being sent late.

## What this design does NOT separate

* **Send time versus arrival time at the leader.** We control when a probe leaves our machine (µs),
  not when it arrives. Network jitter on the way (RTT 38-120 ms to these validators) is folded into
  "arrival". The burst mode makes this mostly irrelevant, the spaced mode does not.
* **Scheduler versus execution threads.** The index in the block is the order in which entries were
  recorded. For non-conflicting probes (arm N) this mixes the scheduler's decision with parallel
  execution on several banking threads; we cannot see which of the two reordered them.
* **Validator versus external builder.** For Harmonic, and for BAM transactions that go through BAM
  nodes, the order may be decided outside the validator. We measure the outcome in the block, not
  which component decided it.
* **Stake-weighted QoS.** We are unstaked. A staked sender (or a paid RPC with SWQoS) may see different
  landing and possibly different ordering.
* **Per-operator configuration.** Two validators on the same client may run different flags, block
  engine or builder settings. We measured 2-3 validators per client and report per client, not per
  validator; the raw data allows a per-validator split.
* **Bundles.** Jito bundles and tips are out of scope and we send none. Bundles of other users may sit
  between our probes, which only adds foreign transactions, never reorders ours.
* **Time of day and load.** All runs were within 24 hours (25-26.10.2026). A congested day may behave differently.

## Spend cap, dry-run and safety

* **Dry-run is the default.** It does everything a live run does (snapshot, schedule, QUIC
  connection to the leader, building and signing with a throwaway key, waiting for the window,
  collecting the targeted blocks) except handing transactions to the network.
* **Live needs three things at once:** a key file mounted read-only at `/keys/burner.json`,
  `LIVE=I_UNDERSTAND_THIS_SPENDS_SOL` in the environment, and the `--live` flag. Missing any one of
  them = dry-run, with a log line saying why.
* **Spend cap (default 0.05 SOL, maximum 0.1):** every transaction is charged at its worst-case fee
  (base + full requested priority fee) **before** it leaves the process, into
  `data/spend-ledger.json`. A whole batch is charged first; if it does not fit, nothing of it is sent.
  The ledger survives restarts, and a later run can only lower the stored cap, never raise it.
  Independently, the real on-chain balance drop (main wallet + sub-payers) is checked against the cap
  at the start of every live run.
* Keys never enter the image or the repo (`.gitignore`, `.dockerignore`); they are only a read-only volume.

Totals for this study: see REPORT.md (worst-case reserved and actual on-chain spend).

## Repository layout

```
docker-compose.yml   one-command run (dry-run by default), test and verify profiles
Dockerfile           2 stages: Rust QUIC sidecar -> Node 24 (runs the TypeScript directly)
sender/              tpu-send: QUIC client for the leader TPU (Rust)
src/
  main.ts            CLI: all | run | collect | analyze | verify | status | fund | sweep
  experiment.ts      target selection, window plan, batch building, sending
  schedule.ts        leader schedule, slot tracker (websocket + polling fallback)
  solana.ts, b58.ts  transaction serialization and signing, no SDK
  ledger.ts          spend cap
  collect.ts         signature statuses + blocks (trimmed), v1 transaction support
  analyze.ts         pair statistics, bootstrap CIs, fee-vs-arrival, supplementary block correlation
test/                offline unit tests
data/
  runs/<run>/        config.json, targets.json, plan.json, windows.jsonl, probes.jsonl, statuses.json,
                     validators-start.json, validators-end.json
  blocks/<slot>.json trimmed getBlock: order, signature, fee, CU, cost units, compute-budget settings
  logs/              structured JSON log of every command
  spend-ledger.json  every live transaction with its worst-case fee
  ANALYSIS.md        generated tables
```

## Verifying a claim by hand

Every probe in `data/runs/*/probes.jsonl` has its signature, target, arm, fee, send order and send
time. `data/landed-probes.json` lists where each landed. To check one:

```
curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[<slot>,{"encoding":"json","transactionDetails":"signatures","rewards":true,"maxSupportedTransactionVersion":1}]}'
```

The position of the signature in `result.signatures` is the index we used; the `Fee` reward pubkey is
the leader. `docker compose --profile verify run --rm verify` does this for every block that contains a probe.

## Running it yourself

1. `cp .env.example .env` (optional; every setting has a safe default).
2. `docker compose up` for a dry-run, which shows whether you hit the windows from your location.
3. For live: put a funded Solana CLI keypair at `keys/burner.json`, set `LIVE=I_UNDERSTAND_THIS_SPENDS_SOL`
   in `.env`, then
   `docker compose run --rm itb fund --live` (only for arm N) and
   `docker compose run --rm itb all --live`. Recover the sub-payers with `docker compose run --rm itb sweep --live`.

The exact environment of each of our runs is in `data/runs/<run>/config.json`.
