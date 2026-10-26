// Leader schedule and slot tracking.
import { rpc, sleep } from './rpc.ts';
import { log } from './log.ts';

export const SLOTS_PER_WINDOW = 4;

export interface EpochInfo {
  epoch: number;
  absoluteSlot: number;
  slotIndex: number;
  slotsInEpoch: number;
}

export interface LeaderWindow {
  identity: string;
  startSlot: number; // first slot of a 4-slot leader window
}

export async function leaderWindows(rpcUrl: string, identities: string[]): Promise<{ epoch: EpochInfo; windows: LeaderWindow[]; slotLeader: Map<number, string> }> {
  const epoch = await rpc<EpochInfo>(rpcUrl, 'getEpochInfo');
  const firstSlot = epoch.absoluteSlot - epoch.slotIndex;
  const sched = await rpc<Record<string, number[]> | null>(rpcUrl, 'getLeaderSchedule', [null]);
  if (!sched) throw new Error('getLeaderSchedule returned null');
  const slotLeader = new Map<number, string>();
  for (const [id, idxs] of Object.entries(sched)) for (const i of idxs) slotLeader.set(firstSlot + i, id);
  const windows: LeaderWindow[] = [];
  const want = new Set(identities);
  for (const [id, idxs] of Object.entries(sched)) {
    if (!want.has(id)) continue;
    for (const i of idxs) if (i % SLOTS_PER_WINDOW === 0) windows.push({ identity: id, startSlot: firstSlot + i });
  }
  windows.sort((a, b) => a.startSlot - b.startSlot);
  return { epoch, windows, slotLeader };
}

// Tracks the cluster tip via slotSubscribe (websocket), falling back to getSlot polling.
export class SlotTracker {
  slot = 0;
  updatedAt = 0;
  private ws: WebSocket | null = null;
  private closed = false;
  private rpcUrl: string;
  private wsUrl: string;

  constructor(rpcUrl: string, wsUrl: string) {
    this.rpcUrl = rpcUrl;
    this.wsUrl = wsUrl;
  }

  async start(): Promise<void> {
    this.slot = await rpc<number>(this.rpcUrl, 'getSlot', [{ commitment: 'processed' }]);
    this.updatedAt = Date.now();
    this.connect();
    void this.pollLoop();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { params?: { result?: { slot: number } } };
      const s = msg.params?.result?.slot;
      if (typeof s === 'number' && s > this.slot) {
        this.slot = s;
        this.updatedAt = Date.now();
      }
    };
    ws.onclose = () => {
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => ws.close();
  }

  // Poll as a safety net if the websocket goes quiet for >1.5s.
  private async pollLoop(): Promise<void> {
    while (!this.closed) {
      await sleep(500);
      if (Date.now() - this.updatedAt < 1500) continue;
      try {
        const s = await rpc<number>(this.rpcUrl, 'getSlot', [{ commitment: 'processed' }], 1);
        if (s > this.slot) {
          this.slot = s;
          this.updatedAt = Date.now();
        }
      } catch (e) {
        log('slot.poll_error', { error: String(e) });
      }
    }
  }

  async waitFor(slot: number): Promise<number> {
    while (this.slot < slot) await sleep(20);
    return this.slot;
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }
}
