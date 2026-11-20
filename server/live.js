'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { videoArgs, inputArgs } = require('./ffmpeg');

const QUALITY = {
  '480p':  { crf: 28, maxHeight: 480,  maxrateK: 1200, audio: '96k' },
  '720p':  { crf: 24, maxHeight: 720,  maxrateK: 3000, audio: '128k' },
  '1080p': { crf: 22, maxHeight: 1080, maxrateK: 6000, audio: '160k' },
};
const IDLE_MS = 30000;
const VOD_IDLE_MS = 20 * 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// On-demand live restreaming: IPTV MPEG-TS -> H.264/AAC HLS that browsers (incl. Tesla) can play.
class Live {
  constructor({ cfg, sources, getFfmpeg }) {
    this.cfg = cfg; this.sources = sources; this.getFfmpeg = getFfmpeg;
    this.root = path.join(os.tmpdir(), 'luxxetv-live');
    this.sessions = new Map();
    this.vod = new Map();
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true });
    this.timer = setInterval(() => this._reap(), 10000);
    this.timer.unref();
  }

  dirFor(id) { return path.join(this.root, String(id).replace(/[^\w-]/g, '_')); }

  async ensure(id) {
    let s = this.sessions.get(id);
    if (s) { s.last = Date.now(); return s; }
    const ff = this.getFfmpeg();
    if (!ff) throw new Error('ffmpeg not found');
    const max = this.cfg.get().maxLiveSessions;
    while (this.sessions.size >= max) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.last - b.last)[0];
      this._kill(oldest);
    }
    const url = await this.sources.streamUrl(id);
    const dir = this.dirFor(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const c = this.cfg.get();
    const args = [...inputArgs(url, c.userAgent), '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn'];
    if (c.liveQuality === 'copy') args.push('-c:v', 'copy');
    else args.push(...videoArgs(c.encoder, QUALITY[c.liveQuality] || QUALITY['720p']));
    const ab = (QUALITY[c.liveQuality] || QUALITY['720p']).audio;
    args.push('-c:a', 'aac', '-b:a', ab, '-ac', '2',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+independent_segments',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'), path.join(dir, 'index.m3u8'));
    const proc = spawn(ff.path, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    s = { id, dir, proc, last: Date.now(), err: '' };
    proc.stderr.on('data', (d) => { s.err = (s.err + d).slice(-1000); });
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => { s.err = e.message; });
    proc.on('close', () => { if (this.sessions.get(id) === s) this.sessions.delete(id); });
    this.sessions.set(id, s);
    return s;
  }

  async waitPlaylist(s, ms = 30000) {
    const f = path.join(s.dir, 'index.m3u8');
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const exited = s.proc.exitCode !== null;          // note the exit first: a short VOD can finish between our checks
      try { if (fs.readFileSync(f, 'utf8').includes('.ts')) return f; } catch { /* not yet */ }
      if (exited) return null;
      await sleep(300);
    }
    return null;
  }

  // ---- VOD: transcode a movie/episode to a growing HLS "event" playlist (seekable in what is already converted) ----
  async ensureVod(key, url) {
    let s = this.vod.get(key);
    if (s) { s.last = Date.now(); return s; }
    const ff = this.getFfmpeg();
    if (!ff) throw new Error('ffmpeg not found - set its path in Settings');
    while (this.vod.size >= 2) this._killVod([...this.vod.values()].sort((a, b) => a.last - b.last)[0]);
    const dir = path.join(this.root, 'vod-' + key.replace(/[^\w-]/g, '_'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const c = this.cfg.get();
    const q = QUALITY[c.liveQuality] || QUALITY['720p'];
    const args = [...inputArgs(url, c.userAgent), '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
      ...videoArgs(c.encoder, q), '-c:a', 'aac', '-b:a', q.audio, '-ac', '2',
      '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'), path.join(dir, 'index.m3u8')];
    const proc = spawn(ff.path, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    s = { key, dir, proc, last: Date.now(), err: '' };
    proc.stderr.on('data', (d) => { s.err = (s.err + d).slice(-1000); });
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => { s.err = e.message; });
    this.vod.set(key, s);
    return s;
  }

  _killVod(s) {
    this.vod.delete(s.key);
    try { s.proc.kill(); } catch { /* ignore */ }
    setTimeout(() => fs.rmSync(s.dir, { recursive: true, force: true }), 1500).unref();
  }

  touch(id) { const s = this.sessions.get(id); if (s) s.last = Date.now(); }

  _kill(s) {
    this.sessions.delete(s.id);
    try { s.proc.kill(); } catch { /* ignore */ }
    setTimeout(() => fs.rmSync(s.dir, { recursive: true, force: true }), 1500).unref();
  }

  _reap() {
    for (const s of [...this.sessions.values()]) if (Date.now() - s.last > IDLE_MS) this._kill(s);
    for (const s of [...this.vod.values()]) if (Date.now() - s.last > VOD_IDLE_MS) this._killVod(s);   // long: viewers pause
  }

  shutdown() { clearInterval(this.timer); for (const s of [...this.sessions.values()]) this._kill(s); for (const s of [...this.vod.values()]) this._killVod(s); }
}

module.exports = { Live };
