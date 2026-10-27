// Match clock: start / TELEOP sync / nudges / AUTO winner, persisted and shared
// with other windows (driver HUD window) through BroadcastChannel.

import { TELEOP_LEN, projectedTeleopStart } from './game.js';
import { lsGet, lsSet } from './store.js';

const KEY = 'matchcam.clock.v1';
const params = new URLSearchParams(location.search);
// ?speed=N runs the clock N times faster (testing / demo only).
const SPEED = Math.max(0.1, Math.min(50, Number(params.get('speed')) || 1));
const T0 = Date.now();
export const now = SPEED === 1 ? () => Date.now() : () => T0 + (Date.now() - T0) * SPEED;
export const speed = SPEED;

const blank = () => ({
  autoStart: null,
  teleopStart: null,
  pause: 3,
  inactiveFirst: null, // 'red' | 'blue'
  alliance: 'red',
  matchId: null,
  ended: false,
  rev: 0,
});

export class MatchClock extends EventTarget {
  constructor() {
    super();
    const saved = SPEED === 1 ? lsGet(KEY) : null;
    this.s = { ...blank(), ...(saved || {}) };
    // Drop a stale match (left over from yesterday, etc.).
    if (this.s.autoStart && now() - projectedTeleopStart(this.s) > (TELEOP_LEN + 600) * 1000) {
      const { alliance, pause } = this.s;
      this.s = { ...blank(), alliance, pause };
    }
    this.chan = 'BroadcastChannel' in window ? new BroadcastChannel('matchcam') : null;
    this.chan?.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m?.type === 'clock' && m.state.rev > this.s.rev) {
        this.s = m.state;
        this.emit(false);
      } else if (m?.type === 'hello') {
        this.chan.postMessage({ type: 'clock', state: this.s });
      }
    });
    this.chan?.postMessage({ type: 'hello' });
  }

  get state() {
    return this.s;
  }

  get running() {
    return this.s.autoStart != null && !this.s.ended;
  }

  update(patch) {
    this.s = { ...this.s, ...patch, rev: this.s.rev + 1 };
    this.emit(true);
  }

  emit(broadcast) {
    if (SPEED === 1) lsSet(KEY, this.s);
    if (broadcast) this.chan?.postMessage({ type: 'clock', state: this.s });
    this.dispatchEvent(new Event('change'));
  }

  start(matchId, pause) {
    this.update({ autoStart: now(), teleopStart: null, inactiveFirst: null, ended: false, matchId, pause });
  }

  /** Field said go: TELEOP starts now (also used to re-sync early TELEOP). */
  teleopGo() {
    if (this.s.autoStart == null) return;
    this.update({ teleopStart: now() });
  }

  /** Displayed time is off: +1 = clock shows one more second (field is behind us). */
  nudge(sec) {
    if (this.s.autoStart == null) return;
    const d = sec * 1000;
    const ts = this.s.teleopStart;
    // Before TELEOP is synced the whole match moves; after, only TELEOP does.
    this.update(ts == null ? { autoStart: this.s.autoStart + d } : { teleopStart: ts + d });
  }

  setAutoWinner(alliance) {
    this.update({ inactiveFirst: alliance });
  }

  setAlliance(alliance) {
    this.update({ alliance });
  }

  end() {
    this.update({ ended: true });
  }

  reset() {
    const { alliance, pause } = this.s;
    const { rev, ...fresh } = blank();
    this.update({ ...fresh, alliance, pause });
  }
}
