'use strict';
// Queue that saves VOD movies / episodes from the provider to disk in the original container, then (optionally)
// shrinks them. The queue is stored on disk, so closing the app pauses downloads instead of losing them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const shrink = require('./shrink');

const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 100) || 'untitled';
const pad = (n) => String(n).padStart(2, '0');
const CONCURRENCY = 2;
const KEEP_FINISHED = 500;
const VIDEO = /\.(mp4|mkv|avi|mov|m4v|ts|webm)$/i;
const SHRINK_PART = '.shrink.part';
const ACTIVE = new Set(['queued', 'downloading', 'shrink-queued', 'shrinking']);
const gb = (n) => (n / 1e9).toFixed(1) + ' GB';
const asMp4 = (f) => f.replace(/\.[^.\\/]+$/, '') + '.mp4';
const remove = (f) => { try { fs.unlinkSync(f); } catch { /* not there */ } };
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

function freeBytes(dir) {
  for (let d = path.resolve(dir); fs.statfsSync; d = path.dirname(d)) {
    try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { if (path.dirname(d) === d) break; }
  }
  return null;
}

class Downloads {
  constructor({ cfg, vod, dataDir, getFfmpeg }) {
    this.cfg = cfg; this.vod = vod; this.getFfmpeg = getFfmpeg;
    this.file = path.join(dataDir, 'downloads.json');
    this.stopped = false; this.shrinking = null;
    this.ctl = new Map();         // job id -> AbortController
    this.onShrunk = null;         // (oldPath, newPath) => void
    try { this.jobs = JSON.parse(fs.readFileSync(this.file, 'utf8')).filter((j) => j && j.id && j.file && j.status); } catch { this.jobs = []; }
    // Whatever was in flight when the app closed picks up where it left off.
    for (const j of this.jobs) {
      if (j.status === 'downloading') j.status = 'queued';
      if (j.status === 'shrinking') { j.status = 'shrink-queued'; remove(j.file + SHRINK_PART); }
    }
    setImmediate(() => { this._pump(); this._pumpShrink(); });
  }

  root() { return this.cfg.get().downloadDir; }
  targetBytes() { return (+this.cfg.get().shrinkGB || 0) * 1e9; }
  freeSpace() { return freeBytes(this.root()); }

  save() {
    try {
      const finished = this.jobs.filter((j) => !ACTIVE.has(j.status));
      if (finished.length > KEEP_FINISHED) { const drop = new Set(finished.slice(KEEP_FINISHED)); this.jobs = this.jobs.filter((j) => !drop.has(j)); }
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.jobs));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('Could not save the download queue:', e.message); }   // e.g. disk full: keep running
  }

  // ---- naming (Plex/Jellyfin friendly) ----
  movieRel(m) {
    const t = safe(m.title || m.name) + (m.year ? ` (${m.year})` : '');
    return path.join('Movies', `${t}.${m.ext}`);
  }
  episodeRel(show, season, e) {
    const s = safe(show.name);
    const label = `${s} - S${pad(season)}E${pad(e.num)}${e.title && !/^s\d+e\d+/i.test(e.title) && e.title !== show.name ? ' - ' + safe(e.title) : ''}`;
    return path.join('TV Shows', s, `Season ${pad(season)}`, `${label}.${e.ext}`);
  }

  // Which playlist account a job belongs to (stream ids mean something else on another provider).
  _account() { const s = this.cfg.get().source; return crypto.createHash('sha1').update(`${s.type}|${s.server}|${s.username}`).digest('hex').slice(0, 12); }

  // ---- adding work ----
  async addMovie(id) {
    const m = await this.vod.movie(id);
    return [this._add({ title: m.title || m.name, rel: this.movieRel(m), source: { type: 'movie', id: m.id, ext: m.ext } })];
  }

  async addEpisodes(seriesId, { season, episodeId } = {}) {
    const show = await this.vod.series(seriesId);
    const out = [];
    for (const s of show.seasons) {
      if (season != null && s.season !== +season) continue;
      for (const e of s.episodes) {
        if (episodeId && e.id !== String(episodeId)) continue;
        out.push(this._add({
          title: `${show.name} S${pad(s.season)}E${pad(e.num)}${e.title ? ' ' + e.title : ''}`,
          rel: this.episodeRel(show, s.season, e), source: { type: 'episode', id: e.id, ext: e.ext },
        }));
      }
    }
    if (!out.length) throw new Error('No episodes found');
    return out;
  }

  _job(fields) {
    return { id: crypto.randomBytes(4).toString('hex'), status: 'queued', bytes: 0, total: 0, error: '', note: '', progress: 0, at: Date.now(), ...fields };
  }

  _add({ title, rel, source }) {
    const file = path.join(this.root(), rel);
    const dup = this.jobs.find((j) => j.file === file && ACTIVE.has(j.status));
    if (dup) return this.pub(dup);
    this.jobs = this.jobs.filter((j) => !(j.file === file && j.status === 'failed'));   // asking again replaces the failed attempt
    const job = this._job({ title, rel, file, source, account: this._account() });
    const have = [file, asMp4(file)].find((f) => fs.existsSync(f));      // a shrunk copy ends in .mp4
    if (have) Object.assign(job, { status: 'done', note: 'already downloaded', bytes: sizeOf(have) });
    this.jobs.unshift(job);
    this.save();
    this._pump();
    return this.pub(job);
  }

  _pump() {
    if (this.stopped) return;
    let running = this.jobs.filter((j) => j.status === 'downloading').length;
    for (const j of [...this.jobs].reverse()) {          // oldest queued first
      if (running >= CONCURRENCY) break;
      if (j.status !== 'queued' || this.ctl.has(j.id)) continue;
      j.status = 'downloading'; j.error = ''; running++;
      this.ctl.set(j.id, new AbortController());
      this._run(j, this.ctl.get(j.id))
        .catch((e) => { if (!this.stopped && j.status === 'downloading') { j.status = 'failed'; j.error = e.message; } })
        .finally(() => { this.ctl.delete(j.id); if (this.stopped) return; this.save(); this._pump(); this._pumpShrink(); });
    }
    this.save();
  }

  _url(source) {
    return source.type === 'movie' ? this.vod.movieUrl(source) : this.vod.episodeUrl(source);
  }

  async _run(j, ctl) {
    const part = j.file + '.part';
    const live = () => !this.stopped && !ctl.signal.aborted && j.status === 'downloading';
    if (j.account !== this._account()) throw new Error('The playlist changed after this was queued. Queue it again.');
    fs.mkdirSync(path.dirname(j.file), { recursive: true });
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!live()) return;
      try {
        let have = sizeOf(part);
        const headers = { 'User-Agent': this.cfg.get().userAgent };
        if (have) headers.Range = `bytes=${have}-`;
        const res = await fetch(this._url(j.source), { headers, signal: ctl.signal });
        if (res.status === 416 && j.total && have === j.total) return this._finish(j, part);
        if (!(res.status === 200 || res.status === 206)) throw new Error(`Provider replied HTTP ${res.status}`);
        if (res.status === 200) have = 0;               // server ignored Range: start over
        const len = +res.headers.get('content-length') || 0;
        const total = len ? have + len : 0;
        if (have && j.total && total && total !== j.total) {   // the provider swapped the file: old bytes are useless
          ctl.signal.throwIfAborted(); res.body.cancel().catch(() => {}); remove(part); j.total = 0;
          throw new Error('The file changed on the provider');
        }
        j.total = total; j.bytes = have;
        const free = freeBytes(path.dirname(j.file));
        if (total && free !== null && free < total - have + 200e6) {
          res.body.cancel().catch(() => {});
          throw Object.assign(new Error(`Not enough disk space: ${gb(total - have)} needed, ${gb(free)} free`), { fatal: true });
        }
        this.save();
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        const src = Readable.fromWeb(res.body);
        src.on('data', (c) => { j.bytes += c.length; });
        await pipeline(src, out, { signal: ctl.signal });
        if (j.total && j.bytes < j.total) throw new Error('Connection dropped');
        if (j.bytes < 1000) throw new Error('Provider sent an empty file');
        return this._finish(j, part);
      } catch (e) {
        if (!live()) return;
        if (e.code === 'ENOSPC') throw new Error('Disk is full');
        if (e.fatal) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('Download failed');
  }

  _finish(j, part) {
    fs.renameSync(part, j.file);
    j.bytes = j.total = sizeOf(j.file);
    j.targetBytes = this.targetBytes();
    j.status = shrink.needsShrink(j.bytes, j.targetBytes) ? 'shrink-queued' : 'done';
  }

  // ---- shrinking (one at a time: encoding is heavy) ----
  // Shrink a file that is already on disk; used for watchlist downloads and the "shrink" button.
  queueShrink(file, targetBytes = this.targetBytes()) {
    if (!shrink.needsShrink(sizeOf(file), targetBytes)) return null;
    const dup = this.jobs.find((j) => j.file === file && ACTIVE.has(j.status));
    if (dup) return this.pub(dup);
    const rel = path.relative(this.root(), file);
    const job = this._job({
      title: path.basename(file).replace(/\.[^.]+$/, ''), rel: rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(file) : rel,
      file, status: 'shrink-queued', bytes: sizeOf(file), total: sizeOf(file), targetBytes,
    });
    this.jobs.unshift(job);
    this.save();
    this._pumpShrink();
    return this.pub(job);
  }

  _pumpShrink() {
    if (this.stopped || this.shrinking) return;
    const j = [...this.jobs].reverse().find((x) => x.status === 'shrink-queued');
    if (!j) return;
    const ctl = new AbortController();
    this.shrinking = { job: j, ctl };
    j.status = 'shrinking'; j.progress = 0; j.note = '';
    this.save();
    const tmp = j.file + SHRINK_PART;
    this._shrink(j, tmp, ctl.signal)
      .then((note) => { if (j.status === 'shrinking') { j.status = 'done'; j.note = note; } })
      .catch((e) => { if (!this.stopped && j.status === 'shrinking') { j.status = 'done'; j.note = `could not shrink (${e.message}); original kept`; } })
      .finally(() => { remove(tmp); this.shrinking = null; if (this.stopped) return; this.save(); this._pumpShrink(); });
  }

  async _shrink(j, tmp, signal) {
    const ff = this.getFfmpeg();
    if (!ff) throw new Error('ffmpeg not found');
    const before = sizeOf(j.file);
    if (!before) throw new Error('file is missing');
    const info = await shrink.probe(ff.path, j.file);
    if (!info.duration || info.video === null) throw new Error('unreadable video');
    const free = freeBytes(path.dirname(j.file));
    if (free !== null && free < j.targetBytes * 1.15 + 200e6) throw new Error(`not enough free disk space, ${gb(free)} left`);
    await shrink.transcode({
      ffmpegPath: ff.path, src: j.file, out: tmp, info, targetBytes: j.targetBytes, encoder: this.cfg.get().encoder, signal,
      onProgress: (p) => { j.progress = p; },
    });
    // Never delete the original unless the new file is complete.
    const result = await shrink.probe(ff.path, tmp);
    if (Math.abs(result.duration - info.duration) > Math.max(5, info.duration * 0.02)) throw new Error('result came out shorter than the original');
    const after = sizeOf(tmp);
    if (!after || after >= before) throw new Error('result was not smaller');
    signal.throwIfAborted();
    const old = j.file;
    let out = asMp4(old);
    for (let n = 2; out !== old && fs.existsSync(out); n++) out = `${asMp4(old).slice(0, -4)} (${n}).mp4`;
    fs.renameSync(tmp, out);
    if (out !== old) remove(old);
    j.file = out; j.rel = path.join(path.dirname(j.rel), path.basename(out)); j.bytes = j.total = after; j.progress = 1;
    if (this.onShrunk) this.onShrunk(old, out);
    return `shrunk from ${gb(before)} to ${gb(after)}`;
  }

  // ---- managing the queue ----
  cancel(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || !ACTIVE.has(j.status)) return false;
    if (j.status === 'queued' || j.status === 'downloading') {
      j.status = 'cancelled';
      const c = this.ctl.get(j.id);
      if (c) c.abort();
      remove(j.file + '.part');
      setTimeout(() => { if (!this.jobs.some((x) => x.file === j.file && ACTIVE.has(x.status))) remove(j.file + '.part'); }, 500).unref();
    } else {
      j.status = 'done'; j.note = 'shrinking cancelled; original kept';
      if (this.shrinking && this.shrinking.job === j) this.shrinking.ctl.abort();
    }
    this.save();
    this._pump();
    return true;
  }

  retry(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || j.status !== 'failed') return false;
    j.status = 'queued'; j.error = ''; j.account = this._account();
    this.save();
    this._pump();
    return true;
  }

  // A file is about to be deleted: stop any encoding that reads it.
  forget(file) {
    for (const j of this.jobs) if (j.file === file && (j.status === 'shrink-queued' || j.status === 'shrinking')) this.cancel(j.id);
  }

  clearFinished() { this.jobs = this.jobs.filter((j) => ACTIVE.has(j.status)); this.save(); }

  // App is closing: stop transfers but keep partial files and queue entries for next time.
  shutdown() {
    this.save();
    this.stopped = true;
    for (const c of this.ctl.values()) c.abort();
    if (this.shrinking) this.shrinking.ctl.abort();
  }

  pub(j) { return { id: j.id, title: j.title, rel: j.rel, status: j.status, bytes: j.bytes, total: j.total, error: j.error, note: j.note || '', progress: j.progress || 0 }; }
  list() { return this.jobs.map((j) => this.pub(j)); }

  // ---- files on disk ----
  _walk(fn) {
    const root = this.root();
    const walk = (dir, depth) => {
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 5) walk(p, depth + 1); continue; }
        let st; try { st = fs.statSync(p); } catch { continue; }
        fn(p, path.relative(root, p).split(path.sep).join('/'), e.name, st);
      }
    };
    walk(root, 0);
  }

  files() {
    const out = [], target = this.targetBytes() || 5e9;
    this._walk((p, rel, name, st) => {
      if (VIDEO.test(name)) out.push({ rel, name, size: st.size, mtime: st.mtimeMs, playable: /\.(mp4|m4v|webm)$/i.test(name), shrinkable: shrink.needsShrink(st.size, target) });
    });
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  // Half-finished downloads that nothing in the queue owns (left behind by older versions or removed entries).
  partials(busy = new Set()) {
    const owned = new Set(this.jobs.filter((j) => j.status !== 'done' && j.status !== 'cancelled').map((j) => path.resolve(j.file + '.part')));
    const out = [];
    this._walk((p, rel, name, st) => {
      if (!name.endsWith('.part') || name.endsWith(SHRINK_PART)) return;
      const full = path.resolve(p);
      if (owned.has(full) || busy.has(full)) return;
      const bare = rel.replace(/(\.watch)?\.part$/, '');
      if (VIDEO.test(bare)) out.push({ rel, name: path.basename(bare), size: st.size, mtime: st.mtimeMs, resumable: !name.endsWith('.watch.part') });
    });
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  // Find the provider title that produced this partial file and queue it again.
  async resumePartial(rel) {
    const part = this.resolve(rel);
    if (!part || !part.endsWith('.part') || part.endsWith('.watch.part')) throw new Error('Partial download not found');
    const wanted = path.relative(path.resolve(this.root()), part.slice(0, -5));
    const [top, showName] = wanted.split(path.sep);
    const found = [];
    if (top === 'Movies') {
      const lib = await this.vod.ensure('movies');
      for (const m of lib.items) if (this.movieRel(m) === wanted) found.push({ title: m.title || m.name, source: { type: 'movie', id: m.id, ext: m.ext } });
    } else if (top === 'TV Shows') {
      const lib = await this.vod.ensure('series');
      for (const s of lib.items.filter((x) => safe(x.title || x.name) === showName).slice(0, 5)) {
        const show = await this.vod.series(s.id);
        for (const season of show.seasons) for (const e of season.episodes) {
          if (this.episodeRel(show, season.season, e) === wanted) found.push({ title: `${show.name} S${pad(season.season)}E${pad(e.num)}`, source: { type: 'episode', id: e.id, ext: e.ext } });
        }
      }
    }
    if (!found.length) throw new Error('Could not find this title on your provider. Search for it and download it again.');
    if (found.length > 1) remove(part);   // several copies share the name: appending to the wrong one would corrupt it
    return this._add({ title: found[0].title, rel: wanted, source: found[0].source });
  }

  // Resolve a client-supplied relative path, refusing anything outside the download folder.
  resolve(rel) {
    const root = path.resolve(this.root());
    const f = path.resolve(root, String(rel || ''));
    return f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
  }

  remove(rel) {
    const f = this.resolve(rel);
    if (!f) return false;
    this.forget(f);
    fs.unlinkSync(f);
    // prune now-empty show/season folders
    const root = path.resolve(this.root());
    for (let d = path.dirname(f); d.startsWith(root + path.sep); d = path.dirname(d)) {
      try { fs.rmdirSync(d); } catch { break; }
    }
    return true;
  }
}

module.exports = { Downloads };
