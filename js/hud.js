// HUD view model (shared by the driver pane, mini HUD, burn-in overlay,
// the driver-only window and playback) + timeline rendering.

import {
  MATCH_LEN,
  activeWindows,
  fmtClock,
  hubActive,
  hubOutlook,
  matchState,
  other,
  timeline,
} from './game.js';

export function hudModel(t, clock, settings) {
  const state = clock.ended && clock.autoStart != null ? { phase: 'post', period: null, clock: 0, nominal: MATCH_LEN } : matchState(t, clock);
  const us = clock.alliance;
  const them = other(us);
  const inactiveFirst = clock.inactiveFirst;
  const hub = hubOutlook(state, us, inactiveFirst);
  const oppActive = state.period ? hubActive(state.period, them, inactiveFirst) : state.phase === 'pause' ? true : null;
  const both = hub.active === true && oppActive === true;
  const lead = Math.max(3, settings.lead || 5);

  const m = {
    phase: state.phase,
    state,
    us,
    them,
    inactiveFirst,
    nominal: state.nominal,
    clockSec: state.clock,
    clockText: fmtClock(state.clock),
    periodName: 'READY',
    periodLeft: '',
    hubClass: 'idle',
    hubState: 'READY',
    hubNext: '',
    hubBar: 0,
    warn: false,
    oppText: '',
    tip: '',
    ask: false,
    miniHub: 'HUB',
    miniOn: false,
  };

  switch (state.phase) {
    case 'ready':
      m.hubState = 'READY';
      m.hubNext = 'Tap START at the AUTO buzzer';
      m.tip = `${us.toUpperCase()} alliance`;
      break;
    case 'auto':
      m.periodName = 'AUTO';
      m.periodLeft = fmtClock(state.periodLeft);
      m.hubClass = 'active both';
      m.hubState = 'LIVE';
      m.hubNext = inactiveFirst
        ? hub.next
          ? `${hub.next.active ? 'LIVE' : 'OFF'} in <b>${fmtClock(hub.next.inSec)}</b>`
          : 'Live to the end'
        : 'AUTO winner: OFF first';
      m.hubBar = 1 - state.periodLeft / state.periodLen;
      m.tip = 'Score FUEL · L1 climb = 15';
      m.ask = !inactiveFirst && state.periodLeft < 5;
      break;
    case 'pause':
      m.periodName = 'TELEOP IN';
      m.periodLeft = `${Math.ceil(state.teleopIn)}s`;
      m.clockText = '2:20';
      m.hubClass = 'active both';
      m.hubState = 'LIVE';
      m.hubNext = inactiveFirst && hub.next ? `${hub.next.active ? 'LIVE' : 'OFF'} in <b>${fmtClock(hub.next.inSec)}</b>` : 'Both hubs live in TRANSITION';
      m.tip = 'Check DS game data: R / B';
      m.ask = !inactiveFirst;
      break;
    case 'teleop': {
      m.periodName = state.period.name;
      m.periodLeft = fmtClock(state.periodLeft);
      m.ask = !inactiveFirst && !!(state.period.shift || state.period.id === 'transition');
      if (hub.active === null) {
        m.hubClass = 'unknown';
        m.hubState = '? SET AUTO WINNER';
        m.hubNext = 'Tap who scored more FUEL in AUTO';
        m.hubBar = 0;
        m.tip = 'Hub status unknown';
      } else {
        m.hubClass = hub.active ? (both ? 'active both' : 'active') : 'inactive';
        m.hubState = hub.active ? 'LIVE' : 'OFF';
        if (hub.next) {
          const inS = hub.next.inSec;
          m.hubNext = `${hub.next.active ? 'LIVE' : 'OFF'} in <b>${fmtClock(inS)}</b>`;
          m.warn = inS <= lead;
          // progress through the current hub window
          const startNom = windowStart(state.nominal, us, inactiveFirst);
          const total = state.nominal - startNom + inS;
          m.hubBar = total > 0 ? (state.nominal - startNom) / total : 0;
        } else {
          m.hubNext = 'Live to the end of the match';
          m.hubBar = (state.nominal - windowStart(state.nominal, us, inactiveFirst)) / Math.max(1, MATCH_LEN - windowStart(state.nominal, us, inactiveFirst));
        }
        if (state.period.id === 'endgame') {
          const c = settings.climbAt;
          m.tip = c > 0 && state.clock > c ? `Climb at 0:${String(c).padStart(2, '0')}` : 'CLIMB · L1 10 · L2 20 · L3 30';
        } else if (hub.active) {
          m.tip = m.warn ? 'Last shots!' : 'Shoot FUEL';
        } else {
          m.tip = m.warn ? 'Get in position!' : 'Collect FUEL · defend · stage';
        }
      }
      m.oppText = oppActive == null ? '' : `THEM <b>${oppActive ? 'LIVE' : 'OFF'}</b>`;
      break;
    }
    case 'post':
      m.periodName = 'MATCH OVER';
      m.clockText = '0:00';
      m.hubClass = 'over';
      m.hubState = 'DONE';
      m.hubNext = 'Save result in Match complete';
      m.tip = '';
      break;
  }
  if (m.phase === 'auto' || m.phase === 'pause') m.oppText = 'THEM <b>LIVE</b>';
  m.miniHub = m.hubClass === 'unknown' ? 'HUB ?' : m.hubClass === 'inactive' ? 'HUB OFF' : m.phase === 'ready' || m.phase === 'post' ? 'HUB' : 'HUB LIVE';
  m.miniOn = m.hubClass.startsWith('active');
  m.windows = activeWindows(us, inactiveFirst);
  return m;
}

/** Nominal second at which our current hub status began. */
function windowStart(nominal, us, inactiveFirst) {
  const segs = timeline(us, inactiveFirst);
  let i = segs.findIndex((s) => nominal < s.end);
  if (i < 0) return MATCH_LEN;
  const a = segs[i].active;
  while (i > 0 && segs[i - 1].active === a && segs[i - 1].id !== 'auto') i--;
  return segs[i].start;
}

export function renderTimeline(el, us, inactiveFirst, nominal, { head = true, total = MATCH_LEN } = {}) {
  const segs = timeline(us, inactiveFirst);
  const key = `${us}|${inactiveFirst}`;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML =
      segs
        .map((s) => {
          const cls = s.id === 'auto' ? 'on auto' : s.active === null ? 'unk' : s.active ? 'on' : 'off';
          return `<div class="tl-seg ${cls}" data-id="${s.id}" style="flex:${s.end - s.start}">${s.short}</div>`;
        })
        .join('') + (head ? '<div class="tl-head"></div>' : '');
  }
  if (head) {
    const h = el.querySelector('.tl-head');
    if (h) {
      h.hidden = nominal == null;
      h.style.left = `${Math.max(0, Math.min(1, (nominal ?? 0) / total)) * 100}%`;
    }
  }
  for (const node of el.querySelectorAll('.tl-seg')) {
    const s = segs.find((x) => x.id === node.dataset.id);
    node.classList.toggle('past', nominal != null && nominal >= s.end);
  }
}

export function windowsText(m) {
  if (!m.inactiveFirst) return '';
  return 'LIVE ' + m.windows.map((w) => `<b>${fmtClock(w.from)}–${fmtClock(w.to)}</b>`).join(' · ');
}

const COLORS = { red: '#ff3346', blue: '#2b7fff' };

/** Burn-in overlay drawn on top of each recorded frame. */
export function drawOverlay(ctx, w, h, m, label) {
  const s = h / 1080;
  const pad = 24 * s;
  const bh = 92 * s;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  roundRect(ctx, pad, pad, w - pad * 2, bh, 18 * s);
  ctx.fill();
  ctx.textBaseline = 'middle';
  const y = pad + bh / 2;
  let x = pad + 22 * s;
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${56 * s}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(m.clockText, x, y);
  x += ctx.measureText('0:00 ').width + 10 * s;
  ctx.font = `800 ${34 * s}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(m.periodName, x, y);
  x += ctx.measureText(m.periodName).width + 28 * s;
  // hub pill
  const pill = m.hubClass === 'inactive' ? 'OUR HUB OFF' : m.hubClass === 'unknown' ? 'HUB ?' : m.miniOn ? 'OUR HUB LIVE' : '';
  if (pill) {
    ctx.font = `900 ${32 * s}px -apple-system, system-ui, sans-serif`;
    const pw = ctx.measureText(pill).width + 36 * s;
    ctx.fillStyle = m.hubClass === 'inactive' ? '#3a404c' : m.hubClass === 'unknown' ? '#ffb000' : COLORS[m.us];
    roundRect(ctx, x, pad + 16 * s, pw, bh - 32 * s, 12 * s);
    ctx.fill();
    ctx.fillStyle = m.hubClass === 'unknown' ? '#000' : '#fff';
    ctx.fillText(pill, x + 18 * s, y);
    x += pw + 22 * s;
  }
  const next = (m.hubNext || '').replace(/<[^>]+>/g, '');
  if (next && m.phase === 'teleop') {
    ctx.font = `700 ${30 * s}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = m.warn ? '#ffb000' : '#dfe5ee';
    ctx.fillText(next, x, y);
  }
  // right side label
  ctx.font = `700 ${28 * s}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'right';
  ctx.fillStyle = '#c9d1dd';
  ctx.fillText(label, w - pad - 22 * s, y);
  // shift progress strip
  const segs = timeline(m.us, m.inactiveFirst);
  const sx = pad;
  const sw = w - pad * 2;
  const sy = pad + bh + 10 * s;
  const sh = 12 * s;
  for (const sg of segs) {
    const x0 = sx + (sg.start / MATCH_LEN) * sw;
    const x1 = sx + (sg.end / MATCH_LEN) * sw;
    ctx.fillStyle = sg.id === 'auto' || sg.active ? COLORS[m.us] : sg.active === null ? '#6b5a12' : '#3a404c';
    ctx.globalAlpha = m.nominal >= sg.end ? 0.35 : 0.9;
    ctx.fillRect(x0 + 1, sy, x1 - x0 - 2, sh);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(sx + Math.min(1, (m.nominal || 0) / MATCH_LEN) * sw - 3 * s, sy - 4 * s, 6 * s, sh + 8 * s);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
