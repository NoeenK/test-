// Post-match / playback analysis blocks.

import { PERIODS } from './game.js';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function scoreLine(sum) {
  const rp = sum.rp;
  const chip = (k, label) => `<span class="rp${rp[k].ok ? ' ok' : ''}">${label} ${rp[k].have}/${rp[k].need}</span>`;
  return `<span>FUEL <b>${sum.fuelActive}</b>${sum.fuelInactive ? ` (+${sum.fuelInactive} off)` : ''}</span><span>EST <b>${sum.total}</b></span>${chip('energized', 'EN')}${chip('supercharged', 'SC')}${chip('traversal', 'TR')}`;
}

export function summaryHtml(sum, match) {
  const max = Math.max(1, ...PERIODS.map((p) => total(sum.byPeriod[p.id])));
  const bars = PERIODS.map((p) => {
    const b = sum.byPeriod[p.id];
    const tot = total(b);
    return `<div class="bar"><div class="col" style="height:${(tot / max) * 100}%"><i class="fa" style="flex:${b.active}"></i><i class="fx" style="flex:${b.inactive}"></i><i class="fu" style="flex:${b.unknown}"></i></div><span>${p.short}<br>${tot}</span></div>`;
  }).join('');
  const rp = sum.rp;
  const rpc = (k, name) => `<div class="stat"><b>${rp[k].ok ? '✓' : `${rp[k].have}/${rp[k].need}`}</b><span>${name} RP</span></div>`;
  const tags = match?.scout?.tags?.length || 0;
  const offPct = sum.fuelActive + sum.fuelInactive ? Math.round((sum.fuelInactive / (sum.fuelActive + sum.fuelInactive)) * 100) : 0;
  return `<div class="sum-grid">
      <div class="stat"><b>${sum.total}</b><span>Est. alliance pts</span></div>
      <div class="stat"><b>${sum.fuelActive}</b><span>FUEL in live hub</span></div>
      <div class="stat"><b>${sum.fuelInactive}${offPct ? ` <small>(${offPct}%)</small>` : ''}</b><span>FUEL while OFF (0 pts)</span></div>
      <div class="stat"><b>${sum.towerPts}</b><span>Tower pts</span></div>
      ${rpc('energized', 'Energized')}${rpc('supercharged', 'Supercharged')}${rpc('traversal', 'Traversal')}
      <div class="stat"><b>${tags}</b><span>Tagged moments</span></div>
    </div>
    <div class="lbl">FUEL BY PERIOD</div>
    <div class="bars">${bars}</div>
    <div class="legend"><span><i style="background:var(--us)"></i>Live hub</span><span><i style="background:var(--warn)"></i>Scored while OFF</span><span><i style="background:#556"></i>AUTO winner not set</span></div>`;
}

const total = (b) => b.active + b.inactive + b.unknown;
