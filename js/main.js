// REBUILT MatchCam — app controller.

import { PERIODS, RP_THRESHOLDS, fmtClock, other, projectedTeleopStart, scoreSummary } from './game.js';
import { MatchClock, now, speed } from './clock.js';
import { CueRunner, buildCues, configure as configureCues, say, tone, unlockAudio } from './cues.js';
import { Camera, qualityInfo } from './camera.js';
import { Recorder, canRecord, recoverChunks, snapshot } from './recorder.js';
import { db, loadSettings, lsGet, lsSet, requestPersist, saveSettings, storageInfo } from './store.js';
import { drawOverlay, hudModel, renderTimeline, windowsText } from './hud.js';
import { watchFold } from './fold.js';
import { initLibrary, openLibrary, openPlayback, exportAll, matchLabel } from './library.js';
import { escapeHtml, scoreLine, summaryHtml } from './summary.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const params = new URLSearchParams(location.search);
const HUD_ONLY = params.get('view') === 'hud';

// ---------------- state ----------------
let settings = loadSettings();
const clock = new MatchClock();
const camera = new Camera($('#preview'));
const recorder = new Recorder();
const cues = new CueRunner(onCue);
let session = loadSession();
let wakeLock = null;
let postShownFor = null;
let autoStopTimer = null;
let confirmUntil = 0;
let lastModel = null;

function newSession(prev) {
  const s = {
    id: `m-${Date.now().toString(36)}`,
    type: prev?.type || 'Q',
    num: prev ? (Number(prev.num) || 0) + 1 : 1,
    team: settings.team,
    partners: ['', ''],
    opponents: ['', '', ''],
    note: '',
    event: settings.event,
    createdAt: Date.now(),
    videos: [],
    scout: { fuel: [], autoTower: 0, climbs: [0, 0, 0], tags: [] },
    checks: [],
  };
  return s;
}

function loadSession() {
  const s = lsGet('matchcam.session.v1');
  if (s && s.id && s.scout) return s;
  const fresh = newSession(null);
  fresh.type = 'P';
  return fresh;
}

function saveSession() {
  lsSet('matchcam.session.v1', session);
}

// ---------------- boot ----------------
function boot() {
  document.body.classList.toggle('view-hud', HUD_ONLY);
  applySettings();
  watchFold();
  bindUI();
  initLibrary({ getSettings: () => settings, toast, onChange: refreshMenu });
  clock.addEventListener('change', onClockChange);
  onClockChange();
  requestAnimationFrame(loop);
  setInterval(() => cues.tick(now()), 100);
  if (!HUD_ONLY) {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    if (!canRecord()) $('#btnRec').title = 'Recording not supported in this browser';
    recover();
    // Re-open the camera automatically if permission was granted before.
    navigator.permissions
      ?.query({ name: 'camera' })
      .then((p) => p.state === 'granted' && lsGet('matchcam.camOn') && enableCamera())
      .catch(() => {});
  }
  if (speed !== 1) toast(`Demo clock ×${speed}`);
  refreshMenu();
}

function applySettings() {
  configureCues(settings);
  document.body.classList.remove('layout-split', 'layout-hud', 'layout-cam');
  document.body.classList.add(`layout-${HUD_ONLY ? 'split' : settings.layout}`);
  document.body.classList.toggle('swap', !!settings.swap && settings.layout === 'split');
  if (clock.state.pause !== settings.pause && !clock.running) clock.update({ pause: settings.pause });
  rebuildCues();
}

// ---------------- camera ----------------
async function enableCamera(deviceId) {
  $('#camErr').hidden = true;
  try {
    await camera.start({ deviceId: deviceId || lsGet('matchcam.lens'), quality: settings.quality, fps: settings.fps, audio: settings.audio });
    lsSet('matchcam.camOn', true);
    $('#camEmpty').hidden = true;
    updateCamInfo();
    setupZoom();
    $('#btnLens').hidden = camera.lenses.length < 2;
    requestPersist();
    keepAwake();
  } catch (err) {
    const e = $('#camErr');
    e.hidden = false;
    e.textContent =
      err?.name === 'NotAllowedError'
        ? 'Camera permission denied. Settings → Safari → Camera → Allow, then reload.'
        : `Camera error: ${err?.message || err}`;
  }
}

function updateCamInfo() {
  const s = camera.settings;
  const lens = camera.lenses.find((l) => l.id === camera.deviceId);
  $('#camInfo').textContent = s.width ? `${s.width}×${s.height} · ${Math.round(s.fps || settings.fps)}fps${camera.audioTrack ? ' · 🎙' : ''}` : '';
  $('#btnLens').textContent = lens ? lens.label.split(' ')[0] : 'Lens';
}

function setupZoom() {
  const z = camera.zoomRange;
  const wrap = $('#zoomWrap');
  wrap.hidden = !z;
  if (!z) return;
  const input = $('#zoom');
  input.min = z.min;
  input.max = z.max;
  input.step = z.step;
  input.value = z.value;
  $('#zoomVal').textContent = `${Number(z.value).toFixed(1)}×`;
}

async function nextLens() {
  if (recorder.recording) return toast('Stop recording to switch lens');
  const ls = camera.lenses;
  if (ls.length < 2) return;
  const i = ls.findIndex((l) => l.id === camera.deviceId);
  const next = ls[(i + 1) % ls.length];
  lsSet('matchcam.lens', next.id);
  await enableCamera(next.id);
  toast(next.label);
}

// ---------------- recording ----------------
async function startRecording() {
  if (recorder.recording) return;
  if (!canRecord()) return toast('This browser cannot record video');
  if (!camera.live) {
    toast('Enable the camera first');
    return;
  }
  const info = await storageInfo();
  if (info && info.free < 400e6) toast(`Low storage: ${(info.free / 1e6).toFixed(0)} MB free`);
  const recId = `v-${Date.now().toString(36)}`;
  try {
    recorder.start({
      camera,
      recId,
      bitrate: qualityInfo(settings.quality).bitrate * (Number(settings.fps) === 60 ? 1.5 : 1),
      fps: settings.fps,
      burnIn: settings.burnIn,
      drawOverlay: (ctx, w, h) => lastModel && drawOverlay(ctx, w, h, lastModel, overlayLabel()),
    });
  } catch (err) {
    toast(`Could not record: ${err.message || err}`);
    return;
  }
  session.videos.push({ id: recId, recStart: Date.now(), thumb: null, burnIn: !!settings.burnIn });
  saveSession();
  setTimeout(() => {
    const v = session.videos.find((x) => x.id === recId);
    if (v && !v.thumb) {
      v.thumb = snapshot(camera.video);
      saveSession();
    }
  }, 1500);
  keepAwake();
  renderRec();
}

async function stopRecording(reason) {
  if (!recorder.recording) return;
  clearTimeout(autoStopTimer);
  const res = await recorder.stop();
  renderRec();
  if (!res || !res.blob.size) return toast('Recording was empty');
  const meta = session.videos.find((v) => v.id === res.recId) || { id: res.recId, recStart: Date.now() - res.duration * 1000 };
  try {
    await db.putVideo({ id: res.recId, blob: res.blob, mime: res.mime, size: res.blob.size, duration: res.duration, recStart: meta.recStart, thumb: meta.thumb, burnIn: !!meta.burnIn });
    await db.deleteChunks(res.recId).catch(() => {});
    meta.size = res.blob.size;
    meta.duration = res.duration;
    meta.mime = res.mime;
    saveSession();
    await persistMatch();
    toast(`${reason ? reason + ' — ' : ''}Saved ${(res.blob.size / 1e6).toFixed(0)} MB · ${fmtClock(res.duration)}`);
  } catch (err) {
    offerUnsaved(res, err);
  }
  refreshMenu();
}

// Storage full (or IndexedDB broken): hand the video to the share sheet now.
function offerUnsaved(res, err) {
  $('#recoverText').innerHTML = `Could not store the video (${escapeHtml(err?.message || err)}). Save it now or it will be lost. <br><br><button class="btn primary big" id="btnSaveNow">Save to Photos / Files</button>`;
  openSheet('sheetRecover');
  $('#btnSaveNow').addEventListener('click', async () => {
    const type = (res.blob.type || 'video/mp4').split(';')[0];
    const file = new File([res.blob], `${matchLabel(session).replace(/\s+/g, '-')}.${/webm/.test(type) ? 'webm' : 'mp4'}`, { type });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] }).catch(() => {});
    else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
    }
  });
}

recorder.addEventListener('interrupted', () => stopRecording('Camera interrupted'));
recorder.addEventListener('error', () => stopRecording('Recorder error'));

function overlayLabel() {
  return [settings.event, matchLabel(session), settings.team && `#${settings.team}`].filter(Boolean).join(' · ');
}

async function recover() {
  try {
    const vids = await db.allMatches();
    const known = new Set();
    for (const m of vids) for (const v of m.videos || []) known.add(v.id);
    for (const v of session.videos) if (v.size) known.add(v.id);
    const found = await recoverChunks(known);
    for (const r of found) {
      const meta = session.videos.find((v) => v.id === r.recId);
      const recStart = meta?.recStart || (r.lastAt || Date.now()) - r.seconds * 1000;
      if (meta?.recStart && r.lastAt) r.seconds = Math.max(1, (r.lastAt - meta.recStart) / 1000);
      await db.putVideo({ id: r.recId, blob: r.blob, mime: r.blob.type, size: r.blob.size, duration: r.seconds, recStart, thumb: meta?.thumb || null });
      await db.deleteChunks(r.recId);
      if (meta) {
        meta.size = r.blob.size;
        meta.duration = r.seconds;
        saveSession();
        await persistMatch();
      } else {
        await db.putMatch({
          id: `m-rec-${r.recId}`,
          label: 'Recovered recording',
          createdAt: recStart,
          videos: [{ id: r.recId, recStart, size: r.blob.size, duration: r.seconds }],
          scout: { fuel: [], tags: [], climbs: [0, 0, 0], autoTower: 0 },
        });
      }
    }
    if (found.length) {
      $('#recoverText').textContent = `${found.length} interrupted recording${found.length > 1 ? 's were' : ' was'} rebuilt from saved chunks (${found
        .map((r) => fmtClock(r.seconds))
        .join(', ')}).`;
      openSheet('sheetRecover');
    }
  } catch {
    /* nothing to recover */
  }
}

// ---------------- match lifecycle ----------------
function startMatch() {
  unlockAudio(settings.audio && camera.live);
  if (session.ended) session = newSession(session);
  session.startedAt = Date.now();
  saveSession();
  postShownFor = null;
  cues.reset();
  clock.start(session.id, settings.pause);
  tone('start');
  say('Auto.');
  keepAwake();
  if (settings.autoRecord && camera.live && !recorder.recording) startRecording();
}

function endMatch() {
  clock.end();
}

function onClockChange() {
  const s = clock.state;
  document.body.classList.toggle('us-blue', s.alliance === 'blue');
  rebuildCues();
  if (!HUD_ONLY && s.autoStart != null && s.matchId === session.id) {
    session.timing = {
      autoStart: s.autoStart,
      teleopStart: projectedTeleopStart(s),
      synced: s.teleopStart != null,
      pause: s.pause,
      inactiveFirst: s.inactiveFirst,
      alliance: s.alliance,
    };
    session.alliance = s.alliance;
    saveSession();
  }
}

function rebuildCues() {
  cues.setCues(HUD_ONLY ? [] : buildCues(clock.state, settings));
}

function onCue(c) {
  if (c.flash) flash(c.flash);
  if (c.id === 'match-end') onMatchOver();
}

function onMatchOver() {
  if (postShownFor === session.id) return;
  postShownFor = session.id;
  session.ended = true;
  saveSession();
  if (recorder.recording && settings.autoRecord) {
    clearTimeout(autoStopTimer);
    autoStopTimer = setTimeout(async () => {
      await stopRecording('Match over');
      openPost();
    }, Math.max(0, settings.postRoll) * 1000);
    toast(`Recording ${settings.postRoll}s more…`);
  } else {
    persistMatch();
    setTimeout(openPost, 1200);
  }
}

async function persistMatch(extra = {}) {
  const rec = {
    id: session.id,
    type: session.type,
    num: session.num,
    label: matchLabel(session),
    event: settings.event,
    team: session.team || settings.team,
    alliance: clock.state.matchId === session.id ? clock.state.alliance : session.alliance || clock.state.alliance,
    partners: session.partners,
    opponents: session.opponents,
    note: session.note,
    createdAt: session.startedAt || session.createdAt,
    timing: session.timing || null,
    videos: session.videos.filter((v) => v.size),
    scout: session.scout,
    level: settings.level,
    result: session.result || null,
    scores: session.scores || null,
    notes: session.notes || '',
    ...extra,
  };
  if (!rec.timing && !rec.videos.length && !rec.scout.fuel.length && !rec.result) return null;
  await db.putMatch(rec).catch(() => {});
  return rec;
}

function openPost() {
  const sum = currentSummary();
  $('#postSummary').innerHTML = summaryHtml(sum, session);
  const f = $('#postForm');
  f.red.value = session.scores?.red ?? '';
  f.blue.value = session.scores?.blue ?? '';
  f.notes.value = session.notes || '';
  setSeg($('#postResult'), session.result || '');
  openSheet('sheetPost');
}

async function savePost(e) {
  e.preventDefault();
  const f = e.target;
  session.result = $('#postResult .on')?.dataset.v || null;
  session.scores = { red: f.red.value === '' ? null : Number(f.red.value), blue: f.blue.value === '' ? null : Number(f.blue.value) };
  session.notes = f.notes.value.trim();
  if (recorder.recording) await stopRecording();
  await persistMatch();
  nextMatch();
  closeSheets();
  toast('Saved. Ready for the next match.');
}

function nextMatch() {
  const prev = session;
  session = newSession(prev);
  saveSession();
  clock.reset();
  cues.reset();
  postShownFor = null;
  renderSetupHeader();
  renderScout();
  renderChecklist();
  refreshMenu();
}

// ---------------- main loop ----------------
let lastRender = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  if (ts - lastRender < 66) return; // ~15 fps is plenty for text
  lastRender = ts;
  const t = now();
  const m = hudModel(t, clock.state, settings);
  lastModel = m;
  renderHud(m);
  renderControls(m);
  renderRec();
  if (!HUD_ONLY) {
    const live = camera.live;
    document.body.classList.toggle('no-cam', !live);
    if (live && !$('#camEmpty').hidden) $('#camEmpty').hidden = true;
  }
  // match ended while app was in the background / by END button
  if (!HUD_ONLY && m.phase === 'post' && clock.state.matchId === session.id && postShownFor !== session.id) onMatchOver();
}

const txt = (el, v) => {
  if (el.__v !== v) {
    el.__v = v;
    el.textContent = v;
  }
};
const html = (el, v) => {
  if (el.__h !== v) {
    el.__h = v;
    el.innerHTML = v;
  }
};

function renderHud(m) {
  txt($('#hudPeriod'), m.periodName);
  txt($('#hudPeriodLeft'), m.periodLeft);
  txt($('#hudClock'), m.clockText);
  $('#hudClock').classList.toggle('low', m.phase === 'teleop' && m.clockSec <= 10);
  const box = $('#hudHub');
  const cls = `hub-box ${m.hubClass}${m.warn ? ' warn' : ''}`;
  if (box.className !== cls) box.className = cls;
  txt($('#hubState'), m.hubState);
  html($('#hubNext'), m.hubNext);
  $('#hubBar').style.width = `${Math.round(Math.max(0, Math.min(1, m.hubBar)) * 100)}%`;
  html($('#oppHub'), m.oppText);
  txt($('#hudTip'), m.tip);
  $('#autoAsk').hidden = !m.ask;
  $('#hudPane').classList.toggle('asking', m.ask);
  renderTimeline($('#timeline'), m.us, m.inactiveFirst, m.phase === 'ready' ? null : m.nominal);
  html($('#hudWindows'), m.phase === 'ready' ? '' : windowsText(m) || (m.phase !== 'post' ? 'Hub order set by AUTO FUEL count' : ''));
  // alliance chip
  const chip = $('#hudAlliance');
  const ac = `alliance-chip ${m.us}`;
  if (chip.className !== ac) chip.className = ac;
  txt(chip, m.us.toUpperCase());
  // ask buttons label us / them
  for (const b of $$('#autoAsk [data-win]')) html(b, `${b.dataset.win.toUpperCase()}<small>${b.dataset.win === m.us ? 'US' : 'THEM'}</small>`);
  // mini HUD (camera-only layout)
  txt($('#miniClock'), m.clockText);
  txt($('#miniPhase'), m.periodName);
  const mh = $('#miniHub');
  txt(mh, m.miniHub);
  mh.className = `mini-hub${m.miniOn ? ' on' : ''}${m.warn ? ' warn' : ''}`;
  // score line
  const sum = currentSummary();
  const hasScout = session.scout.fuel.length || session.scout.autoTower || session.scout.climbs.some(Boolean);
  const sc = $('#hudScore');
  sc.hidden = !hasScout || HUD_ONLY;
  if (hasScout) html(sc, scoreLine(sum));
  const note = $('#hudNote');
  note.hidden = !session.note;
  txt(note, session.note || '');
  // scout hint
  const fh = $('#fuelHint');
  if (!$('#scout').hidden) {
    const live = m.miniOn;
    txt(fh, m.phase === 'ready' || m.phase === 'post' ? '' : m.hubClass === 'unknown' ? 'HUB ? (set AUTO winner)' : live ? 'HUB LIVE — counts' : 'HUB OFF — no points');
    fh.className = `fuel-hint ${live ? 'on' : 'off'}`;
  }
}

function renderControls(m) {
  if (HUD_ONLY) return;
  const b = $('#btnMain');
  let label;
  let cls = 'ctl main';
  const t = now();
  const confirming = t < confirmUntil;
  switch (m.phase) {
    case 'ready':
      label = 'START MATCH';
      break;
    case 'auto':
      if (m.state.periodLeft <= 5) {
        label = 'TELEOP GO';
        cls += ' sync';
      } else {
        label = confirming ? 'TAP TO ABORT' : 'ABORT';
        cls += confirming ? ' confirm' : ' stop';
      }
      break;
    case 'pause':
      label = 'TELEOP GO';
      cls += ' sync';
      break;
    case 'teleop':
      if (m.state.nominal < 25) {
        label = 'RESYNC TELEOP';
        cls += ' sync';
      } else {
        label = confirming ? 'TAP TO END' : 'END MATCH';
        cls += confirming ? ' confirm' : ' stop';
      }
      break;
    case 'post':
      label = 'SAVE · NEXT';
      cls += ' next';
      break;
  }
  txt(b, label);
  if (b.className !== cls) b.className = cls;
  b.dataset.phase = m.phase;
  $('#btnScout').classList.toggle('on', !$('#scout').hidden);
}

function onMain() {
  const m = lastModel || hudModel(now(), clock.state, settings);
  const t = now();
  switch (m.phase) {
    case 'ready':
      startMatch();
      break;
    case 'auto':
      if (m.state.periodLeft <= 5) clock.teleopGo();
      else if (t < confirmUntil) {
        confirmUntil = 0;
        clock.reset();
        cues.reset();
        toast('Match aborted');
      } else confirmUntil = t + 2500 * speed;
      break;
    case 'pause':
      clock.teleopGo();
      tone('start');
      break;
    case 'teleop':
      if (m.state.nominal < 25) {
        clock.teleopGo();
        toast('TELEOP re-synced');
      } else if (t < confirmUntil) {
        confirmUntil = 0;
        endMatch();
      } else confirmUntil = t + 2500 * speed;
      break;
    case 'post':
      if (postShownFor !== session.id) onMatchOver();
      else openPost();
      break;
  }
}

function renderRec() {
  const on = recorder.recording;
  const b = $('#btnRec');
  b.classList.toggle('on', on);
  b.classList.toggle('armed', !on && settings.autoRecord && camera.live && clock.state.autoStart == null);
  txt($('#btnRec span'), on ? 'STOP' : 'REC');
  $('#recPill').hidden = !on;
  if (on) txt($('#recTime'), fmtClock(recorder.elapsed));
}

// ---------------- scout ----------------
function addFuel(n) {
  const m = lastModel;
  if (!m || m.phase === 'ready' || m.phase === 'post') return toast('Start the match first');
  if (n === 'undo') {
    session.scout.fuel.pop();
  } else {
    const nominal = m.phase === 'pause' ? 19.99 : m.nominal;
    session.scout.fuel.push({ nominal, n, t: Date.now() });
  }
  saveSession();
  renderScout();
}

function addTag(label) {
  const m = lastModel;
  session.scout.tags.push({ label, t: Date.now(), nominal: m && m.phase !== 'ready' ? m.nominal : null, clock: m?.clockText || '' });
  saveSession();
  renderScout();
  toast(`Tagged: ${label}`);
}

function renderScout() {
  const sum = currentSummary();
  txt($('#fuelCount'), String(sum.fuelActive + sum.fuelUnknown));
  txt($('#fuelWaste'), sum.fuelInactive ? `+${sum.fuelInactive} while OFF` : '');
  html($('#scoutScore'), `EST ${sum.total} pts · tower ${sum.towerPts}`);
  setSeg($('#autoTower'), String(session.scout.autoTower || 0));
  const teams = [session.team || settings.team, ...session.partners];
  html(
    $('#climbs'),
    [0, 1, 2]
      .map(
        (i) =>
          `<div class="climb-row"><span>${teams[i] ? teams[i] : `R${i + 1}`}</span><div class="seg wide" data-climb="${i}">${['—', 'L1', 'L2', 'L3']
            .map((l, v) => `<button data-v="${v}" class="${session.scout.climbs[i] === v ? 'on' : ''}">${l}</button>`)
            .join('')}</div></div>`,
      )
      .join(''),
  );
  html(
    $('#tagLog'),
    session.scout.tags
      .slice(-6)
      .reverse()
      .map((g) => `<li>${g.clock || '--'} ${escapeHtml(g.label)}</li>`)
      .join(''),
  );
}

function currentSummary() {
  return scoreSummary(session.scout, clock.state.alliance, clock.state.inactiveFirst, settings.level);
}

// ---------------- setup / checklist / plan ----------------
function renderSetupHeader() {
  txt($('#hudMatch'), matchLabel(session));
  txt($('#hudTeam'), session.team || settings.team ? `#${session.team || settings.team}` : '');
}

function prepSetup() {
  const f = $('#setupForm');
  f.type.value = session.type;
  f.num.value = session.num;
  f.team.value = session.team || settings.team;
  f.p1.value = session.partners[0] || '';
  f.p2.value = session.partners[1] || '';
  f.o1.value = session.opponents[0] || '';
  f.o2.value = session.opponents[1] || '';
  f.o3.value = session.opponents[2] || '';
  f.note.value = session.note || '';
  setSeg($('#setupAlliance'), clock.state.alliance);
}

function saveSetup(e) {
  e.preventDefault();
  const f = e.target;
  session.type = f.type.value;
  session.num = Number(f.num.value) || 1;
  session.team = f.team.value.trim();
  session.partners = [f.p1.value.trim(), f.p2.value.trim()];
  session.opponents = [f.o1.value.trim(), f.o2.value.trim(), f.o3.value.trim()];
  session.note = f.note.value.trim();
  const a = $('#setupAlliance .on')?.dataset.v;
  if (a && a !== clock.state.alliance) setAlliance(a);
  saveSession();
  renderSetupHeader();
  renderScout();
  closeSheets();
}

function setAlliance(a) {
  if (clock.running && clock.state.autoStart != null && !clock.state.ended) {
    if (!confirm('Change alliance during the match?')) return;
  }
  clock.setAlliance(a);
  session.alliance = a;
  saveSession();
}

function renderChecklist() {
  const items = settings.checklist
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const done = new Set(session.checks || []);
  html(
    $('#checklist'),
    items
      .map(
        (it, i) =>
          `<li class="${done.has(i) ? 'done' : ''}"><label><input type="checkbox" data-check="${i}" ${done.has(i) ? 'checked' : ''}> ${escapeHtml(it)}</label></li>`,
      )
      .join(''),
  );
  txt($('#menuChecklist'), `${[...done].filter((i) => i < items.length).length} / ${items.length} done`);
}

function renderPlan() {
  const us = clock.state.alliance;
  const them = other(us);
  const row = (p, a, b) => {
    const from = p.id === 'auto' ? '0:20' : fmtClock(160 - p.start);
    const to = p.id === 'auto' ? '0:00' : fmtClock(160 - p.end);
    const pill = (x) => `<span class="pill ${x ? 'on' : 'off'}">${x ? 'LIVE' : 'OFF'}</span>`;
    return `<tr><td>${p.name}</td><td>${from}–${to}</td><td>${pill(a)}</td><td>${pill(b)}</td></tr>`;
  };
  const table = (inactiveFirst) => {
    const rows = PERIODS.map((p) => {
      const a = !p.shift ? true : p.shift % 2 === 1 ? us !== inactiveFirst : us === inactiveFirst;
      const b = !p.shift ? true : p.shift % 2 === 1 ? them !== inactiveFirst : them === inactiveFirst;
      return row(p, a, b);
    }).join('');
    return `<table><tr><th>PERIOD</th><th>CLOCK</th><th>US</th><th>THEM</th></tr>${rows}</table>`;
  };
  const tl = (inactiveFirst) => {
    const d = document.createElement('div');
    d.className = 'timeline';
    renderTimeline(d, us, inactiveFirst, null, { head: false });
    return d.outerHTML;
  };
  html(
    $('#planBody'),
    `<div class="plan-case"><h4>We win AUTO (more FUEL) → our hub OFF first</h4>${tl(us)}
      <p>Live: TRANSITION 2:20–2:10, SHIFT 2 1:45–1:20, then <b>SHIFT 4 + END GAME 0:55–0:00 (55 s straight)</b>. Use S1 and S3 to collect FUEL and play defense.</p>${table(us)}</div>
     <div class="plan-case"><h4>They win AUTO → our hub LIVE first</h4>${tl(them)}
      <p>Live: <b>TRANSITION + SHIFT 1 2:20–1:45 (35 s straight)</b>, SHIFT 3 1:20–0:55, END GAME 0:30–0:00. Arrive at TELEOP loaded with FUEL.</p>${table(them)}</div>
     <p class="fine">Both hubs are live in AUTO, TRANSITION and END GAME. HUB lights pulse for 3 s before going off. Game data (R/B) reaches the Driver Station at the start of TELEOP = the alliance whose hub goes OFF first. Tower: AUTO L1 15 (max 2 robots) · TELEOP L1 10 · L2 20 · L3 30. RP thresholds (${RP_THRESHOLDS[settings.level].label}): Energized ${RP_THRESHOLDS[settings.level].energized} FUEL · Supercharged ${RP_THRESHOLDS[settings.level].supercharged} FUEL · Traversal ${RP_THRESHOLDS[settings.level].traversal} tower pts.</p>`,
  );
}

// ---------------- settings ----------------
function prepSettings() {
  const f = $('#settingsForm');
  for (const [k, v] of Object.entries(settings)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  storageInfo().then((i) => {
    $('#storageInfo').textContent = i ? `Storage: ${(i.used / 1e6).toFixed(0)} MB used · ${(i.free / 1e9).toFixed(1)} GB available to this app` : '';
  });
}

async function saveSettingsForm(e) {
  e.preventDefault();
  const f = e.target;
  const next = { ...settings };
  for (const k of Object.keys(settings)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') next[k] = el.checked;
    else if (el.type === 'number') next[k] = Number(el.value);
    else next[k] = el.value;
  }
  next.fps = Number(next.fps);
  const camChanged = next.quality !== settings.quality || next.fps !== settings.fps || next.audio !== settings.audio;
  settings = next;
  saveSettings(settings);
  applySettings();
  renderChecklist();
  renderSetupHeader();
  closeSheets();
  toast('Settings saved');
  if (camChanged && camera.live) {
    if (recorder.recording) toast('Video changes apply after this recording');
    else await enableCamera(camera.deviceId);
  }
}

// ---------------- sheets / toast / flash ----------------
const PREP = {
  sheetSetup: prepSetup,
  sheetPlan: renderPlan,
  sheetChecklist: renderChecklist,
  sheetSettings: prepSettings,
};

function openSheet(id) {
  closeSheets();
  if (id === 'sheetLibrary') return openLibrary();
  PREP[id]?.();
  document.getElementById(id).hidden = false;
}

function closeSheets() {
  for (const s of $$('.sheet')) s.hidden = true;
  const v = $('#playVideo');
  if (!v.paused) v.pause();
}

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function flash(kind) {
  const f = $('#flash');
  f.className = 'flash';
  void f.offsetWidth;
  f.className = `flash ${kind}`;
}

function setSeg(seg, v) {
  for (const b of $$('button', seg)) b.classList.toggle('on', b.dataset.v === String(v));
}

async function keepAwake() {
  if (!settings.keepAwake || !('wakeLock' in navigator)) return;
  try {
    if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    /* denied */
  }
}

function refreshMenu() {
  db.allMatches()
    .then((all) => txt($('#menuLibrary'), `${all.length} match${all.length === 1 ? '' : 'es'} saved`))
    .catch(() => {});
  renderSetupHeader();
}

function cycleLayout() {
  const order = [
    ['split', false, 'Split: camera | HUD'],
    ['split', true, 'Split: HUD | camera'],
    ['hud', false, 'HUD full screen'],
    ['cam', false, 'Camera full screen'],
  ];
  const i = order.findIndex(([l, s]) => l === settings.layout && (l !== 'split' || !!settings.swap === s));
  const [layout, swap, name] = order[(i + 1) % order.length];
  settings = { ...settings, layout, swap };
  saveSettings(settings);
  applySettings();
  toast(name);
}

// ---------------- bindings ----------------
function bindUI() {
  $('#btnCam').addEventListener('click', () => enableCamera());
  $('#btnNoCam').addEventListener('click', () => {
    settings = { ...settings, layout: 'hud' };
    saveSettings(settings);
    applySettings();
    unlockAudio(false);
  });
  $('#btnLens').addEventListener('click', nextLens);
  $('#zoom').addEventListener('input', (e) => {
    const z = Number(e.target.value);
    $('#zoomVal').textContent = `${z.toFixed(1)}×`;
    camera.setZoom(z);
  });
  $('#btnMain').addEventListener('click', onMain);
  $('#btnRec').addEventListener('click', () => {
    unlockAudio(settings.audio);
    if (recorder.recording) stopRecording();
    else if (!camera.live) enableCamera().then(() => camera.live && startRecording());
    else startRecording();
  });
  $('#btnMinus').addEventListener('click', () => {
    clock.nudge(-1);
    toast('Clock −1 s');
  });
  $('#btnPlus').addEventListener('click', () => {
    clock.nudge(1);
    toast('Clock +1 s');
  });
  $('#btnScout').addEventListener('click', () => {
    $('#scout').hidden = !$('#scout').hidden;
    if (!$('#scout').hidden && settings.layout === 'hud') {
      settings = { ...settings, layout: 'split' };
      applySettings();
    }
    renderScout();
  });
  $('[data-close-scout]').addEventListener('click', () => ($('#scout').hidden = true));
  $('#btnLayout').addEventListener('click', cycleLayout);
  $('#btnMenu').addEventListener('click', () => openSheet('sheetMenu'));
  $('#hudMatch').addEventListener('click', () => !HUD_ONLY && openSheet('sheetSetup'));
  $('#hudAlliance').addEventListener('click', () => {
    if (clock.state.autoStart != null && !clock.state.ended) return toast('Alliance is locked during a match (Match setup to change)');
    setAlliance(other(clock.state.alliance));
  });
  for (const b of $$('#autoAsk [data-win]')) {
    b.addEventListener('click', () => {
      clock.setAutoWinner(b.dataset.win);
      const weWon = b.dataset.win === clock.state.alliance;
      say(weWon ? 'We won auto. Hub off first.' : 'They won auto. Hub live first.');
      toast(`${b.dataset.win.toUpperCase()} won AUTO → ${b.dataset.win.toUpperCase()} hub OFF in SHIFT 1`);
    });
  }
  // long-press the HUB box to change the AUTO winner later
  let pressT;
  $('#hudHub').addEventListener('pointerdown', () => {
    pressT = setTimeout(() => {
      if (clock.state.autoStart == null) return;
      clock.setAutoWinner(null);
      toast('AUTO winner cleared — pick again');
    }, 900);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('#hudHub').addEventListener(ev, () => clearTimeout(pressT));

  // scout
  for (const b of $$('[data-fuel]')) b.addEventListener('click', () => addFuel(b.dataset.fuel === 'undo' ? 'undo' : Number(b.dataset.fuel)));
  for (const b of $$('[data-tag]')) b.addEventListener('click', () => addTag(b.dataset.tag));
  $('#autoTower').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v == null) return;
    session.scout.autoTower = Number(v);
    saveSession();
    renderScout();
  });
  $('#climbs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const row = e.target.closest('[data-climb]');
    if (!btn || !row) return;
    session.scout.climbs[Number(row.dataset.climb)] = Number(btn.dataset.v);
    saveSession();
    renderScout();
  });

  // sheets
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) {
      e.preventDefault();
      openSheet(open.dataset.open);
      return;
    }
    if (e.target.closest('[data-close]') || e.target.classList.contains('sheet')) closeSheets();
  });
  $('#setupForm').addEventListener('submit', saveSetup);
  $('#setupAlliance').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v) setSeg($('#setupAlliance'), v);
  });
  $('#settingsForm').addEventListener('submit', saveSettingsForm);
  $('#postForm').addEventListener('submit', savePost);
  $('#postResult').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v) setSeg($('#postResult'), v);
  });
  $('#checklist').addEventListener('change', (e) => {
    const i = Number(e.target.dataset.check);
    const set = new Set(session.checks || []);
    if (e.target.checked) set.add(i);
    else set.delete(i);
    session.checks = [...set];
    saveSession();
    renderChecklist();
  });
  $('#btnCheckReset').addEventListener('click', () => {
    session.checks = [];
    saveSession();
    renderChecklist();
  });
  $('#btnTestCues').addEventListener('click', () => {
    unlockAudio(false);
    configureCues({ sounds: true, voice: true });
    tone('tick');
    setTimeout(() => tone('tick'), 1000);
    setTimeout(() => tone('tick'), 2000);
    setTimeout(() => {
      tone('go');
      flash('go');
      say('Shift two. Hub live. Shoot!');
      configureCues(settings);
    }, 3000);
  });
  $('#btnExport').addEventListener('click', exportAll);
  $('#btnResetMatch').addEventListener('click', async () => {
    if (!confirm('Reset the match clock to READY?')) return;
    if (recorder.recording) await stopRecording();
    closeSheets();
    if (session.ended) {
      await persistMatch();
      nextMatch();
      return;
    }
    clock.reset();
    cues.reset();
    session.timing = null;
    saveSession();
  });
  $('#btnHudWindow').addEventListener('click', () => {
    const w = window.open(`${location.pathname}?view=hud`, 'matchcam-hud');
    if (!w) toast('Pop-up blocked — open this page with ?view=hud');
    closeSheets();
  });
  $('#btnFullscreen').addEventListener('click', () => {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el).catch?.(() => toast('Use Share → Add to Home Screen for full screen'));
    else toast('Use Share → Add to Home Screen for full screen');
    closeSheets();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake();
      // iOS stops the camera in the background; bring it back.
      if (!HUD_ONLY && lsGet('matchcam.camOn') && camera.stream && !camera.live) enableCamera(camera.deviceId);
    }
  });
  window.addEventListener('pagehide', () => saveSession());
  // The driver-HUD window follows the main window's match setup + settings.
  window.addEventListener('storage', (e) => {
    if (e.key === 'matchcam.session.v1') {
      session = loadSession();
      renderSetupHeader();
    } else if (e.key === 'matchcam.settings.v1') {
      settings = loadSettings();
      applySettings();
    }
  });

  renderSetupHeader();
  renderScout();
  renderChecklist();
}

boot();

// test hooks
window.__mc = { clock, session: () => session, settings: () => settings, recorder, camera, openPlayback };
