// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { PERIODS, activeWindows, fmtClock, hubActive, hubOutlook, matchState, periodAt, scoreSummary } from '../js/game.js';

const T0 = 1_000_000;
const clock = (extra = {}) => ({ autoStart: T0, teleopStart: null, pause: 3, ...extra });
const at = (sec) => T0 + sec * 1000;
const P = Object.fromEntries(PERIODS.map((p) => [p.id, p]));

test('periods follow the 10/25/25/25/25/30 TELEOP split', () => {
  const teleopRemaining = (id) => [160 - P[id].start, 160 - P[id].end];
  assert.deepEqual(teleopRemaining('transition'), [140, 130]);
  assert.deepEqual(teleopRemaining('s1'), [130, 105]);
  assert.deepEqual(teleopRemaining('s2'), [105, 80]);
  assert.deepEqual(teleopRemaining('s3'), [80, 55]);
  assert.deepEqual(teleopRemaining('s4'), [55, 30]);
  assert.deepEqual(teleopRemaining('endgame'), [30, 0]);
  assert.equal(periodAt(160), null);
});

test('AUTO winner hub is inactive in SHIFT 1 and 3', () => {
  for (const id of ['auto', 'transition', 'endgame']) {
    assert.equal(hubActive(P[id], 'red', 'red'), true);
    assert.equal(hubActive(P[id], 'blue', 'red'), true);
  }
  assert.equal(hubActive(P.s1, 'red', 'red'), false);
  assert.equal(hubActive(P.s1, 'blue', 'red'), true);
  assert.equal(hubActive(P.s2, 'red', 'red'), true);
  assert.equal(hubActive(P.s2, 'blue', 'red'), false);
  assert.equal(hubActive(P.s3, 'red', 'red'), false);
  assert.equal(hubActive(P.s4, 'red', 'red'), true);
  assert.equal(hubActive(P.s1, 'red', null), null);
});

test('matchState walks AUTO -> pause -> TELEOP -> post', () => {
  assert.equal(matchState(at(0), { autoStart: null }).phase, 'ready');
  const a = matchState(at(5), clock());
  assert.equal(a.phase, 'auto');
  assert.equal(Math.round(a.clock), 15);
  const p = matchState(at(21), clock());
  assert.equal(p.phase, 'pause');
  assert.equal(Math.round(p.teleopIn), 2);
  const t = matchState(at(23 + 10), clock()); // 10 s into TELEOP
  assert.equal(t.phase, 'teleop');
  assert.equal(t.period.id, 's1');
  assert.equal(Math.round(t.clock), 130);
  // synced TELEOP overrides the projected pause
  const s = matchState(at(30), clock({ teleopStart: at(25) }));
  assert.equal(s.period.id, 'transition');
  assert.equal(Math.round(s.clock), 135);
  assert.equal(matchState(at(23 + 140), clock()).phase, 'post');
});

test('hub outlook counts down to the next change', () => {
  // We won AUTO (red), 5 s into TELEOP: live now, OFF in 5 s (SHIFT 1)
  const st = matchState(at(23 + 5), clock());
  const o = hubOutlook(st, 'red', 'red');
  assert.equal(o.active, true);
  assert.equal(o.next.active, false);
  assert.equal(Math.round(o.next.inSec), 5);
  // They won AUTO: live through TRANSITION + SHIFT 1, OFF at SHIFT 2 (30 s from now)
  const o2 = hubOutlook(st, 'red', 'blue');
  assert.equal(o2.next.period.id, 's2');
  assert.equal(Math.round(o2.next.inSec), 30);
  // During the pause the countdown includes the time until TELEOP starts
  const ps = matchState(at(21), clock());
  const o3 = hubOutlook(ps, 'red', 'red');
  assert.equal(Math.round(o3.next.inSec), 12);
  // During AUTO with a known winner the pause is included too
  const au = matchState(at(10), clock());
  assert.equal(Math.round(hubOutlook(au, 'red', 'red').next.inSec), 23);
  // We won AUTO, SHIFT 4: live to the end
  const s4 = matchState(at(23 + 90), clock());
  const o4 = hubOutlook(s4, 'red', 'red');
  assert.equal(o4.active, true);
  assert.equal(o4.final, true);
  // unknown winner
  assert.equal(hubOutlook(s4, 'red', null).active, null);
});

test('active windows in FRC clock time', () => {
  assert.deepEqual(
    activeWindows('red', 'red').map((w) => [fmtClock(w.from), fmtClock(w.to)]),
    [['2:20', '2:10'], ['1:45', '1:20'], ['0:55', '0:00']],
  );
  assert.deepEqual(
    activeWindows('red', 'blue').map((w) => [fmtClock(w.from), fmtClock(w.to)]),
    [['2:20', '1:45'], ['1:20', '0:55'], ['0:30', '0:00']],
  );
  for (const w of [...activeWindows('red', 'red'), ...activeWindows('blue', 'red')]) assert.ok(w.len > 0);
  const total = (a, f) => activeWindows(a, f).reduce((s, w) => s + w.len, 0);
  assert.equal(total('red', 'red'), 90);
  assert.equal(total('red', 'blue'), 90);
});

test('score summary ignores FUEL scored into an OFF hub', () => {
  const scout = {
    fuel: [
      { nominal: 10, n: 8 }, // AUTO
      { nominal: 40, n: 5 }, // S1 (red off when red won AUTO)
      { nominal: 60, n: 12 }, // S2 live
      { nominal: 150, n: 90 }, // END GAME
    ],
    autoTower: 1,
    climbs: [3, 2, 0],
  };
  const s = scoreSummary(scout, 'red', 'red', 'regional');
  assert.equal(s.fuelActive, 110);
  assert.equal(s.fuelInactive, 5);
  assert.equal(s.towerPts, 15 + 30 + 20);
  assert.equal(s.total, 110 + 65);
  assert.equal(s.rp.energized.ok, true);
  assert.equal(s.rp.supercharged.ok, false);
  assert.equal(s.rp.traversal.ok, true);
  assert.equal(scoreSummary(scout, 'red', 'red', 'dcmp').rp.energized.ok, false);
  assert.equal(scoreSummary(scout, 'red', null).fuelUnknown, 5 + 12);
});

test('clock formatting', () => {
  assert.equal(fmtClock(140), '2:20');
  assert.equal(fmtClock(129.2), '2:10');
  assert.equal(fmtClock(0.2), '0:01');
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(-3), '0:00');
});
