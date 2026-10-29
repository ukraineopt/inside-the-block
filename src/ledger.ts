// Spend cap. Every transaction is charged at its WORST-CASE fee (base + full requested priority fee)
// BEFORE it is sent. The ledger is a file on the data volume, so the cap holds across restarts and runs.
// A second, independent check compares the real on-chain balance drop against the cap.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

interface LedgerFile {
  capLamports: string;
  reservedLamports: string;
  txCount: number;
  wallet: string | null;
  startBalanceLamports: string | null;
  // owner's own money moving in and out is not spend: withdrawals and later top-ups are tracked separately
  withdrawnLamports?: string;
  depositedLamports?: string;
  lastOnChainSpentLamports?: string; // spend can only grow: used to tell a top-up from a refund
  entries: { ts: string; signature: string; maxFeeLamports: string; kind: string; amountLamports?: string }[];
}

export class SpendCapExceeded extends Error {}

export class SpendLedger {
  private path: string;
  private data: LedgerFile;
  readonly cap: bigint;

  constructor(path: string, cap: bigint) {
    this.path = path;
    this.cap = cap;
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as LedgerFile)
      : { capLamports: cap.toString(), reservedLamports: '0', txCount: 0, wallet: null, startBalanceLamports: null, entries: [] };
    // A cap stored earlier can only be lowered by a later run, never raised.
    const stored = BigInt(this.data.capLamports);
    if (cap > stored) this.cap = stored;
    this.data.capLamports = this.cap.toString();
  }

  get reserved(): bigint {
    return BigInt(this.data.reservedLamports);
  }

  get remaining(): bigint {
    return this.cap - this.reserved;
  }

  bindWallet(wallet: string, balance: bigint): void {
    if (this.data.wallet && this.data.wallet !== wallet) {
      throw new Error(`ledger belongs to wallet ${this.data.wallet}, refusing to mix with ${wallet}`);
    }
    if (!this.data.wallet) {
      this.data.wallet = wallet;
      this.data.startBalanceLamports = balance.toString();
      this.flush();
    }
  }

  // Independent check: the real balance drop since the first live run must stay under the cap.
  // `lockedLamports` = SOL parked in our own sub-payer accounts (not spent, recoverable by sweep).
  // Money the owner withdrew is added back; money that appears beyond what was ever there is a top-up.
  checkOnChain(balance: bigint, lockedLamports: bigint): bigint {
    if (this.data.startBalanceLamports === null) return 0n;
    const withdrawn = BigInt(this.data.withdrawnLamports ?? '0');
    let deposited = BigInt(this.data.depositedLamports ?? '0');
    const lastSpent = BigInt(this.data.lastOnChainSpentLamports ?? '0');
    const have = balance + lockedLamports;
    // more than could be left given what was already spent: the owner topped up, the excess is a deposit
    const maxLeft = BigInt(this.data.startBalanceLamports) + deposited - withdrawn - lastSpent;
    if (have > maxLeft) {
      deposited += have - maxLeft;
      this.data.depositedLamports = deposited.toString();
    }
    const spent = BigInt(this.data.startBalanceLamports) + deposited - withdrawn - have;
    this.data.lastOnChainSpentLamports = spent.toString();
    this.flush();
    if (spent > this.cap) throw new SpendCapExceeded(`on-chain spend ${spent} lamports exceeds cap ${this.cap}`);
    return spent;
  }

  recordWithdrawal(signature: string, amount: bigint): void {
    this.data.withdrawnLamports = (BigInt(this.data.withdrawnLamports ?? '0') + amount).toString();
    const e = this.data.entries.find((x) => x.signature === signature);
    if (e) e.amountLamports = amount.toString();
    this.flush();
  }

  canAfford(maxFees: bigint[]): boolean {
    return maxFees.reduce((a, b) => a + b, 0n) <= this.remaining;
  }

  // Must be called (and must succeed) before a transaction leaves the process.
  charge(signature: string, maxFee: bigint, kind: string): void {
    if (this.reserved + maxFee > this.cap) {
      throw new SpendCapExceeded(`cap ${this.cap} would be exceeded: reserved ${this.reserved} + ${maxFee}`);
    }
    this.data.reservedLamports = (this.reserved + maxFee).toString();
    this.data.txCount++;
    this.data.entries.push({ ts: new Date().toISOString(), signature, maxFeeLamports: maxFee.toString(), kind });
    this.flush();
  }

  private flush(): void {
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.path);
  }
}
