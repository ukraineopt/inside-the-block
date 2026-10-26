// Throwaway devnet key for tests (never mainnet).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { keypairFromSeed } from '../src/solana.ts';
import { b58decode } from '../src/b58.ts';
const path = 'test/.devnet-key.json';
if (!existsSync(path)) {
  mkdirSync('test', { recursive: true });
  const seed = randomBytes(32);
  const kp = keypairFromSeed(seed);
  writeFileSync(path, JSON.stringify([...seed, ...b58decode(kp.publicKey)]));
}
console.log(JSON.parse(readFileSync(path, 'utf8')).length);
