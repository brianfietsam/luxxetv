'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { videoArgs, inputArgs } = require('./ffmpeg');
const { findComskip, stripCommercials } = require('./comskip');

const PRESETS = {
  small:    { crf: 28, maxHeight: 480,  maxrateK: 1000, audio: '96k'  },
  balanced: { crf: 25, maxHeight: 720,  maxrateK: 2500, audio: '128k' },
  high:     { crf: 22, maxHeight: 1080, maxrateK: 5000, audio: '160k' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
};

class Recorder {
  constructor({ cfg, sources, getFfmpeg }) {
    this.cfg = cfg; this.sources = sources; this.getFfmpeg = getFfmpeg;
    this.active = new Map();
    this.recent = [];
  }

  _args(url, outFile, remainingSec) {
    const c = this.cfg.get();
    const args = [...inputArgs(url, c.userAgent), '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn'];
    if (remainingSec) args.push('-t', String(remainingSec));
    if (c.recordQuality === 'copy') {
      args.push('-c', 'copy');
    } else {
      const p = PRESETS[c.recordQuality] || PRESETS.balanced;
      args.push(...videoArgs(c.encoder, p), '-c:a', 'aac', '-b:a', p.audio, '-ac', '2',
        // fragmented MP4: playable while recording and survives crashes / power loss
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof');
    }
    args.push('-y', outFile);
    return args;
  }

  async start({ channelId, minutes = 0, title = '' }) {
    const ff = this.getFfmpeg();
    if (!ff) throw new Error('ffmpeg not found - set its path in Settings');
    const ch = await this.sources.getChannel(channelId);
    if (!ch) throw new Error('Unknown channel');
    const dir = this.cfg.get().recordDir;
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      id: crypto.randomBytes(4).toString('hex'), channelId: ch.id, name: ch.name, title,
      startedAt: Date.now(), endAt: minutes > 0 ? Date.now() + minutes * 60000 : null,
      status: 'recording', stopping: false, proc: null, files: [], part: 0, error: null,
    };
    this.active.set(rec.id, rec);
    this._run(rec, ff.path).catch((e) => { rec.error = e.message; });
    return this.pub(rec);
  }

  _ext() { return this.cfg.get().recordQuality === 'copy' ? 'mkv' : 'mp4'; }

  // Show title (and episode) leads the filename; the channel is only a fallback / suffix.
  _uniqueFile(rec) {
    const c = this.cfg.get();
    const label = rec.title ? safe(rec.title) : safe(rec.name);
    const base = `${label} - ${stamp(new Date(rec.startedAt))}`;
    let f = path.join(c.recordDir, `${base}.${this._ext()}`);
    for (let i = 2; fs.existsSync(f); i++) f = path.join(c.recordDir, `${base} (${i}).${this._ext()}`);
    return f;
  }

  async _run(rec, ffmpegPath) {
    let fails = 0;
    const dir = this.cfg.get().recordDir;
    const partsDir = path.join(dir, '.parts');
    const extras = [];
    while (!rec.stopping && (!rec.endAt || Date.now() < rec.endAt - 3000)) {
      rec.part++;
      let url;
      try { url = await this.sources.streamUrl(rec.channelId); } catch (e) { rec.error = e.message; break; }
      // first good part is the visible recording; reconnect parts go to a hidden folder and are merged in at the end
      let file;
      if (!rec.mainFile) file = this._uniqueFile(rec);
      else { fs.mkdirSync(partsDir, { recursive: true }); file = path.join(partsDir, `${rec.id}-${rec.part}.${this._ext()}`); }
      rec.currentFile = file;
      const remaining = rec.endAt ? Math.max(1, Math.ceil((rec.endAt - Date.now()) / 1000)) : 0;
      const t0 = Date.now();
      await this._spawn(rec, ffmpegPath, this._args(url, file, remaining));
      let size = 0; try { size = fs.statSync(file).size; } catch { /* missing */ }
      if (size < 20000) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
      else if (!rec.mainFile) { rec.mainFile = file; rec.files.push(path.basename(file)); }
      else extras.push(file);
      if (rec.stopping) break;
      fails = Date.now() - t0 < 10000 ? fails + 1 : 0;
      if (fails >= 5) { rec.error = 'Stream kept failing - gave up'; break; }
      await sleep(3000);
    }
    rec.currentFile = null;
    if (rec.mainFile && extras.length) await this._merge(rec, ffmpegPath, extras, partsDir);
    const c = this.cfg.get();
    if (rec.mainFile && c.commSkip === 'cut') {
      const cs = findComskip(c.comskipPath);
      if (!cs) rec.lastError = 'Commercial skip is on but comskip was not found - set its path in Settings';
      else {
        rec.status = 'processing';
        try {
          const r = await stripCommercials({ file: rec.mainFile, comskipPath: cs.path, ffmpegPath });
          rec.lastError = r.removed ? `Removed ${Math.round(r.removed / 60)} min of commercials` : r.skipped;
        } catch (e) { rec.lastError = 'comskip failed: ' + e.message; }
      }
    }
    rec.status = rec.error ? 'failed' : 'done';
    rec.proc = null;
    this.active.delete(rec.id);
    this.recent.unshift(this.pub(rec));
    this.recent.length = Math.min(this.recent.length, 20);
  }

  // Join reconnect fragments into the main file so one recording = one file.
  async _merge(rec, ffmpegPath, extras, partsDir) {
    const all = [rec.mainFile, ...extras];
    const listFile = path.join(partsDir, `${rec.id}-list.txt`);
    const merged = path.join(partsDir, `${rec.id}-merged${path.extname(rec.mainFile)}`);
    try {
      fs.mkdirSync(partsDir, { recursive: true });
      const q = (f) => `file '${f.split('\\').join('/').split("'").join("'\\''")}'`;
      fs.writeFileSync(listFile, all.map(q).join('\n'));
      const mv = rec.mainFile.endsWith('.mp4') ? ['-movflags', '+faststart'] : [];
      const ok = await new Promise((resolve) => {
        const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
          '-c', 'copy', ...mv, '-y', merged], { stdio: 'ignore', windowsHide: true });
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
      });
      if (ok && fs.existsSync(merged) && fs.statSync(merged).size > 20000) {
        fs.renameSync(merged, rec.mainFile);
        extras.forEach((f) => { try { fs.unlinkSync(f); } catch { /* ignore */ } });
      } else {
        // merge failed: keep the pieces visible rather than losing them
        for (const f of extras) {
          const dest = this._uniqueFile({ ...rec, title: (rec.title || rec.name) + ' (part ' + (rec.files.length + 1) + ')' });
          try { fs.renameSync(f, dest); rec.files.push(path.basename(dest)); } catch { /* ignore */ }
        }
      }
    } catch (e) { rec.lastError = 'merge failed: ' + e.message; }
    for (const f of [listFile, merged]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }

  _spawn(rec, ffmpegPath, args) {
    return new Promise((resolve) => {
      const p = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      rec.proc = p;
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
      p.stdin.on('error', () => {});
      p.on('error', (e) => { rec.error = `ffmpeg failed to start: ${e.message}`; resolve(); });
      p.on('close', () => { rec.lastError = err.trim().split('\n').pop(); resolve(); });
    });
  }

  stop(id) {
    const rec = this.active.get(id);
    if (!rec) return false;
    rec.stopping = true;
    const p = rec.proc;
    if (p) {
      try { p.stdin.write('q\n'); } catch { /* ignore */ }   // graceful: lets ffmpeg finalize the file
      setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 10000).unref();
    }
    return true;
  }

  async stopAll() {
    const ids = [...this.active.keys()];
    ids.forEach((i) => this.stop(i));
    for (let i = 0; i < 40 && this.active.size; i++) await sleep(250);
  }

  pub(rec) {
    let bytes = 0;
    for (const f of [...rec.files, rec.currentFile && path.basename(rec.currentFile)].filter(Boolean)) {
      try { bytes += fs.statSync(path.join(this.cfg.get().recordDir, f)).size; } catch { /* ignore */ }
    }
    return { id: rec.id, channelId: rec.channelId, name: rec.name, title: rec.title, startedAt: rec.startedAt,
      endAt: rec.endAt, status: rec.status, error: rec.error, bytes, files: rec.files, note: rec.lastError };
  }

  status() { return { active: [...this.active.values()].map((r) => this.pub(r)), recent: this.recent }; }

  list() {
    const dir = this.cfg.get().recordDir;
    const live = new Set([...this.active.values()].map((r) => r.currentFile && path.basename(r.currentFile)));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => /\.(mp4|mkv)$/i.test(n)).map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return { name: n, size: st.size, mtime: st.mtimeMs, recording: live.has(n), playable: /\.mp4$/i.test(n) };
    }).sort((a, b) => b.mtime - a.mtime);
  }

  resolve(name) {
    const base = path.basename(name);
    const f = path.join(this.cfg.get().recordDir, base);
    return fs.existsSync(f) ? f : null;
  }
}

module.exports = { Recorder, PRESETS };
