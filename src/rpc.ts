// Thin JSON-RPC client with retry/backoff for 429/5xx. No Solana SDK on purpose.
import { log } from './log.ts';

export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

let nextId = 1;

export async function rpc<T>(url: string, method: string, params: unknown[] = [], retries = 6): Promise<T> {
  let delay = 400;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (attempt >= retries) throw e;
      log('rpc.retry', { method, reason: String(e), attempt });
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new Error(`${method}: HTTP ${res.status}`);
      log('rpc.retry', { method, status: res.status, attempt });
      await sleep(delay);
      delay *= 2;
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new RpcError(body.error.code, `${method}: ${body.error.message}`, body.error.data);
    return body.result as T;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
