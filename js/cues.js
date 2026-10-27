// Audio beeps, spoken callouts and the cue schedule for a match.

import { AUTO_LEN, MATCH_LEN, PERIODS, epochAt, hubActive, projectedTeleopStart, TELEOP_LEN } from './game.js';

let ctx = null;

/** Must run inside a user gesture on iOS. */
export function unlockAudio(withMic) {
  try {
    // iOS 17+: let cues play even with the ring/silent switch on.
    if (navigator.audioSession) navigator.audioSession.type = withMic ? 'play-and-record' : 'playback';
  } catch {
    /* ignore */
  }
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    // A silent blip fully unlocks WebAudio on iOS.
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.01);
  } catch {
    ctx = null;
  }
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch {
    /* ignore */
  }
}

export function beep(freq = 880, dur = 0.12, vol = 0.5, type = 'square') {
  if (!ctx) return;
  try {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {
    /* ignore */
  }
}

const TONES = {
  tick: () => beep(1000, 0.09, 0.45),
  tickHi: () => beep(1400, 0.09, 0.5),
  go: () => {
    beep(1320, 0.35, 0.6, 'sawtooth');
  },
  off: () => {
    beep(440, 0.3, 0.6, 'sawtooth');
    setTimeout(() => beep(330, 0.35, 0.6, 'sawtooth'), 160);
  },
  start: () => {
    beep(660, 0.12, 0.5);
    setTimeout(() => beep(990, 0.25, 0.5), 140);
  },
  end: () => beep(520, 0.9, 0.6, 'sawtooth'),
};

let voiceOn = true;
let soundOn = true;

export function configure({ sounds, voice }) {
  soundOn = !!sounds;
  voiceOn = !!voice;
}

export function tone(name) {
  if (soundOn) TONES[name]?.();
}

export function say(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.15;
    u.pitch = 1;
    u.volume = 1;
    speechSynthesis.speak(u);
  } catch {
    /* ignore */
  }
}

const spokenPeriod = {
  transition: 'Teleop. Both hubs live.',
  endgame: 'End game. All hubs live.',
};

/**
 * Build the list of cues for this match.
 * Each cue: { id, at (epoch ms), tone?, say?, flash? }
 */
export function buildCues(clock, settings) {
  if (clock.autoStart == null) return [];
  const cues = [];
  const us = clock.alliance;
  const add = (id, nominal, extra) => cues.push({ id, at: epochAt(nominal, clock), ...extra });

  add('auto-end', AUTO_LEN, { tone: 'end', say: 'Auto over.' });

  const teleop = projectedTeleopStart(clock);
  if (clock.inactiveFirst == null) {
    cues.push({ id: 'ask-1', at: teleop + 1500, say: 'Who won auto?', ask: true });
    cues.push({ id: 'ask-2', at: teleop + 7000, say: 'Set auto winner.', ask: true });
  }

  let prev = true; // AUTO + TRANSITION are always active
  for (const p of PERIODS.slice(1)) {
    const a = hubActive(p, us, clock.inactiveFirst);
    if (p.id === 'transition') {
      add('p-transition', p.start, { tone: 'start', say: spokenPeriod.transition });
      continue;
    }
    if (a === null) continue;
    const changes = a !== prev;
    const word = a ? 'live' : 'off';
    let text;
    if (p.id === 'endgame') text = changes ? 'End game. Our hub live. Shoot!' : spokenPeriod.endgame;
    else text = `${p.name.replace('SHIFT', 'Shift')}. Hub ${word}.${a ? ' Shoot!' : ''}`;
    add(`p-${p.id}`, p.start, { tone: changes ? (a ? 'go' : 'off') : 'tickHi', say: text, flash: changes ? (a ? 'go' : 'off') : null });
    if (changes) {
      if (settings.lead > 3) add(`lead-${p.id}`, p.start - settings.lead, { say: `${a ? 'Live' : 'Off'} in ${settings.lead}` });
      for (const k of [3, 2, 1]) add(`cd-${p.id}-${k}`, p.start - k, { tone: 'tick' });
    }
    prev = a;
  }

  if (settings.climbAt > 0 && settings.climbAt < 30) {
    cues.push({ id: 'climb', at: teleop + (TELEOP_LEN - settings.climbAt) * 1000, tone: 'tickHi', say: 'Climb now!', flash: 'climb' });
  }
  cues.push({ id: 'ten', at: teleop + (TELEOP_LEN - 10) * 1000, say: 'Ten seconds.' });
  for (const k of [3, 2, 1]) add(`cd-end-${k}`, MATCH_LEN - k, { tone: 'tick' });
  add('match-end', MATCH_LEN, { tone: 'end', say: 'Match over.' });
  return cues.sort((a, b) => a.at - b.at);
}

/** Fires cues once, ignoring cues that are more than `stale` ms in the past. */
export class CueRunner {
  constructor(onCue) {
    this.onCue = onCue;
    this.fired = new Set();
    this.cues = [];
  }
  setCues(cues) {
    this.cues = cues;
  }
  reset() {
    this.fired.clear();
    this.cues = [];
  }
  tick(t, stale = 1200) {
    for (const c of this.cues) {
      if (c.at > t) break;
      if (this.fired.has(c.id)) continue;
      this.fired.add(c.id);
      if (t - c.at > stale) continue;
      if (c.tone) tone(c.tone);
      if (c.say) say(c.say);
      this.onCue?.(c);
    }
  }
}
