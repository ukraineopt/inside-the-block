// All settings come from env (docker compose passes .env). Defaults are the safe ones: dry-run, mainnet read-only.
export interface Config {
  rpcUrl: string;
  wsUrl: string;
  sendRpcUrls: string[];
  sendPaths: string[];
  tpuSenderBin: string;
  live: boolean;
  spendCapLamports: bigint;
  keypairPath: string;
  dataDir: string;
  targetClients: string[];
  validatorsPerClient: number;
  batchesPerValidator: number;
  batchSize: number;
  arms: string[];
  cuLimit: number;
  feeLadder: bigint[];
  leadSlots: number[];
  sendGapMs: number;
  horizonSlots: number;
  minActivatedStakeSol: number;
  seed: number;
  pinnedValidators: string[];
}

function env(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function list(name: string, def: string): string[] {
  return env(name, def)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const rpcUrl = env('RPC_URL', 'https://api.mainnet-beta.solana.com');
  const capSol = Number(env('SPEND_CAP_SOL', '0.05'));
  if (!(capSol > 0 && capSol <= 0.1)) throw new Error(`SPEND_CAP_SOL must be in (0, 0.1], got ${capSol}`);
  const cfg: Config = {
    rpcUrl,
    wsUrl: env('WS_URL', rpcUrl.replace(/^http/, 'ws')),
    sendRpcUrls: list('SEND_RPC_URLS', rpcUrl),
    // tpu = straight to the leader's QUIC TPU (gossip tpuQuic); rpc = sendTransaction via SEND_RPC_URLS.
    // Several paths rotate per batch, so every arm is measured on every path.
    sendPaths: list('SEND_PATHS', 'tpu'),
    tpuSenderBin: env('TPU_SENDER_BIN', '/usr/local/bin/tpu-send'),
    // Real sending requires BOTH the CLI flag --live and LIVE=I_UNDERSTAND_THIS_SPENDS_SOL.
    live: process.argv.includes('--live') && env('LIVE', '') === 'I_UNDERSTAND_THIS_SPENDS_SOL',
    spendCapLamports: BigInt(Math.round(capSol * 1e9)),
    keypairPath: env('KEYPAIR_PATH', '/keys/burner.json'),
    dataDir: env('DATA_DIR', 'data'),
    targetClients: list(
      'TARGET_CLIENTS',
      'Agave,JitoLabs,AgaveBam,HarmonicAgave,Firedancer,HarmonicFiredancer,FireBAM,Rakurai',
    ),
    validatorsPerClient: Number(env('VALIDATORS_PER_CLIENT', '2')),
    batchesPerValidator: Number(env('BATCHES_PER_VALIDATOR', '12')),
    batchSize: Number(env('BATCH_SIZE', '8')),
    arms: list('ARMS', 'F,T,N'),
    cuLimit: Number(env('CU_LIMIT', '8000')),
    feeLadder: list('FEE_LADDER', '0,1000,5000,20000,50000,100000,250000,500000').map((s) => BigInt(s)),
    // several values rotate per window (e.g. "1,2"), so both arrival moments are measured in the same run
    leadSlots: list('LEAD_SLOTS', '1').map(Number),
    sendGapMs: Number(env('SEND_GAP_MS', '15')),
    horizonSlots: Number(env('HORIZON_SLOTS', '9000')),
    minActivatedStakeSol: Number(env('MIN_STAKE_SOL', '50000')),
    seed: Number(env('SEED', String(Date.now() % 2 ** 31))),
    pinnedValidators: list('PIN_VALIDATORS', ''),
  };
  if (cfg.feeLadder.length < cfg.batchSize) throw new Error('FEE_LADDER needs at least BATCH_SIZE levels');
  return cfg;
}

export function wantsLiveFlagWithoutConfirm(): boolean {
  return process.argv.includes('--live') && process.env.LIVE !== 'I_UNDERSTAND_THIS_SPENDS_SOL';
}
