// Structured logging: human line on stderr + JSON line appended to data/logs/<run>.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let logFile: string | null = null;

export function setLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  const rec = { ts: new Date().toISOString(), event, ...fields };
  const line = JSON.stringify(rec, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const short = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : v}`)
    .join(' ');
  process.stderr.write(`${rec.ts.slice(11, 23)} ${event} ${short}\n`);
  if (logFile) appendFileSync(logFile, line + '\n');
}
