'use strict';
// Queue that saves VOD movies / episodes from the provider straight to disk (no re-encode, original container).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 100) || 'untitled';
const pad = (n) => String(n).padStart(2, '0');
const CONCURRENCY = 2;

class Downloads {
  constructor({ cfg, vod }) {
    this.cfg = cfg; this.vod = vod;
    this.jobs = [];
  }

  root() { return this.cfg.get().downloadDir; }

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

  // ---- adding work ----
  async addMovie(id) {
    const m = await this.vod.movie(id);
    return [this._add({ title: m.title || m.name, rel: this.movieRel(m), url: () => this.vod.movieUrl(m) })];
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
          rel: this.episodeRel(show, s.season, e), url: () => this.vod.episodeUrl(e),
        }));
      }
    }
    if (!out.length) throw new Error('No episodes found');
    return out;
  }

  _add({ title, rel, url }) {
    const dup = this.jobs.find((j) => j.rel === rel && (j.status === 'queued' || j.status === 'downloading'));
    if (dup) return this.pub(dup);
    const job = { id: crypto.randomBytes(4).toString('hex'), title, rel, urlFn: url, status: 'queued', bytes: 0, total: 0, error: '', ctl: null, at: Date.now() };
    if (fs.existsSync(path.join(this.root(), rel))) { job.status = 'done'; job.note = 'already downloaded'; }
    this.jobs.unshift(job);
    this.jobs.length = Math.min(this.jobs.length, 500);
    this._pump();
    return this.pub(job);
  }

  _pump() {
    let running = this.jobs.filter((j) => j.status === 'downloading').length;
    for (const j of [...this.jobs].reverse()) {          // oldest queued first
      if (running >= CONCURRENCY) break;
      if (j.status !== 'queued') continue;
      j.status = 'downloading'; running++;
      this._run(j).catch((e) => { if (j.status !== 'cancelled') { j.status = 'failed'; j.error = e.message; } })
        .finally(() => { j.ctl = null; this._pump(); });
    }
  }

  async _run(j) {
    const dest = path.join(this.root(), j.rel);
    const part = dest + '.part';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (j.status === 'cancelled') return;
      j.ctl = new AbortController();
      try {
        let have = 0; try { have = fs.statSync(part).size; } catch { /* fresh */ }
        const headers = { 'User-Agent': this.cfg.get().userAgent };
        if (have) headers.Range = `bytes=${have}-`;
        const res = await fetch(await j.urlFn(), { headers, signal: j.ctl.signal });
        if (!(res.status === 200 || res.status === 206)) throw new Error(`Provider replied HTTP ${res.status}`);
        if (res.status === 200) have = 0;               // server ignored Range: start over
        const len = +res.headers.get('content-length') || 0;
        j.total = len ? have + len : 0; j.bytes = have;
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        const src = Readable.fromWeb(res.body);
        src.on('data', (c) => { j.bytes += c.length; });
        await pipeline(src, out, { signal: j.ctl.signal });
        if (j.total && j.bytes < j.total) throw new Error('Connection dropped');
        if (j.bytes < 1000) throw new Error('Provider sent an empty file');
        fs.renameSync(part, dest);
        j.status = 'done'; j.bytes = fs.statSync(dest).size; j.total = j.bytes;
        return;
      } catch (e) {
        if (j.status === 'cancelled') return;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('Download failed');
  }

  cancel(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || (j.status !== 'queued' && j.status !== 'downloading')) return false;
    j.status = 'cancelled';
    if (j.ctl) j.ctl.abort();
    setTimeout(() => { try { fs.unlinkSync(path.join(this.root(), j.rel) + '.part'); } catch { /* ignore */ } }, 500).unref();
    return true;
  }

  cancelAll() { this.jobs.forEach((j) => this.cancel(j.id)); }

  clearFinished() { this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'downloading'); }

  pub(j) { return { id: j.id, title: j.title, rel: j.rel, status: j.status, bytes: j.bytes, total: j.total, error: j.error, note: j.note || '' }; }
  list() { return this.jobs.map((j) => this.pub(j)); }

  // ---- finished files on disk ----
  files() {
    const root = this.root(), out = [];
    const walk = (dir, depth) => {
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 5) walk(p, depth + 1); }
        else if (/\.(mp4|mkv|avi|mov|m4v|ts|webm)$/i.test(e.name)) {
          const st = fs.statSync(p);
          out.push({ rel: path.relative(root, p).split(path.sep).join('/'), name: e.name, size: st.size, mtime: st.mtimeMs, playable: /\.(mp4|m4v|webm)$/i.test(e.name) });
        }
      }
    };
    walk(root, 0);
    return out.sort((a, b) => b.mtime - a.mtime);
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
