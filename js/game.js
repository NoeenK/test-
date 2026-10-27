// REBUILT (FRC 2026) rules: match timeline, HUB shift logic, scoring.
// Source: 2026 Game Manual section 6 + WPILib "2026 Game Data Details".
//
// AUTO is 0:20. TELEOP is 2:20, split by time remaining into:
//   TRANSITION 2:20-2:10 (both HUBs active)
//   SHIFT 1-4  25 s each (one HUB active, alternating)
//   END GAME   0:30-0:00 (both HUBs active)
// The alliance that scores more FUEL in AUTO (or the FMS pick on a tie) has its
// HUB INACTIVE in SHIFT 1 and 3, ACTIVE in SHIFT 2 and 4. The DS receives this
// as game data ('R' / 'B') at the start of TELEOP.

export const AUTO_LEN = 20;
export const TELEOP_LEN = 140;
export const MATCH_LEN = AUTO_LEN + TELEOP_LEN; // nominal, without the AUTO->TELEOP pause
export const HUB_WARNING = 3; // HUB lights pulse for 3 s before deactivating

export const PERIODS = [
  { id: 'auto', name: 'AUTO', short: 'AUTO', start: 0, end: 20 },
  { id: 'transition', name: 'TRANSITION', short: 'T', start: 20, end: 30 },
  { id: 's1', name: 'SHIFT 1', short: 'S1', start: 30, end: 55, shift: 1 },
  { id: 's2', name: 'SHIFT 2', short: 'S2', start: 55, end: 80, shift: 2 },
  { id: 's3', name: 'SHIFT 3', short: 'S3', start: 80, end: 105, shift: 3 },
  { id: 's4', name: 'SHIFT 4', short: 'S4', start: 105, end: 130, shift: 4 },
  { id: 'endgame', name: 'END GAME', short: 'EG', start: 130, end: 160 },
];
// start/end are "nominal match seconds": 0-20 AUTO, 20-160 TELEOP.

export const PERIOD_BY_ID = Object.fromEntries(PERIODS.map((p) => [p.id, p]));

export const POINTS = {
  fuel: 1,
  autoTowerL1: 15, // max 2 robots per alliance
  tower: { 0: 0, 1: 10, 2: 20, 3: 30 },
};

// Team Update 22, Table 6-5. FUEL thresholds count FUEL scored in an active HUB.
export const RP_THRESHOLDS = {
  regional: { label: 'Regional / District', energized: 100, supercharged: 360, traversal: 50 },
  dcmp: { label: 'District Championship', energized: 240, supercharged: 360, traversal: 50 },
  cmp: { label: 'FIRST Championship', energized: 360, supercharged: 500, traversal: 50 },
};

export const other = (alliance) => (alliance === 'red' ? 'blue' : 'red');

export function periodAt(nominal) {
  if (nominal < 0) return null;
  for (const p of PERIODS) if (nominal < p.end) return p;
  return null;
}

/** true / false, or null when the AUTO winner is not known yet. */
export function hubActive(period, alliance, inactiveFirst) {
  if (!period) return null;
  if (!period.shift) return true;
  if (!inactiveFirst) return null;
  const startsInactive = alliance === inactiveFirst;
  return period.shift % 2 === 1 ? !startsInactive : startsInactive;
}

/**
 * Where the match is at epoch time `now`.
 * clock: { autoStart, teleopStart, pause } (epoch ms; teleopStart may be null
 * until synced, then it is projected as autoStart + AUTO + pause).
 */
export function matchState(now, clock) {
  if (!clock || clock.autoStart == null) {
    return { phase: 'ready', period: null, clock: AUTO_LEN, nominal: 0 };
  }
  const teleopStart = projectedTeleopStart(clock);
  const e = (now - clock.autoStart) / 1000;
  if (e < 0) return { phase: 'ready', period: null, clock: AUTO_LEN, nominal: 0 };
  if (e < AUTO_LEN && now < teleopStart) {
    const p = PERIODS[0];
    const pause = Math.max(0, (teleopStart - clock.autoStart) / 1000 - AUTO_LEN);
    return { phase: 'auto', period: p, clock: AUTO_LEN - e, nominal: e, periodLeft: AUTO_LEN - e, periodLen: AUTO_LEN, pause };
  }
  if (now < teleopStart) {
    return { phase: 'pause', period: null, clock: 0, nominal: AUTO_LEN, teleopIn: (teleopStart - now) / 1000 };
  }
  const t = (now - teleopStart) / 1000;
  if (t >= TELEOP_LEN) return { phase: 'post', period: null, clock: 0, nominal: MATCH_LEN, overBy: t - TELEOP_LEN };
  const nominal = AUTO_LEN + t;
  const p = periodAt(nominal);
  return {
    phase: 'teleop',
    period: p,
    clock: TELEOP_LEN - t,
    nominal,
    periodLeft: p.end - nominal,
    periodLen: p.end - p.start,
  };
}

export function projectedTeleopStart(clock) {
  if (clock.teleopStart != null) return clock.teleopStart;
  return clock.autoStart + (AUTO_LEN + (clock.pause ?? 3)) * 1000;
}

/** Epoch ms at which a nominal match second happens. */
export function epochAt(nominal, clock) {
  if (nominal <= AUTO_LEN) return clock.autoStart + nominal * 1000;
  return projectedTeleopStart(clock) + (nominal - AUTO_LEN) * 1000;
}

/**
 * Our HUB right now plus the next change.
 * Returns { active, next: { active, inSec, period } | null, final }
 *   final = true when the status won't change again this match.
 */
export function hubOutlook(state, alliance, inactiveFirst) {
  if (state.phase === 'ready') {
    return { active: true, next: null, final: false, pending: true };
  }
  if (state.phase === 'post') return { active: null, next: null, final: true };
  const nominal = state.nominal;
  const cur = state.phase === 'pause' ? PERIODS[1] : state.period;
  const active = state.phase === 'pause' ? true : hubActive(cur, alliance, inactiveFirst);
  if (active === null) return { active: null, next: null, final: false, unknown: true };
  // Walk the remaining periods looking for a status change.
  const idx = PERIODS.indexOf(cur);
  for (let i = idx + 1; i < PERIODS.length; i++) {
    const a = hubActive(PERIODS[i], alliance, inactiveFirst);
    if (a === null) return { active, next: null, final: false, unknown: true };
    if (a !== active) {
      let inSec = PERIODS[i].start - nominal;
      if (state.phase === 'pause') inSec += state.teleopIn;
      if (state.phase === 'auto') inSec += state.pause;
      return { active, next: { active: a, inSec, period: PERIODS[i] }, final: false };
    }
  }
  return { active, next: null, final: true };
}

/** Timeline segments for our alliance (nominal seconds), merged where status repeats. */
export function timeline(alliance, inactiveFirst) {
  return PERIODS.map((p) => ({
    id: p.id,
    short: p.short,
    start: p.start,
    end: p.end,
    active: hubActive(p, alliance, inactiveFirst),
    shift: p.shift || 0,
  }));
}

/** Our active windows in FRC display time (time remaining), e.g. "2:20-1:45". */
export function activeWindows(alliance, inactiveFirst) {
  if (!inactiveFirst) return [];
  const segs = timeline(alliance, inactiveFirst).filter((s) => s.id !== 'auto');
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.active === s.active) {
      last.end = s.end;
      last.ids.push(s.short);
    } else out.push({ active: s.active, start: s.start, end: s.end, ids: [s.short] });
  }
  return out
    .filter((w) => w.active)
    .map((w) => ({
      from: MATCH_LEN - w.start, // teleop seconds remaining
      to: MATCH_LEN - w.end,
      len: w.end - w.start,
      label: w.ids.join('+'),
    }));
}

export function fmtClock(sec, { tenths = false } = {}) {
  if (sec == null || Number.isNaN(sec)) return '-:--';
  const s = Math.max(0, sec);
  if (tenths && s < 10) return s.toFixed(1);
  const whole = Math.ceil(s - 1e-9);
  const m = Math.floor(whole / 60);
  const r = whole % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Score estimate from scouting taps.
 * scout: { fuel: [{nominal, n}], autoTower: 0..2, climbs: [0..3, 0..3, 0..3] }
 */
export function scoreSummary(scout, alliance, inactiveFirst, level = 'regional') {
  const th = RP_THRESHOLDS[level] || RP_THRESHOLDS.regional;
  const byPeriod = Object.fromEntries(PERIODS.map((p) => [p.id, { active: 0, inactive: 0, unknown: 0 }]));
  let fuelActive = 0;
  let fuelInactive = 0;
  let fuelUnknown = 0;
  for (const f of scout?.fuel || []) {
    const p = periodAt(Math.min(f.nominal, MATCH_LEN - 0.001));
    if (!p) continue;
    const a = hubActive(p, alliance, inactiveFirst);
    const key = a === null ? 'unknown' : a ? 'active' : 'inactive';
    byPeriod[p.id][key] += f.n;
    if (a === null) fuelUnknown += f.n;
    else if (a) fuelActive += f.n;
    else fuelInactive += f.n;
  }
  const autoTower = Math.min(2, scout?.autoTower || 0) * POINTS.autoTowerL1;
  const teleTower = (scout?.climbs || []).reduce((s, l) => s + (POINTS.tower[l] || 0), 0);
  const towerPts = autoTower + teleTower;
  const fuelPts = fuelActive * POINTS.fuel;
  return {
    fuelActive,
    fuelInactive,
    fuelUnknown,
    byPeriod,
    autoFuel: byPeriod.auto.active,
    towerPts,
    autoTower,
    teleTower,
    total: fuelPts + towerPts,
    rp: {
      energized: { have: fuelActive, need: th.energized, ok: fuelActive >= th.energized },
      supercharged: { have: fuelActive, need: th.supercharged, ok: fuelActive >= th.supercharged },
      traversal: { have: towerPts, need: th.traversal, ok: towerPts >= th.traversal },
    },
  };
}

export function rpFromResult(result) {
  return result === 'W' ? 3 : result === 'T' ? 1 : 0;
}
