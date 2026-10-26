// Figures for the README, generated from the same raw data as ANALYSIS.md (no plotting library).
// Small multiples: one panel per client, one series per panel, so identity never relies on color.
import type { FeeVsArrival } from './analyze.ts';

const CONDITIONS: { label: string; match: (bucket: string) => boolean; burst: boolean }[] = [
  { label: 'queued', match: (b) => b.startsWith('same burst') && b.includes('2 slot'), burst: true },
  { label: 'mid-block', match: (b) => b.startsWith('same burst') && b.includes('1 slot'), burst: true },
  { label: '1–20', match: (b) => b === '1-20 ms later', burst: false },
  { label: '20–50', match: (b) => b === '20-50 ms later', burst: false },
  { label: '50–150', match: (b) => b === '50-150 ms later', burst: false },
];

const PANEL_W = 300;
const PANEL_H = 210;
const COLS = 4;
const PAD = { top: 46, right: 16, bottom: 50, left: 42 };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function feeVsArrivalSvg(rows: FeeVsArrival[], clientOrder: { group: string; share: number }[]): string {
  const f = rows.filter((r) => r.arm === 'F');
  const groups = clientOrder.filter((c) => f.some((r) => r.group === c.group));
  const rowsN = Math.ceil(groups.length / COLS);
  const W = COLS * PANEL_W + 16;
  const H = rowsN * PANEL_H + 76;
  const plotW = PANEL_W - PAD.left - PAD.right;
  const plotH = PANEL_H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (plotW * (i + 0.5)) / CONDITIONS.length;
  const y = (v: number) => PAD.top + plotH * (1 - v);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" role="img" aria-labelledby="t d">`);
  out.push(`<title id="t">Higher fee first, by client and arrival condition</title>`);
  out.push(`<desc id="d">Share of same-block pairs of our probes (shared fee payer) in which the higher-fee probe is earlier, when it was sent at the same time or later than the lower-fee one. 95% bootstrap intervals. Data: data/ANALYSIS.md.</desc>`);
  out.push(`<style>
  .bg{fill:#fcfcfb}.ink{fill:#0b0b0b}.ink2{fill:#52514e}.muted{fill:#898781}
  .grid{stroke:#e1e0d9;stroke-width:1}.base{stroke:#c3c2b7;stroke-width:1}.half{stroke:#898781;stroke-width:1;stroke-dasharray:3 3}
  .s{stroke:#2a78d6;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.ci{stroke:#2a78d6;stroke-width:1.5;opacity:.45}
  .dot{fill:#2a78d6;stroke:#fcfcfb;stroke-width:2}.sep{stroke:#e1e0d9;stroke-width:1}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19}.ink{fill:#f0efec}.ink2{fill:#c3c2b7}
    .grid{stroke:#2c2c2a}.base{stroke:#383835}.sep{stroke:#2c2c2a}
    .s{stroke:#3987e5}.ci{stroke:#3987e5}.dot{fill:#3987e5;stroke:#1a1a19}
  }
  text{font-size:11px}.t{font-size:13px;font-weight:600}.h{font-size:15px;font-weight:600}.v{font-size:10px;font-variant-numeric:tabular-nums}
</style>`);
  out.push(`<rect class="bg" width="${W}" height="${H}"/>`);
  out.push(`<text class="h ink" x="12" y="22">Does the higher-fee transaction still land first if it arrives later?</text>`);
  out.push(`<text class="ink2" x="12" y="42">Share of same-block pairs of our probes (shared fee payer) in which the higher-fee probe is earlier. 100% = ordered by fee, 0% = ordered by arrival,</text>`);
  out.push(`<text class="ink2" x="12" y="58">dashed line = coin flip. Left: all 8 probes sent within 1 ms (queued before the slot / arriving mid-block). Right: higher fee sent this many ms later. Bars: 95% CI.</text>`);

  groups.forEach((g, gi) => {
    const ox = 8 + (gi % COLS) * PANEL_W;
    const oy = 64 + Math.floor(gi / COLS) * PANEL_H;
    out.push(`<g transform="translate(${ox},${oy})">`);
    out.push(`<text class="t ink" x="${PAD.left}" y="22">${esc(g.group)}</text>`);
    out.push(`<text class="ink2" x="${PAD.left}" y="36">${(g.share * 100).toFixed(1)}% of stake</text>`);
    for (const v of [0, 0.5, 1]) {
      out.push(`<line class="${v === 0 ? 'base' : v === 0.5 ? 'half' : 'grid'}" x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${y(v)}" y2="${y(v)}"/>`);
      out.push(`<text class="v muted" x="${PAD.left - 6}" y="${y(v) + 3.5}" text-anchor="end">${v * 100}%</text>`);
    }
    // burst conditions on the left, spaced conditions on the right
    const sepX = (x(1) + x(2)) / 2;
    out.push(`<line class="sep" x1="${sepX}" x2="${sepX}" y1="${PAD.top}" y2="${PAD.top + plotH}"/>`);
    CONDITIONS.forEach((c, i) => out.push(`<text class="v muted" x="${x(i)}" y="${PAD.top + plotH + 15}" text-anchor="middle">${esc(c.label)}</text>`));
    out.push(`<text class="v ink2" x="${(x(0) + x(1)) / 2}" y="${PAD.top + plotH + 32}" text-anchor="middle">burst</text>`);
    out.push(`<text class="v ink2" x="${x(3)}" y="${PAD.top + plotH + 32}" text-anchor="middle">higher fee sent later, ms</text>`);
    const pts = CONDITIONS.map((c, i) => {
      const r = f.find((row) => row.group === g.group && c.match(row.bucket));
      return r && r.feeWins !== null ? { i, r, burst: c.burst } : null;
    });
    // connect only the spaced conditions: they are one dose-response curve; bursts are separate experiments
    const spaced = pts.filter((p): p is NonNullable<typeof p> => p !== null && !p.burst);
    if (spaced.length > 1) out.push(`<polyline class="s" points="${spaced.map((p) => `${x(p.i)},${y(p.r.feeWins!)}`).join(' ')}"/>`);
    for (const p of pts) {
      if (!p) continue;
      if (p.r.ci) out.push(`<line class="ci" x1="${x(p.i)}" x2="${x(p.i)}" y1="${y(p.r.ci[0])}" y2="${y(p.r.ci[1])}"/>`);
      out.push(`<circle class="dot" cx="${x(p.i)}" cy="${y(p.r.feeWins!)}" r="4.5"><title>${esc(g.group)}, ${CONDITIONS[p.i].label}: ${(p.r.feeWins! * 100).toFixed(0)}% of ${p.r.pairs} pairs, ${p.r.batches} batches</title></circle>`);
    }
    // selective direct labels: the queued burst and the largest delay
    for (const i of [0, 4]) {
      const p = pts[i];
      if (!p) continue;
      const above = p.r.feeWins! < 0.85;
      out.push(`<text class="v ink2" x="${x(i)}" y="${y(p.r.feeWins!) + (above ? -9 : 15)}" text-anchor="middle">${(p.r.feeWins! * 100).toFixed(0)}%</text>`);
    }
    out.push(`</g>`);
  });
  out.push(`</svg>`);
  return out.join('\n');
}
