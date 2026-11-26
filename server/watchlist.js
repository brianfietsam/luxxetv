'use strict';
// Movie watchlist: periodically checks the Xtream VOD library and downloads marked movies as soon as they appear.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { findMatch } = require('./vod');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
const IDLE_MS = +process.env.LUXXETV_DL_IDLE_MS || 90000;   // abort a stalled transfer after this long without data
const RETRIES = 6;
const STATUSES = ['waiting', 'queued', 'downloading', 'done', 'failed'];

class Watchlist {
  constructor({ cfg, dataDir, tmdb, vod, sources }) {
    this.cfg = cfg; this.tmdb = tmdb; this.vod = vod; this.sources = sources;
    this.file = path.join(dataDir, 'watchlist.json');
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.items = []; }
    this.items = this.items.filter((i) => i && i.tmdbId && STATUSES.includes(i.status));
    // Interrupted downloads resume (the .part file is kept) after a restart.
    for (const i of this.items) if (i.status === 'downloading') i.status = 'queued';
    this.state = { checking: false, lastCheck: 0, lastError: null };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.file + '.state', 'utf8')), { checking: false }); } catch { /* none */ }
    this.current = null;      // { item, abort }
    this.working = false;
    this.lastSave = 0;
    this.timer = setInterval(() => this._tick(), 60000);
    this.timer.unref();
    this.startTimer = setTimeout(() => this._tick(), 20000);
    this.startTimer.unref();
    setImmediate(() => this._work());
  }

  movieDir() {
    const c = this.cfg.get();
    return (c.movieDir || '').trim() || path.join(c.recordDir, 'Movies');
  }

  save() {
    this.lastSave = Date.now();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    fs.renameSync(tmp, this.file);
    fs.writeFileSync(this.file + '.state', JSON.stringify({ lastCheck: this.state.lastCheck, lastError: this.state.lastError }));
  }

  get(tmdbId) { return this.items.find((i) => String(i.tmdbId) === String(tmdbId)) || null; }

  async add(tmdbId) {
    const id = parseInt(tmdbId, 10);
    if (!(id > 0)) throw new Error('Invalid movie id');
    const have = this.get(id);
    if (have) return this.pub(have);
    const m = await this.tmdb.movie(id);
    const item = {
      tmdbId: m.id, title: m.title, originalTitle: m.originalTitle, year: m.year, poster: m.poster,
      theatrical: m.theatrical, digital: m.digital, digitalEstimate: m.digitalEstimate,
      addedAt: Date.now(), status: 'waiting', vod: null, file: null, bytes: 0, total: 0, error: null,
    };
    this.items.push(item);
    this.save();
    // It may already be on the provider: check right away (uses the cached library when fresh).
    this._match([item], false).catch(() => {});
    return this.pub(item);
  }

  remove(tmdbId, { deleteFile = false } = {}) {
    const item = this.get(tmdbId);
    if (!item) return false;
    if (this.current && this.current.item === item) this.current.abort('removed');
    this.items = this.items.filter((i) => i !== item);
    const p = item.file && path.join(this.movieDir(), item.file);
    try { if (p) fs.unlinkSync(p + '.part'); } catch { /* none */ }
    if (deleteFile && p && item.status === 'done') { try { fs.unlinkSync(p); } catch { /* gone */ } }
    this.save();
    return true;
  }

  retry(tmdbId) {
    const item = this.get(tmdbId);
    if (!item || item.status !== 'failed') return false;
    item.status = item.vod ? 'queued' : 'waiting'; item.error = null;
    this.save();
    if (item.vod) this._work(); else this._match([item], true).catch(() => {});
    return true;
  }

  async _tick() {
    const hours = Math.max(0.25, +this.cfg.get().movieCheckHours || 3);
    if (Date.now() - this.state.lastCheck < hours * 3600000) return;
    if (!this.items.some((i) => i.status === 'waiting' || (i.status === 'failed' && !i.vod))) { this.state.lastCheck = Date.now(); return; }
    await this.check().catch(() => {});
  }

  // Refresh the provider's movie list and queue every watched movie that is now available.
  async check() {
    if (this.state.checking) return this.status();
    this.state.checking = true;
    try {
      await this._match(this.items.filter((i) => i.status === 'waiting' || (i.status === 'failed' && !i.vod)), true);
      this.state.lastError = null;
    } catch (e) {
      this.state.lastError = e.message;
      throw e;
    } finally {
      this.state.checking = false;
      this.state.lastCheck = Date.now();
      this.save();
    }
    return this.status();
  }

  async _match(items, force) {
    if (!items.length) return;
    const lib = await this.vod.ensure(force);
    let found = false;
    for (const item of items) {
      if (!this.items.includes(item)) continue;
      // Keep streaming dates current while we wait (cached for a day).
      if (!item.digital && this.tmdb.configured()) {
        try { const d = await this.tmdb.releaseDates(item.tmdbId); item.digital = d.digital; if (d.theatrical) item.theatrical = d.theatrical; } catch { /* keep old */ }
      }
      item.lastChecked = Date.now();
      const v = findMatch({ id: item.tmdbId, title: item.title, originalTitle: item.originalTitle, year: item.year }, lib.items);
      if (!v) continue;
      item.vod = { streamId: v.streamId, name: v.name, ext: v.ext };
      item.status = 'queued'; item.error = null; item.foundAt = Date.now();
      found = true;
    }
    this.save();
    if (found) this._work();
  }

  async _work() {
    if (this.working) return;
    this.working = true;
    try {
      let item;
      while ((item = this.items.find((i) => i.status === 'queued'))) await this._download(item);
    } finally { this.working = false; }
  }

  async _download(item) {
    const dir = this.movieDir();
    fs.mkdirSync(dir, { recursive: true });
    if (!item.file) {
      const base = safe(`${item.title}${item.year ? ` (${item.year})` : ''}`);
      let name = `${base}.${item.vod.ext}`;
      for (let n = 2; fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, name + '.part')); n++) name = `${base} (${n}).${item.vod.ext}`;
      item.file = name;
    }
    const final = path.join(dir, item.file), part = final + '.part';
    item.status = 'downloading'; item.error = null; item.startedAt = Date.now();
    this.save();
    let lastErr = null;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      if (!this.items.includes(item)) return;
      try {
        await this._transfer(item, part);
        fs.renameSync(part, final);
        item.status = 'done'; item.doneAt = Date.now(); item.bytes = fs.statSync(final).size;
        this.save();
        return;
      } catch (e) {
        lastErr = e;
        if (e.gone) item.vod = null;   // re-match on the next library check
        if (e.fatal || e.message === 'removed' || e.message === 'shutdown') break;
        await sleep(Math.min(60000, 3000 * attempt));
      }
    }
    if (!this.items.includes(item)) { try { fs.unlinkSync(part); } catch { /* none */ } return; }
    if (lastErr && lastErr.message === 'shutdown') return;
    item.status = 'failed'; item.error = lastErr ? lastErr.message : 'Download failed';
    this.save();
  }

  // One HTTP attempt; resumes from the .part file with a Range request when possible.
  async _transfer(item, part) {
    let have = 0; try { have = fs.statSync(part).size; } catch { /* fresh */ }
    const ctl = new AbortController();
    let reason = null;
    const abort = (r) => { reason = r; ctl.abort(); };
    this.current = { item, abort };
    let idle = setTimeout(() => abort('Download stalled'), IDLE_MS);
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => abort('Download stalled'), IDLE_MS); };
    try {
      const headers = { 'User-Agent': this.cfg.get().userAgent };
      if (have > 0) headers.Range = `bytes=${have}-`;
      let res;
      try { res = await fetch(this.sources.vodUrl(item.vod.streamId, item.vod.ext), { headers, signal: ctl.signal, redirect: 'follow' }); }
      catch (e) { throw new Error(reason || `Connection failed: ${e.cause ? e.cause.code || e.cause.message : e.message}`); }
      if (res.status === 416 && have > 0 && item.total && have >= item.total) return;   // already complete
      if (res.status === 404) { const e = new Error('Movie no longer on the provider (HTTP 404)'); e.fatal = true; e.gone = true; throw e; }
      if (res.status !== 200 && res.status !== 206) throw new Error(`Provider replied HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      const len = +res.headers.get('content-length') || 0;
      if (/text\/|json/i.test(type) && len < 1e6) throw new Error('Provider returned an error page instead of the movie');
      let append = res.status === 206 && have > 0;
      if (!append) have = 0;    // server ignored Range: start over
      const total = res.status === 206 ? +((res.headers.get('content-range') || '').split('/')[1]) || have + len : len;
      item.total = total || 0; item.bytes = have;
      if (total && fs.statfsSync) {
        try {
          const st = fs.statfsSync(path.dirname(part));
          if (st.bavail * st.bsize < total - have + 200e6) { const e = new Error(`Not enough disk space (${((total - have) / 1e9).toFixed(1)} GB needed)`); e.fatal = true; throw e; }
        } catch (e) { if (e.fatal) throw e; }
      }
      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      try {
        for await (const chunk of Readable.fromWeb(res.body)) {
          bump();
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          item.bytes += chunk.length;
          if (Date.now() - this.lastSave > 10000) this.save();
        }
      } catch (e) {
        throw new Error(reason || `Transfer interrupted: ${e.message}`);
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (reason) throw new Error(reason);
      const size = fs.statSync(part).size;
      if (total && size < total) throw new Error(`Transfer ended early (${size} of ${total} bytes)`);
      if (size < 1e5) { fs.unlinkSync(part); throw new Error('Downloaded file is too small to be a movie'); }
    } catch (e) {
      if (e.code === 'ENOSPC') { const f = new Error('Disk is full'); f.fatal = true; throw f; }
      if (e.code === 'EACCES' || e.code === 'EPERM') { const f = new Error(`Cannot write to ${path.dirname(part)}`); f.fatal = true; throw f; }
      throw e;
    } finally {
      clearTimeout(idle);
      this.current = null;
    }
  }

  pub(i) {
    return {
      tmdbId: i.tmdbId, title: i.title, year: i.year, poster: i.poster, theatrical: i.theatrical, digital: i.digital,
      digitalEstimate: i.digitalEstimate, addedAt: i.addedAt, status: i.status, error: i.error, bytes: i.bytes, total: i.total,
      file: i.file, providerName: i.vod && i.vod.name, foundAt: i.foundAt, doneAt: i.doneAt, lastChecked: i.lastChecked,
      playable: !!(i.file && i.status === 'done' && /\.(mp4|m4v)$/i.test(i.file)),
    };
  }

  list() { return [...this.items].sort((a, b) => b.addedAt - a.addedAt).map((i) => this.pub(i)); }

  status() {
    const hours = Math.max(0.25, +this.cfg.get().movieCheckHours || 3);
    return { checking: this.state.checking, lastCheck: this.state.lastCheck || 0, nextCheck: (this.state.lastCheck || Date.now()) + hours * 3600000,
      lastError: this.state.lastError, downloading: this.current ? this.pub(this.current.item) : null, movieDir: this.movieDir() };
  }

  resolve(tmdbId) {
    const i = this.get(tmdbId);
    if (!i || i.status !== 'done' || !i.file) return null;
    const f = path.join(this.movieDir(), path.basename(i.file));
    return fs.existsSync(f) ? f : null;
  }

  shutdown() {
    clearInterval(this.timer); clearTimeout(this.startTimer);
    if (this.current) this.current.abort('shutdown');
    for (const i of this.items) if (i.status === 'downloading') i.status = 'queued';
    try { this.save(); } catch { /* ignore */ }
  }
}

module.exports = { Watchlist };
