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
