// Client for the Rust sidecar `tpu-send` (sender/): direct QUIC delivery to one leader's TPU address.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface TpuReply {
  op: string;
  id?: string;
  addr?: string;
  ok: boolean;
  err?: string | null;
  t_us?: string;
  ms?: number;
  rtt_ms?: number;
}

export class TpuSender {
  private proc: ChildProcessWithoutNullStreams;
  private waiters: ((r: TpuReply) => void)[] = [];

  constructor(bin: string) {
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => process.stderr.write(`[tpu-send] ${d}`));
    createInterface({ input: this.proc.stdout }).on('line', (l) => {
      const w = this.waiters.shift();
      if (w) w(JSON.parse(l) as TpuReply);
    });
  }

  private request(req: object, replies: number): Promise<TpuReply[]> {
    const out: Promise<TpuReply>[] = [];
    for (let i = 0; i < replies; i++) out.push(new Promise((r) => this.waiters.push(r)));
    this.proc.stdin.write(JSON.stringify(req) + '\n');
    return Promise.all(out);
  }

  async connect(addr: string): Promise<TpuReply> {
    return (await this.request({ op: 'connect', addr }, 1))[0];
  }

  // Sends in the given order; one reply per transaction, in the same order.
  sendBatch(addr: string, gapMs: number, txs: { id: string; tx: string }[]): Promise<TpuReply[]> {
    return this.request({ op: 'batch', addr, gap_ms: gapMs, txs }, txs.length);
  }

  stop(): void {
    this.proc.stdin.end();
  }
}
