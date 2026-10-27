// Match library: list, playback with synced HUB overlay, analysis, export.

import { AUTO_LEN, MATCH_LEN, PERIODS, epochAt, fmtClock, scoreSummary } from './game.js';
import { hudModel, renderTimeline } from './hud.js';
import { escapeHtml, summaryHtml } from './summary.js';
import { db, storageInfo } from './store.js';
import { extFor } from './recorder.js';

const $ = (s, r = document) => r.querySelector(s);

let ctx = null;
let current = null; // match record
let currentVideo = null; // video record
let url = null;
let overlayOn = true;
const SPEEDS = [1, 0.5, 0.25, 2];

export function matchLabel(s) {
  const t = { P: 'Practice', Q: 'Qual', SF: 'Playoff', F: 'Final', T: 'Test' }[s?.type] || 'Match';
  return `${t} ${s?.num ?? ''}`.trim();
}

const allianceOf = (m) => m?.timing?.alliance || m?.alliance || 'red';

function showSheet(id) {
  for (const s of document.querySelectorAll('.sheet')) s.hidden = s.id !== id;
}

export function initLibrary(c) {
  ctx = c;
  const v = $('#playVideo');
  v.addEventListener('timeupdate', syncOverlay);
  v.addEventListener('seeked', syncOverlay);
  v.addEventListener('play', () => requestAnimationFrame(tickPlay));
  v.addEventListener('loadedmetadata', () => {
    // Chrome's webm has no duration until fully scanned.
    if (v.duration === Infinity) {
      v.currentTime = 1e9;
      v.addEventListener('timeupdate', () => (v.currentTime = 0), { once: true });
    }
  });
  $('#libList').addEventListener('click', (e) => {
    const it = e.target.closest('[data-id]');
    if (it) openPlayback(it.dataset.id);
  });
  $('#playTimeline').addEventListener('click', (e) => {
    const mk = e.target.closest('[data-seek]');
    if (mk) return seekVideo(Number(mk.dataset.seek));
    const r = e.currentTarget.getBoundingClientRect();
    seekNominal(((e.clientX - r.left) / r.width) * MATCH_LEN);
  });
  $('#playJumps').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.nominal) seekNominal(Number(b.dataset.nominal));
    else if (b.dataset.seek) seekVideo(Number(b.dataset.seek));
  });
  $('#playSummary').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seek]');
    if (b) seekVideo(Number(b.dataset.seek));
  });
  $('#btnSpeed').addEventListener('click', () => {
    const i = (SPEEDS.indexOf(v.playbackRate) + 1) % SPEEDS.length;
    v.playbackRate = SPEEDS[i];
    $('#btnSpeed').textContent = `${SPEEDS[i]}×`;
  });
  $('#btnOverlay').addEventListener('click', () => {
    overlayOn = !overlayOn;
    $('#btnOverlay').textContent = overlayOn ? 'Overlay on' : 'Overlay off';
    $('#playOverlay').hidden = !overlayOn || !current?.timing;
  });
  $('#btnShare').addEventListener('click', shareVideo);
  $('#btnDownload').addEventListener('click', downloadVideo);
  $('#btnDelete').addEventListener('click', deleteCurrent);
  let noteT;
  $('#playNotes').addEventListener('input', (e) => {
    clearTimeout(noteT);
    const val = e.target.value;
    noteT = setTimeout(() => {
      if (!current) return;
      current.notes = val;
      db.putMatch(current);
    }, 500);
  });
}

export async function openLibrary() {
  showSheet('sheetLibrary');
  const list = (await db.allMatches().catch(() => [])).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const settings = ctx.getSettings();
  const rec = { W: 0, L: 0, T: 0 };
  let pts = 0;
  let fuel = 0;
  let scouted = 0;
  for (const m of list) {
    if (m.result) rec[m.result]++;
    if (m.scout?.fuel?.length) {
      const s = scoreSummary(m.scout, allianceOf(m), m.timing?.inactiveFirst, m.level || settings.level);
      pts += s.total;
      fuel += s.fuelActive;
      scouted++;
    }
  }
  const info = await storageInfo();
  $('#libStats').innerHTML = `
    <div class="stat"><b>${list.length}</b><span>Matches</span></div>
    <div class="stat"><b>${rec.W}-${rec.L}-${rec.T}</b><span>W-L-T</span></div>
    <div class="stat"><b>${scouted ? Math.round(pts / scouted) : '–'}</b><span>Avg est. pts</span></div>
    <div class="stat"><b>${scouted ? Math.round(fuel / scouted) : '–'}</b><span>Avg live FUEL</span></div>
    <div class="stat"><b>${info ? (info.used / 1e9).toFixed(2) : '–'}</b><span>GB used</span></div>`;
  $('#libList').innerHTML = list.length
    ? list
        .map((m) => {
          const v = m.videos?.[0];
          const thumb = v?.thumb ? `<img src="${v.thumb}" alt="">` : `<div class="lib-thumb">${v ? 'video' : 'timer only'}</div>`;
          const date = m.createdAt ? new Date(m.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
          const score = m.scores && (m.scores.red != null || m.scores.blue != null) ? ` · ${m.scores.red ?? '?'}–${m.scores.blue ?? '?'}` : '';
          const size = (m.videos || []).reduce((s, x) => s + (x.size || 0), 0);
          return `<button class="lib-item" data-id="${escapeHtml(m.id)}">${thumb}<div><b>${escapeHtml(m.label || 'Match')}</b>
            <div class="meta">${date}${m.alliance ? ` · ${m.alliance.toUpperCase()}` : ''}${score}${size ? ` · ${(size / 1e6).toFixed(0)} MB` : ''}${m.event ? ` · ${escapeHtml(m.event)}` : ''}</div></div>
            <span class="res ${m.result || ''}">${m.result || '—'}</span></button>`;
        })
        .join('')
    : '<div class="empty">No matches yet. Start a match and it will show up here.</div>';
}

export async function openPlayback(id) {
  const m = await db.getMatch(id);
  if (!m) return;
  current = m;
  currentVideo = null;
  if (url) URL.revokeObjectURL(url);
  url = null;
  showSheet('sheetPlay');
  $('#playTitle').textContent = `${m.label || 'Match'}${m.alliance ? ` · ${m.alliance.toUpperCase()}` : ''}${m.event ? ` · ${m.event}` : ''}`;
  const v = $('#playVideo');
  v.removeAttribute('src');
  v.load();
  const vid = m.videos?.[0];
  if (vid) currentVideo = await db.getVideo(vid.id).catch(() => null);
  $('#playNoVideo').hidden = !!currentVideo;
  for (const id of ['btnShare', 'btnDownload', 'btnSpeed']) $('#' + id).hidden = !currentVideo;
  if (currentVideo) {
    url = URL.createObjectURL(currentVideo.blob);
    v.src = url;
    v.playbackRate = 1;
    $('#btnSpeed').textContent = '1×';
  }
  // Burned-in videos already carry the HUD; don't draw it twice.
  overlayOn = !(currentVideo?.burnIn || vid?.burnIn);
  $('#btnOverlay').textContent = overlayOn ? 'Overlay on' : 'Overlay off';
  $('#playOverlay').hidden = !overlayOn || !m.timing;
  document.body.classList.toggle('us-blue', allianceOf(m) === 'blue');
  renderTimeline($('#playTimeline'), allianceOf(m), m.timing?.inactiveFirst ?? null, null, { head: true });
  renderMarkers();
  renderJumps();
  const settings = ctx.getSettings();
  const sum = scoreSummary(m.scout || {}, allianceOf(m), m.timing?.inactiveFirst, m.level || settings.level);
  const tags = (m.scout?.tags || [])
    .map((g) => {
      const at = videoTimeFor(g.t);
      const link = at != null ? `<button data-seek="${Math.max(0, at - 3)}">${g.clock || fmtClock(at)}</button>` : g.clock || '';
      return `<li>${link} ${escapeHtml(g.label)}</li>`;
    })
    .join('');
  const scores = m.scores && (m.scores.red != null || m.scores.blue != null) ? `<div class="fine">Final: RED ${m.scores.red ?? '?'} – BLUE ${m.scores.blue ?? '?'}${m.result ? ` · ${{ W: 'Win', L: 'Loss', T: 'Tie' }[m.result]}` : ''}</div>` : '';
  const who =
    m.partners?.some(Boolean) || m.opponents?.some(Boolean)
      ? `<div class="fine">With ${[m.team, ...(m.partners || [])].filter(Boolean).join(', ') || '—'} vs ${(m.opponents || []).filter(Boolean).join(', ') || '—'}</div>`
      : '';
  const auto = m.timing?.inactiveFirst ? `<div class="fine">AUTO won by ${m.timing.inactiveFirst.toUpperCase()} → ${m.timing.inactiveFirst.toUpperCase()} hub OFF in SHIFT 1 &amp; 3</div>` : '';
  $('#playSummary').innerHTML = `${scores}${who}${auto}${m.scout?.fuel?.length || m.scout?.climbs?.some(Boolean) ? summaryHtml(sum, m) : ''}${tags ? `<div class="lbl">TAGGED MOMENTS</div><ol class="tags-list">${tags}</ol>` : ''}`;
  $('#playNotes').value = m.notes || '';
  syncOverlay();
}

function timingClock() {
  const t = current?.timing;
  if (!t) return null;
  return { autoStart: t.autoStart, teleopStart: t.teleopStart, pause: t.pause, inactiveFirst: t.inactiveFirst, alliance: allianceOf(current), ended: false };
}

function recStart() {
  return currentVideo?.recStart ?? current?.videos?.[0]?.recStart ?? null;
}

function videoTimeFor(epoch) {
  const rs = recStart();
  if (rs == null || epoch == null) return null;
  return (epoch - rs) / 1000;
}

function seekVideo(sec) {
  const v = $('#playVideo');
  if (!currentVideo) return;
  v.currentTime = Math.max(0, sec);
  if (v.paused) v.play().catch(() => {});
}

function seekNominal(nominal) {
  const c = timingClock();
  if (!c) return;
  const at = videoTimeFor(epochAt(Math.max(0, Math.min(MATCH_LEN, nominal)), c));
  if (at != null) seekVideo(at);
}

function renderMarkers() {
  const el = $('#playTimeline');
  el.querySelectorAll('.mk').forEach((n) => n.remove());
  for (const g of current.scout?.tags || []) {
    if (g.nominal == null) continue;
    const b = document.createElement('button');
    b.className = 'mk';
    b.style.left = `${(g.nominal / MATCH_LEN) * 100}%`;
    b.title = g.label;
    const at = videoTimeFor(g.t);
    if (at != null) b.dataset.seek = String(Math.max(0, at - 3));
    el.appendChild(b);
  }
}

function renderJumps() {
  const has = !!current.timing && !!currentVideo;
  const jumps = has
    ? [
        ['AUTO', 0],
        ['TELEOP', AUTO_LEN],
        ...PERIODS.filter((p) => p.shift || p.id === 'endgame').map((p) => [p.short, p.start]),
      ]
        .map(([l, n]) => `<button data-nominal="${n}">${l}</button>`)
        .join('')
    : '';
  $('#playJumps').innerHTML = jumps;
}

function tickPlay() {
  const v = $('#playVideo');
  syncOverlay();
  if (!v.paused && !$('#sheetPlay').hidden) requestAnimationFrame(tickPlay);
}

function syncOverlay() {
  const c = timingClock();
  const rs = recStart();
  if (!c || rs == null) return;
  const v = $('#playVideo');
  const t = rs + (v.currentTime || 0) * 1000;
  const m = hudModel(t, c, ctx.getSettings());
  $('#poClock').textContent = m.phase === 'ready' ? 'PRE' : m.clockText;
  $('#poPeriod').textContent = m.phase === 'ready' ? 'before AUTO' : m.periodName;
  const hub = $('#poHub');
  hub.textContent = m.miniHub;
  hub.className = `mini-hub${m.miniOn ? ' on' : ''}`;
  renderTimeline($('#playTimeline'), c.alliance, c.inactiveFirst, m.phase === 'ready' ? 0 : m.nominal);
}

function fileName() {
  const m = current;
  const d = new Date(m.createdAt || Date.now());
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const parts = [m.event, m.label, m.team && `team${m.team}`, date].filter(Boolean).join('_');
  return `${parts.replace(/[^a-z0-9_-]+/gi, '-')}.${extFor(currentVideo?.mime || currentVideo?.blob?.type || '')}`;
}

async function shareVideo() {
  if (!currentVideo) return;
  const type = (currentVideo.blob.type || 'video/mp4').split(';')[0];
  const file = new File([currentVideo.blob], fileName(), { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: current.label });
    } catch (err) {
      if (err?.name !== 'AbortError') ctx.toast(`Share failed: ${err.message || err}`);
    }
  } else downloadVideo();
}

function downloadVideo() {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function deleteCurrent() {
  if (!current || !confirm(`Delete ${current.label || 'this match'}${currentVideo ? ' and its video' : ''}?`)) return;
  for (const v of current.videos || []) await db.deleteVideo(v.id).catch(() => {});
  await db.deleteMatch(current.id).catch(() => {});
  if (url) URL.revokeObjectURL(url);
  url = null;
  current = null;
  ctx.onChange?.();
  openLibrary();
}

export async function exportAll() {
  const settings = ctx.getSettings();
  const list = (await db.allMatches().catch(() => [])).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const rows = [
    ['match', 'date', 'event', 'team', 'alliance', 'result', 'red', 'blue', 'auto_winner', 'fuel_live', 'fuel_off', 'tower_pts', 'est_pts', 'energized', 'supercharged', 'traversal', 'partners', 'opponents', 'tags', 'notes'],
  ];
  for (const m of list) {
    const s = scoreSummary(m.scout || {}, allianceOf(m), m.timing?.inactiveFirst, m.level || settings.level);
    rows.push([
      m.label,
      m.createdAt ? new Date(m.createdAt).toISOString() : '',
      m.event || '',
      m.team || '',
      m.alliance || '',
      m.result || '',
      m.scores?.red ?? '',
      m.scores?.blue ?? '',
      m.timing?.inactiveFirst || '',
      s.fuelActive,
      s.fuelInactive,
      s.towerPts,
      s.total,
      s.rp.energized.ok ? 1 : 0,
      s.rp.supercharged.ok ? 1 : 0,
      s.rp.traversal.ok ? 1 : 0,
      (m.partners || []).filter(Boolean).join(' '),
      (m.opponents || []).filter(Boolean).join(' '),
      (m.scout?.tags || []).map((g) => `${g.clock} ${g.label}`).join('; '),
      m.notes || '',
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const json = JSON.stringify(
    { app: 'REBUILT MatchCam', exportedAt: new Date().toISOString(), matches: list.map((m) => ({ ...m, videos: (m.videos || []).map(({ thumb, ...v }) => v) })) },
    null,
    2,
  );
  const stamp = new Date().toISOString().slice(0, 10);
  const files = [new File([csv], `matchcam-${stamp}.csv`, { type: 'text/csv' }), new File([json], `matchcam-${stamp}.json`, { type: 'application/json' })];
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title: 'MatchCam export' });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}
