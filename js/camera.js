// Rear camera: lens selection, resolution/fps, zoom.

const QUALITY = {
  720: { width: 1280, height: 720, bitrate: 6_000_000 },
  1080: { width: 1920, height: 1080, bitrate: 10_000_000 },
  2160: { width: 3840, height: 2160, bitrate: 30_000_000 },
};

export function qualityInfo(q) {
  return QUALITY[q] || QUALITY[1080];
}

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.audioStream = null;
    this.lenses = [];
    this.deviceId = null;
  }

  get videoTrack() {
    return this.stream?.getVideoTracks()[0] || null;
  }

  get audioTrack() {
    return this.audioStream?.getAudioTracks()[0] || null;
  }

  get live() {
    return this.videoTrack?.readyState === 'live';
  }

  async start({ deviceId = this.deviceId, quality = '1080', fps = 30, audio = true } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera needs HTTPS and a browser with getUserMedia.');
    }
    this.stop();
    const q = qualityInfo(quality);
    const video = {
      width: { ideal: q.width },
      height: { ideal: q.height },
      frameRate: { ideal: Number(fps) },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: 'environment' };
    const mic = audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: true } : false;
    // One request for camera + mic: iOS can mute earlier tracks on a second capture call.
    const tryGet = async (v) => {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: v, audio: mic });
      } catch (err) {
        if (!mic || (err?.name === 'NotAllowedError' && /video|camera/i.test(err.message || ''))) throw err;
        return navigator.mediaDevices.getUserMedia({ video: v, audio: false }); // mic refused: video only
      }
    };
    let all;
    try {
      all = await tryGet(video);
    } catch (err) {
      if (!deviceId) throw err;
      // Saved lens vanished: fall back to any rear camera.
      delete video.deviceId;
      video.facingMode = { ideal: 'environment' };
      all = await tryGet(video);
    }
    this.stream = new MediaStream(all.getVideoTracks());
    this.audioStream = all.getAudioTracks().length ? new MediaStream(all.getAudioTracks()) : null;
    this.deviceId = this.videoTrack?.getSettings().deviceId || deviceId || null;
    this.video.srcObject = this.stream;
    this.video.muted = true;
    await this.video.play().catch(() => {});
    await this.refreshLenses();
    return this.settings;
  }

  async refreshLenses() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === 'videoinput');
      const back = cams.filter((d) => !/front|user|facetime/i.test(d.label));
      this.lenses = (back.length ? back : cams).map((d, i) => ({
        id: d.deviceId,
        label: lensLabel(d.label, i),
        raw: d.label,
      }));
    } catch {
      this.lenses = [];
    }
    return this.lenses;
  }

  get settings() {
    const s = this.videoTrack?.getSettings?.() || {};
    return { width: s.width, height: s.height, fps: s.frameRate, deviceId: s.deviceId };
  }

  get zoomRange() {
    const c = this.videoTrack?.getCapabilities?.();
    if (!c?.zoom || c.zoom.max <= c.zoom.min) return null;
    return { min: c.zoom.min, max: Math.min(c.zoom.max, 10), step: c.zoom.step || 0.1, value: this.videoTrack.getSettings().zoom ?? c.zoom.min };
  }

  async setZoom(z) {
    try {
      await this.videoTrack?.applyConstraints({ advanced: [{ zoom: z }] });
    } catch {
      /* not supported */
    }
  }

  stopVideo() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  stopAudio() {
    this.audioStream?.getTracks().forEach((t) => t.stop());
    this.audioStream = null;
  }

  stop() {
    this.stopVideo();
    this.stopAudio();
    this.video.srcObject = null;
  }
}

function lensLabel(label, i) {
  if (/ultra ?wide/i.test(label)) return '0.5× Ultra Wide';
  if (/triple/i.test(label)) return 'Triple (auto)';
  if (/dual wide/i.test(label)) return 'Dual Wide (auto)';
  if (/dual/i.test(label)) return 'Dual (auto)';
  if (/tele/i.test(label)) return 'Telephoto';
  if (/back camera|rear|wide/i.test(label)) return '1× Wide';
  return label || `Camera ${i + 1}`;
}
