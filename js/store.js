// Settings (localStorage) and match/video storage (IndexedDB).

const SETTINGS_KEY = 'matchcam.settings.v1';

export const DEFAULT_SETTINGS = {
  team: '7558',
  event: '',
  level: 'regional', // RP thresholds: regional | dcmp | cmp
  quality: '1080', // 720 | 1080 | 2160
  fps: 30,
  audio: true,
  burnIn: false, // draw the HUD into the recorded video
  autoRecord: true, // start recording when the match starts
  postRoll: 8, // seconds to keep recording after 0:00
  pause: 3, // AUTO -> TELEOP pause (s) before TELEOP is synced
  sounds: true,
  voice: true,
  lead: 5, // spoken warning this many seconds before our HUB changes
  climbAt: 20, // "climb" call at this many seconds left (0 = off)
  keepAwake: true,
  layout: 'split', // split | hud | cam
  swap: false,
  checklist: [
    'Fresh battery, strapped in',
    'Bumpers match alliance color',
    'Robot linked (DS green)',
    'AUTO routine selected',
    'Pre-loaded FUEL',
    'Camera framed on full field',
  ].join('\n'),
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode: keep in memory */
  }
}

export function lsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// ---------------- IndexedDB ----------------

let dbp = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open('matchcam', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('matches', { keyPath: 'id' });
      db.createObjectStore('videos', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['rec', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        Promise.resolve(fn(s)).then((v) => (out = v));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const reqP = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export const db = {
  putMatch: (m) => tx('matches', 'readwrite', (s) => s.put(m)),
  getMatch: (id) => tx('matches', 'readonly', (s) => reqP(s.get(id))),
  allMatches: () => tx('matches', 'readonly', (s) => reqP(s.getAll())),
  deleteMatch: (id) =>
    Promise.all([tx('matches', 'readwrite', (s) => s.delete(id)), tx('videos', 'readwrite', (s) => s.delete(id))]),
  putVideo: (v) => tx('videos', 'readwrite', (s) => s.put(v)),
  getVideo: (id) => tx('videos', 'readonly', (s) => reqP(s.get(id))),
  deleteVideo: (id) => tx('videos', 'readwrite', (s) => s.delete(id)),
  putChunk: (rec, seq, blob) => tx('chunks', 'readwrite', (s) => s.put({ rec, seq, blob, t: Date.now() })),
  chunksFor: (rec) =>
    tx('chunks', 'readonly', (s) => reqP(s.getAll(IDBKeyRange.bound([rec, 0], [rec, Infinity])))),
  deleteChunks: (rec) => tx('chunks', 'readwrite', (s) => s.delete(IDBKeyRange.bound([rec, 0], [rec, Infinity]))),
  chunkRecs: () =>
    tx('chunks', 'readonly', (s) => reqP(s.getAllKeys())).then((keys) => [...new Set(keys.map((k) => k[0]))]),
};

export async function storageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { used: est.usage || 0, quota: est.quota || 0, free: (est.quota || 0) - (est.usage || 0) };
  } catch {
    return null;
  }
}

export async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* ignore */
  }
}
