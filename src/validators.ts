// Validator snapshot: identity -> client (gossip clientId), version, stake. Taken at the start and end of every run.
import { rpc } from './rpc.ts';

export interface ValidatorInfo {
  identity: string;
  vote: string;
  clientId: string;
  version: string;
  activatedStakeSol: number;
  stakeShare: number;
  tpuQuic: string | null;
}

interface ClusterNode {
  pubkey: string;
  clientId?: string;
  version: string | null;
  tpuQuic?: string | null;
}

interface VoteAccount {
  nodePubkey: string;
  votePubkey: string;
  activatedStake: number;
}

export async function snapshotValidators(rpcUrl: string): Promise<ValidatorInfo[]> {
  const [nodes, votes] = await Promise.all([
    rpc<ClusterNode[]>(rpcUrl, 'getClusterNodes'),
    rpc<{ current: VoteAccount[] }>(rpcUrl, 'getVoteAccounts'),
  ]);
  const byId = new Map(nodes.map((n) => [n.pubkey, n]));
  const total = votes.current.reduce((a, v) => a + v.activatedStake, 0);
  return votes.current
    .map((v) => {
      const n = byId.get(v.nodePubkey);
      return {
        identity: v.nodePubkey,
        vote: v.votePubkey,
        clientId: n?.clientId ?? 'unknown',
        version: n?.version ?? 'unknown',
        activatedStakeSol: v.activatedStake / 1e9,
        stakeShare: v.activatedStake / total,
        tpuQuic: n?.tpuQuic ?? null,
      };
    })
    .sort((a, b) => b.activatedStakeSol - a.activatedStakeSol);
}

// Client group = gossip clientId + version, e.g. "AgaveBam 4.3.2".
export function clientGroup(v: Pick<ValidatorInfo, 'clientId' | 'version'>): string {
  return `${v.clientId} ${v.version}`;
}

export function stakeByGroup(vals: ValidatorInfo[]): { group: string; share: number; count: number }[] {
  const m = new Map<string, { share: number; count: number }>();
  for (const v of vals) {
    const g = m.get(clientGroup(v)) ?? { share: 0, count: 0 };
    g.share += v.stakeShare;
    g.count++;
    m.set(clientGroup(v), g);
  }
  return [...m.entries()].map(([group, g]) => ({ group, ...g })).sort((a, b) => b.share - a.share);
}
