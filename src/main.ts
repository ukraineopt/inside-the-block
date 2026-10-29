// CLI entry point. `node src/main.ts <command> [--live]`
//   all      (default) run -> collect -> analyze. Dry-run unless --live AND LIVE=I_UNDERSTAND_THIS_SPENDS_SOL
//   run      send (or, in dry-run, only build/sign/time) batches into the selected leader windows
//   collect  fetch statuses + blocks for every run (idempotent)
//   analyze  write data/ANALYSIS.md from raw data only (no network)
//   verify   re-fetch every block that contains a probe from RPC and compare with the stored copy
//   status   wallet, sub-payer balances and spend ledger
//   fund / sweep  move SOL to / back from the arm-N sub-payers (live only)
//   withdraw <address>  send what is left on the burner to <address> (live only)
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, wantsLiveFlagWithoutConfirm } from './config.ts';
import { log, setLogFile } from './log.ts';
import { SpendLedger } from './ledger.ts';
import { keypairFromSeed, loadKeypairFile, type Keypair } from './solana.ts';
import { runExperiment, subPayers } from './experiment.ts';
import { collectRun, fetchBlock, type TrimmedBlock } from './collect.ts';
import { writeAnalysis } from './analyze.ts';
import { balance, fundSubPayers, sweepSubPayers, withdrawAll } from './funding.ts';
import { b58decode } from './b58.ts';
import { sleep } from './rpc.ts';

async function main(): Promise<void> {
  const cmd = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'all';
  const cfg = loadConfig();
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (cfg.live ? '-live' : '-dry');
  mkdirSync(join(cfg.dataDir, 'logs'), { recursive: true });
  setLogFile(join(cfg.dataDir, 'logs', `${runId}-${cmd}.jsonl`));
  if (wantsLiveFlagWithoutConfirm()) {
    log('live.refused', { reason: '--live given but LIVE=I_UNDERSTAND_THIS_SPENDS_SOL is not set; staying in dry-run' });
  }
  log('start', { cmd, live: cfg.live, rpc: cfg.rpcUrl, capSol: Number(cfg.spendCapLamports) / 1e9, seed: cfg.seed });

  let payer: Keypair;
  let seed: Uint8Array;
  if (existsSync(cfg.keypairPath)) {
    payer = loadKeypairFile(cfg.keypairPath);
    seed = Uint8Array.from((JSON.parse(readFileSync(cfg.keypairPath, 'utf8')) as number[]).slice(0, 32));
  } else {
    if (cfg.live || cmd === 'fund' || cmd === 'sweep' || cmd === 'withdraw') throw new Error(`live mode needs a keypair at ${cfg.keypairPath}`);
    seed = randomBytes(32);
    payer = keypairFromSeed(seed); // throwaway key: dry-run signs real-looking txs but never sends them
  }
  const subs = subPayers(seed, cfg.batchSize);
  const ledger = cfg.live ? new SpendLedger(join(cfg.dataDir, 'spend-ledger.json'), cfg.spendCapLamports) : null;

  const runsDir = join(cfg.dataDir, 'runs');
  const blocksDir = join(cfg.dataDir, 'blocks');

  async function liveGuards(): Promise<void> {
    if (!ledger) return;
    const main = await balance(cfg.rpcUrl, payer.publicKey);
    let locked = 0n;
    for (const s of subs) locked += await balance(cfg.rpcUrl, s.publicKey);
    ledger.bindWallet(payer.publicKey, main + locked);
    const onChainSpent = ledger.checkOnChain(main, locked);
    log('wallet', { payer: payer.publicKey, balance: main, subPayersLocked: locked, onChainSpent, ledgerReserved: ledger.reserved, capRemaining: ledger.remaining });
  }

  switch (cmd) {
    case 'status': {
      log('wallet', { payer: payer.publicKey, balance: await balance(cfg.rpcUrl, payer.publicKey) });
      for (const s of subs) log('subpayer', { pubkey: s.publicKey, balance: await balance(cfg.rpcUrl, s.publicKey) });
      if (existsSync(join(cfg.dataDir, 'spend-ledger.json'))) {
        const l = JSON.parse(readFileSync(join(cfg.dataDir, 'spend-ledger.json'), 'utf8')) as { reservedLamports: string; capLamports: string; txCount: number };
        log('ledger', { reservedSol: Number(l.reservedLamports) / 1e9, capSol: Number(l.capLamports) / 1e9, txCount: l.txCount });
      }
      return;
    }
    case 'withdraw': {
      if (!ledger) throw new Error('withdraw moves real SOL: needs --live and LIVE=I_UNDERSTAND_THIS_SPENDS_SOL');
      const to = process.argv.slice(3).find((a) => !a.startsWith('--'));
      if (!to || b58decode(to).length !== 32) throw new Error('usage: withdraw <base58 address> --live');
      await withdrawAll(cfg, payer, to, ledger);
      return;
    }
    case 'fund':
    case 'sweep': {
      if (!ledger) throw new Error(`${cmd} moves real SOL: needs --live and LIVE=I_UNDERSTAND_THIS_SPENDS_SOL`);
      await liveGuards();
      if (cmd === 'fund') await fundSubPayers(cfg, payer, subs, ledger);
      else await sweepSubPayers(cfg, payer, subs, ledger);
      return;
    }
    case 'run':
    case 'all': {
      await liveGuards();
      const runDir = join(runsDir, runId);
      await runExperiment({ cfg, runId, runDir, payer, subs, ledger });
      if (cmd === 'run') return;
      log('wait', { seconds: 40, why: 'let the last batch finalize before collecting' });
      await sleep(40_000);
      await collectRun(cfg.rpcUrl, runDir, blocksDir);
      writeAnalysis(cfg.dataDir, join(cfg.dataDir, 'ANALYSIS.md'));
      return;
    }
    case 'collect': {
      const only = process.argv.slice(3).find((a) => !a.startsWith('--'));
      for (const r of readdirSync(runsDir).sort()) if (!only || r === only) await collectRun(cfg.rpcUrl, join(runsDir, r), blocksDir);
      return;
    }
    case 'analyze':
      writeAnalysis(cfg.dataDir, join(cfg.dataDir, 'ANALYSIS.md'));
      return;
    case 'verify': {
      // For every stored block that contains one of our probes: re-fetch from RPC, compare the order of signatures.
      let ok = 0, bad = 0, errors = 0;
      const verifyOne = async (stored: TrimmedBlock, ours: TrimmedBlock['txs'], tmp: string): Promise<TrimmedBlock> => {
        // one retry after a pause: the public RPC sometimes returns an empty result for an existing block
        try {
          return await fetchBlock(cfg.rpcUrl, stored.slot, new Set(ours.map((t) => t.sig)), tmp);
        } catch {
          await sleep(3000);
          return await fetchBlock(cfg.rpcUrl, stored.slot, new Set(ours.map((t) => t.sig)), tmp);
        }
      };
      for (const f of readdirSync(blocksDir)) {
        const stored = JSON.parse(readFileSync(join(blocksDir, f), 'utf8')) as TrimmedBlock;
        const ours = stored.txs.filter((t) => t.memo?.startsWith('itb'));
        if (!ours.length) continue;
        const tmp = join(cfg.dataDir, 'verify-tmp');
        mkdirSync(tmp, { recursive: true });
        let fresh: TrimmedBlock;
        try {
          fresh = await verifyOne(stored, ours, tmp);
        } catch (e) {
          errors++;
          log('verify.error', { slot: stored.slot, error: String(e) });
          continue;
        }
        const same = ours.every((t) => fresh.txs[t.i]?.sig === t.sig) && fresh.txCount === stored.txCount;
        if (same) ok++; else bad++;
        log(same ? 'verify.ok' : 'verify.MISMATCH', { slot: stored.slot, probes: ours.length });
        await sleep(150);
      }
      log('verify.done', { ok, mismatched: bad, couldNotFetch: errors });
      if (bad || errors) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().catch((e) => {
  log('fatal', { error: String(e instanceof Error ? e.stack : e) });
  process.exit(1);
});
