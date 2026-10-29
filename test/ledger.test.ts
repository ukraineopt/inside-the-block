import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger, SpendCapExceeded } from '../src/ledger.ts';

test('cap is enforced before sending and persists across instances', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'itb-')), 'ledger.json');
  const l = new SpendLedger(f, 20_000n);
  l.charge('a', 9000n, 'probe');
  l.charge('b', 9000n, 'probe');
  assert.throws(() => l.charge('c', 9000n, 'probe'), SpendCapExceeded);
  const again = new SpendLedger(f, 20_000n);
  assert.equal(again.reserved, 18_000n);
  assert.equal(again.canAfford([2000n]), true);
  assert.equal(again.canAfford([2001n]), false);
});

test('a later run cannot raise the stored cap', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'itb-')), 'ledger.json');
  new SpendLedger(f, 10_000n).charge('a', 1n, 'x');
  assert.equal(new SpendLedger(f, 99_000_000n).cap, 10_000n);
});

test('on-chain check catches spend beyond the cap', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'itb-')), 'ledger.json');
  const l = new SpendLedger(f, 1000n);
  l.bindWallet('W', 100_000n);
  l.checkOnChain(99_500n, 0n);
  assert.throws(() => l.checkOnChain(90_000n, 5_000n), SpendCapExceeded);
  assert.throws(() => l.bindWallet('OTHER', 1n));
});

test('withdrawals and later top-ups are not counted as spend', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'itb-')), 'ledger.json');
  const l = new SpendLedger(f, 1000n);
  l.bindWallet('W', 100_000n);
  l.checkOnChain(99_400n, 0n); // 600 spent on fees
  l.charge('wd', 5n, 'withdraw');
  l.recordWithdrawal('wd', 99_395n); // owner takes the rest, wallet is now 0
  assert.equal(l.checkOnChain(0n, 0n), 605n);
  assert.equal(l.checkOnChain(15_000n, 0n), 605n); // top-up detected, still 605 spent
  assert.equal(l.checkOnChain(14_800n, 0n), 805n); // 200 more fees
  assert.throws(() => l.checkOnChain(14_000n, 0n), SpendCapExceeded);
});
