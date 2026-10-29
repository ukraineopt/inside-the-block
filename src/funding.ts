// Sub-payers for arm N. Funding moves SOL between our own accounts (not spent); sweep returns it.
// Both are live-only actions and their fees go through the same spend ledger.
import type { Config } from './config.ts';
import { log } from './log.ts';
import { rpc, sleep } from './rpc.ts';
import { SpendLedger } from './ledger.ts';
import { buildTransferTx, maxFeeLamports, type Keypair } from './solana.ts';

export const SUBPAYER_FUND_LAMPORTS = 2_500_000n; // rent-exempt minimum (890,880) + ~1.6M for ~170 probe fees each

export async function balance(rpcUrl: string, pubkey: string): Promise<bigint> {
  const r = await rpc<{ value: number }>(rpcUrl, 'getBalance', [pubkey, { commitment: 'confirmed' }]);
  return BigInt(r.value);
}

async function blockhash(rpcUrl: string): Promise<string> {
  return (await rpc<{ value: { blockhash: string } }>(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
}

const TRANSFER_CU_LIMIT = 1000;
const TRANSFER_CU_PRICE = 100_000n;

export async function fundSubPayers(cfg: Config, payer: Keypair, subs: Keypair[], ledger: SpendLedger): Promise<void> {
  for (const s of subs) {
    const have = await balance(cfg.rpcUrl, s.publicKey);
    if (have >= SUBPAYER_FUND_LAMPORTS / 2n) {
      log('fund.skip', { sub: s.publicKey, have });
      continue;
    }
    const tx = buildTransferTx({ from: payer, to: s.publicKey, lamports: SUBPAYER_FUND_LAMPORTS - have, blockhash: await blockhash(cfg.rpcUrl), cuLimit: TRANSFER_CU_LIMIT, cuPriceMicroLamports: TRANSFER_CU_PRICE });
    ledger.charge(tx.signature, maxFeeLamports(TRANSFER_CU_LIMIT, TRANSFER_CU_PRICE), 'fund');
    const sig = await rpc<string>(cfg.rpcUrl, 'sendTransaction', [tx.wire.toString('base64'), { encoding: 'base64' }]);
    log('fund.sent', { sub: s.publicKey, sig });
    await sleep(1500);
  }
  // wait until every sub-payer is visibly funded, so the experiment that follows can use arm N
  for (let i = 0; i < 40; i++) {
    const bals = await Promise.all(subs.map((s) => balance(cfg.rpcUrl, s.publicKey)));
    if (bals.every((b) => b >= SUBPAYER_FUND_LAMPORTS / 2n)) {
      log('fund.confirmed', { subPayers: subs.length });
      return;
    }
    await sleep(1500);
  }
  throw new Error('sub-payers not funded after 60s, check the fund.sent signatures');
}

export async function sweepSubPayers(cfg: Config, payer: Keypair, subs: Keypair[], ledger: SpendLedger): Promise<void> {
  for (const s of subs) {
    const have = await balance(cfg.rpcUrl, s.publicKey);
    const fee = maxFeeLamports(TRANSFER_CU_LIMIT, TRANSFER_CU_PRICE);
    if (have <= fee) continue;
    // send everything minus the fee: the account is left at 0 and closed
    const tx = buildTransferTx({ from: s, to: payer.publicKey, lamports: have - fee, blockhash: await blockhash(cfg.rpcUrl), cuLimit: TRANSFER_CU_LIMIT, cuPriceMicroLamports: TRANSFER_CU_PRICE });
    ledger.charge(tx.signature, fee, 'sweep');
    const sig = await rpc<string>(cfg.rpcUrl, 'sendTransaction', [tx.wire.toString('base64'), { encoding: 'base64' }]);
    log('sweep.sent', { sub: s.publicKey, lamports: have - fee, sig });
    await sleep(1500);
  }
}

// Send everything left on the burner (minus the fee) to an address the owner chooses. Live only.
export async function withdrawAll(cfg: Config, payer: Keypair, to: string, ledger: SpendLedger): Promise<void> {
  const have = await balance(cfg.rpcUrl, payer.publicKey);
  const fee = maxFeeLamports(TRANSFER_CU_LIMIT, TRANSFER_CU_PRICE);
  if (have <= fee) {
    log('withdraw.nothing', { have });
    return;
  }
  const tx = buildTransferTx({ from: payer, to, lamports: have - fee, blockhash: await blockhash(cfg.rpcUrl), cuLimit: TRANSFER_CU_LIMIT, cuPriceMicroLamports: TRANSFER_CU_PRICE });
  ledger.charge(tx.signature, fee, 'withdraw');
  const sig = await rpc<string>(cfg.rpcUrl, 'sendTransaction', [tx.wire.toString('base64'), { encoding: 'base64' }]);
  ledger.recordWithdrawal(tx.signature, have - fee);
  log('withdraw.sent', { to, lamports: have - fee, sig });
}
