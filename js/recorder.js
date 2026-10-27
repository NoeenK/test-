// MediaRecorder wrapper. Chunks are written to IndexedDB every second, so an
// interrupted recording (tab killed, phone call, crash) can be recovered.
// Optional "burn-in" mode records a canvas with the HUD drawn over the camera.

import { db } from './store.js';

const TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const t of TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return '';
}

export const canRecord = () => typeof window.MediaRecorder === 'function';

export const extFor = (mime) => (/webm/.test(mime) ? 'webm' : 'mp4');

export class Recorder extends EventTarget {
  constructor() {
    super();
    this.mr = null;
    this.compositor = null;
    this.startedAt = 0;
  }

  get recording() {
    return this.mr?.state === 'recording';
  }

  get elapsed() {
    return this.recording ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  start({ camera, bitrate, fps, burnIn, drawOverlay, recId }) {
    if (this.recording) return;
    let videoTrack = camera.videoTrack;
    if (!videoTrack) throw new Error('Camera is off');
    this.compositor = null;
    if (burnIn && drawOverlay && HTMLCanvasElement.prototype.captureStream) {
      this.compositor = new Compositor(camera.video, drawOverlay, Number(fps) || 30);
      videoTrack = this.compositor.track;
    }
    const tracks = [videoTrack];
    if (camera.audioTrack) tracks.push(camera.audioTrack);
    const stream = new MediaStream(tracks);
    const mime = pickMime();
    const opts = { videoBitsPerSecond: bitrate, audioBitsPerSecond: 128_000 };
    if (mime) opts.mimeType = mime;
    let mr;
    try {
      mr = new MediaRecorder(stream, opts);
    } catch {
      mr = new MediaRecorder(stream);
    }
    this.mr = mr;
    this.mime = mr.mimeType || mime || 'video/mp4';
    this.recId = recId;
    this.seq = 0;
    this.mem = new Map(); // chunks not yet safely in IndexedDB
    this.pending = new Set();
    this.idbOk = true;

    mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const seq = this.seq++;
      this.mem.set(seq, e.data);
      if (!this.idbOk) return;
      const p = db
        .putChunk(recId, seq, e.data)
        .then(() => this.mem.delete(seq))
        .catch(() => {
          this.idbOk = false; // quota/private mode: keep the rest in memory
        })
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    };
    this.stopped = new Promise((resolve) => {
      mr.onstop = () => resolve();
    });
    mr.onerror = (e) => this.dispatchEvent(new CustomEvent('error', { detail: e.error || e }));
    this.srcTrack = camera.videoTrack;
    this.endedHandler = () => this.dispatchEvent(new Event('interrupted'));
    this.srcTrack.addEventListener('ended', this.endedHandler, { once: true });
    mr.start(1000);
    this.startedAt = Date.now();
    this.dispatchEvent(new Event('start'));
  }

  /** Stop and assemble the final Blob. Resolves { blob, mime, duration }. */
  async stop() {
    if (!this.mr) return null;
    const duration = (Date.now() - this.startedAt) / 1000;
    if (this.mr.state !== 'inactive') this.mr.stop();
    await this.stopped;
    // ondataavailable for the final chunk fires before onstop; let its write start.
    await new Promise((r) => setTimeout(r, 50));
    await Promise.allSettled([...this.pending]);
    this.compositor?.stop();
    this.compositor = null;
    this.srcTrack?.removeEventListener('ended', this.endedHandler);
    let parts = [];
    try {
      parts = (await db.chunksFor(this.recId)).map((c) => [c.seq, c.blob]);
    } catch {
      parts = [];
    }
    for (const [seq, b] of this.mem) parts.push([seq, b]);
    parts.sort((a, b) => a[0] - b[0]);
    const blob = new Blob(
      parts.map((p) => p[1]),
      { type: this.mime.split(';')[0] },
    );
    const out = { blob, mime: this.mime, duration, recId: this.recId };
    this.mr = null;
    this.mem = new Map();
    this.dispatchEvent(new Event('stop'));
    return out;
  }
}

/** Rebuild recordings whose page died mid-match. */
export async function recoverChunks(knownVideoIds) {
  const out = [];
  let recs = [];
  try {
    recs = await db.chunkRecs();
  } catch {
    return out;
  }
  for (const rec of recs) {
    if (knownVideoIds.has(rec)) {
      await db.deleteChunks(rec).catch(() => {});
      continue;
    }
    const chunks = await db.chunksFor(rec);
    if (!chunks.length) continue;
    chunks.sort((a, b) => a.seq - b.seq);
    const type = chunks[0].blob.type || 'video/mp4';
    const last = chunks[chunks.length - 1];
    out.push({ recId: rec, blob: new Blob(chunks.map((c) => c.blob), { type }), seconds: chunks.length, lastAt: last.t || null });
  }
  return out;
}

class Compositor {
  constructor(video, draw, fps) {
    this.video = video;
    this.draw = draw;
    this.canvas = document.createElement('canvas');
    this.canvas.width = video.videoWidth || 1280;
    this.canvas.height = video.videoHeight || 720;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.track = this.canvas.captureStream(fps).getVideoTracks()[0];
    this.running = true;
    const useVfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    const loop = () => {
      if (!this.running) return;
      this.frame();
      if (useVfc) video.requestVideoFrameCallback(loop);
      else requestAnimationFrame(loop);
    };
    loop();
  }

  frame() {
    const { video, canvas, ctx } = this;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    try {
      this.draw(ctx, w, h);
    } catch {
      /* never break the recording over the overlay */
    }
  }

  stop() {
    this.running = false;
    this.track.stop();
  }
}

export function snapshot(video, maxW = 360) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const s = Math.min(1, maxW / w);
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  try {
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}
