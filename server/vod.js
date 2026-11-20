'use strict';
// Xtream VOD: movie + TV-series catalogs, series episode lists, stream URLs, and box-office enrichment (TMDB).
const fs = require('fs');
const path = require('path');

const TTL = 6 * 3600 * 1000;
const INFO_TTL = 30 * 60 * 1000;
const BO_RETRY = 7 * 86400 * 1000;   // re-try titles TMDB did not know about after a week

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// "EN - The Matrix (1999) 4K [MULTI]" -> { title: 'The Matrix', year: 1999 }
function cleanTitle(raw) {
  let s = String(raw || '');
  let year = 0;
  const ym = s.match(/[(\[]((?:19|20)\d{2})[)\]]/) || s.match(/\s((?:19|20)\d{2})\s*$/);
  if (ym) year = +ym[1];
  s = s.replace(/^\s*(?:\|[A-Z0-9+]{2,6}\||[A-Z]{2,3}\s*[-:|]\s+|\[[^\]]+\]\s*)/, '');
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  s = s.replace(/\b(?:4K|UHD|FHD|HD|SD|HEVC|H\.?265|H\.?264|1080p|720p|2160p|BluRay|WEB-?DL|MULTI|DUAL)\b/gi, ' ');
  s = s.replace(/\s+(?:19|20)\d{2}\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title: s, year };
}

class BoxOffice {
  constructor({ cfg, dataDir }) {
    this.cfg = cfg;
    this.file = path.join(dataDir, 'boxoffice.json');
    this.map = {};
    try { this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.queue = []; this.queued = new Set(); this.running = 0; this.saveT = null;
    this.stats = { done: 0, failed: 0, lastError: '' };
  }

  enabled() { return !!(this.cfg.get().tmdbKey || '').trim(); }
  gross(key) { const e = this.map[key]; return e && e.rev > 0 ? e.rev : null; }
  known(key) { const e = this.map[key]; return !!e && (e.rev > 0 || Date.now() - e.at < BO_RETRY); }
  pending() { return this.queue.length + this.running; }

  // How many of these still need a lookup.
  unknown(movies) { let n = 0; for (const m of movies) if (!this.known('m' + m.id)) n++; return n; }

  // Whatever the user is looking at goes to the front of the line; older, bigger requests wait behind it.
  enqueue(movies) {
    if (!this.enabled()) return;
    const fresh = movies.filter((m) => !this.known('m' + m.id) && !this.queued.has('r' + m.id));   // r = running
    const ids = new Set(fresh.map((m) => m.id));
    this.queue = [...fresh, ...this.queue.filter((m) => !ids.has(m.id))];
    this._pump();
  }

  _pump() {
    while (this.running < 12 && this.queue.length) {
      const m = this.queue.shift();
      this.running++; this.queued.add('r' + m.id);
      this._lookup(m).catch((e) => {
        this.stats.failed++; this.stats.lastError = e.message;
        this.map['m' + m.id] = { rev: 0, at: Date.now() - BO_RETRY + 300000 };   // failed: leave it alone for 5 minutes
      })
        .finally(() => { this.running--; this.queued.delete('r' + m.id); this._save(); this._pump(); });
    }
  }

  async _tmdb(p, params = {}) {
    const c = this.cfg.get();
    const key = c.tmdbKey.trim();
    const base = (c.tmdbBase || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
    const qs = new URLSearchParams(params);
    const headers = { Accept: 'application/json' };
    if (key.length > 40) headers.Authorization = 'Bearer ' + key; else qs.set('api_key', key);   // v4 token or v3 key
    const res = await fetch(`${base}${p}?${qs}`, { headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); throw new Error('TMDB rate limit'); }
    if (res.status === 401) throw new Error('TMDB rejected the API key');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
    return res.json();
  }

  async _lookup(m) {
    let tmdb = m.tmdb;
    if (!tmdb) {
      const { title, year } = cleanTitle(m.name);
      if (!title) return void (this.map['m' + m.id] = { rev: 0, at: Date.now() });
      const r = await this._tmdb('/search/movie', { query: title, ...(year || m.year ? { year: year || m.year } : {}) });
      const hit = r && r.results && r.results[0];
      tmdb = hit && hit.id;
    }
    let rev = 0;
    if (tmdb) { const d = await this._tmdb('/movie/' + encodeURIComponent(tmdb)); rev = d ? num(d.revenue) : 0; }
    this.map['m' + m.id] = { rev, at: Date.now() };
    this.stats.done++;
  }

  _save() {
    if (this.saveT) return;
    this.saveT = setTimeout(() => {
      this.saveT = null;
      try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.map)); fs.renameSync(this.file + '.tmp', this.file); } catch { /* ignore */ }
    }, 2000);
    this.saveT.unref();
  }
}

class Vod {
  constructor({ cfg, sources, dataDir }) {
    this.cfg = cfg; this.sources = sources; this.dataDir = dataDir;
    this.mem = {};
    this.info = new Map();
    this.box = new BoxOffice({ cfg, dataDir });
  }

  _requireXtream() {
    const s = this.cfg.get().source;
    if (s.type !== 'xtream') throw new Error('Movies and TV shows need an Xtream Codes playlist (M3U has no VOD catalog)');
    if (!s.server || !s.username) throw new Error('Xtream server/username not configured');
    return s;
  }

  async _load(kind) {
    this._requireXtream();
    const [catA, listA, idKey, logoKey] = kind === 'movies'
      ? ['get_vod_categories', 'get_vod_streams', 'stream_id', 'stream_icon']
      : ['get_series_categories', 'get_series', 'series_id', 'cover'];
    const [cats, list] = await Promise.all([this.sources._json(catA), this.sources._json(listA)]);
    if (!Array.isArray(list)) throw new Error('Login rejected or unexpected response from server');
    const catName = new Map((cats || []).map((c) => [String(c.category_id), c.category_name]));
    const categories = (cats || []).map((c) => ({ id: String(c.category_id), name: c.category_name }));
    const items = list.map((x) => {
      const { title, year } = cleanTitle(x.name);
      return {
        id: String(x[idKey]), name: x.name, cat: catName.get(String(x.category_id)) || 'Uncategorized',
        logo: x[logoKey] || '', rating: num(x.rating_5based) ? num(x.rating_5based) * 2 : num(x.rating),
        added: num(x.added || x.last_modified), year: num(x.year) || year || num(String(x.releaseDate || x.release_date || '').slice(0, 4)),
        ext: x.container_extension || 'mp4', tmdb: x.tmdb && x.tmdb !== '0' ? String(x.tmdb) : '', title,
      };
    });
    return { categories, items };
  }

  async ensure(kind, force = false) {
    const file = path.join(this.dataDir, `vod-${kind}.json`);
    const sig = this.sources._sig();
    const m = this.mem[kind];
    if (!force && m && Date.now() - m.at < TTL && m.sig === sig) return m;
    if (!force && !m) {
      try {
        const c = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (c.sig === sig && Date.now() - c.at < TTL) return (this.mem[kind] = this._index(c));
      } catch { /* no cache */ }
    }
    const data = await this._load(kind);
    const c = { at: Date.now(), sig, ...data };
    fs.writeFileSync(file, JSON.stringify(c));
    return (this.mem[kind] = this._index(c));
  }

  _index(c) {
    c.byId = new Map(c.items.map((i) => [i.id, i]));
    c.lower = c.items.map((i) => i.name.toLowerCase());
    return c;
  }

  invalidate() {
    this.mem = {}; this.info.clear();
    for (const k of ['movies', 'series']) { try { fs.unlinkSync(path.join(this.dataDir, `vod-${k}.json`)); } catch { /* ignore */ } }
  }

  async categories(kind) {
    const d = await this.ensure(kind);
    const counts = new Map();
    d.items.forEach((i) => counts.set(i.cat, (counts.get(i.cat) || 0) + 1));
    return d.categories.map((c) => ({ ...c, count: counts.get(c.name) || 0 })).filter((c) => c.count);
  }

  async query({ kind, cat, q, sort, offset = 0, limit = 60 }) {
    const d = await this.ensure(kind);
    const needle = (q || '').toLowerCase().trim();
    let list = [];
    for (let i = 0; i < d.items.length; i++) {
      const it = d.items[i];
      if (cat && it.cat !== cat) continue;
      if (needle && !d.lower[i].includes(needle)) continue;
      list.push(it);
    }
    const isMovies = kind === 'movies';
    const gross = (it) => (isMovies ? this.box.gross('m' + it.id) : null);
    const cmp = {
      boxoffice: (a, b) => (gross(b) || -1) - (gross(a) || -1) || b.rating - a.rating,
      rating: (a, b) => b.rating - a.rating,
      added: (a, b) => b.added - a.added,
      year: (a, b) => b.year - a.year,
      name: (a, b) => a.title.localeCompare(b.title),
    }[sort === 'boxoffice' && !isMovies ? 'rating' : sort] || ((a, b) => b.added - a.added);
    if (isMovies && sort === 'boxoffice') this.box.enqueue(list);   // everything in view gets looked up in the background
    list.sort(cmp);
    const items = list.slice(offset, offset + limit).map((it) => ({
      id: it.id, name: it.title || it.name, cat: it.cat, logo: it.logo, rating: it.rating, year: it.year, ext: it.ext,
      ...(isMovies ? { gross: gross(it) } : {}),
    }));
    if (isMovies && sort !== 'boxoffice') this.box.enqueue(list.slice(offset, offset + limit));
    return {
      total: list.length, items,
      boxoffice: isMovies ? { enabled: this.box.enabled(), pending: this.box.unknown(list), queued: this.box.pending(), lastError: this.box.stats.lastError } : undefined,
    };
  }

  async movie(id) {
    const d = await this.ensure('movies');
    const m = d.byId.get(String(id));
    if (!m) throw new Error('Unknown movie');
    return m;
  }

  // Season -> episode list for one series (cached briefly).
  async series(id) {
    id = String(id);
    const hit = this.info.get(id);
    if (hit && Date.now() - hit.at < INFO_TTL) return hit.v;
    this._requireXtream();
    const base = (await this.ensure('series')).byId.get(id);
    const j = await this.sources._json('get_series_info', `&series_id=${encodeURIComponent(id)}`);
    if (!j || (!j.episodes && !j.info)) throw new Error('Series not found');
    const eps = j.episodes || {};
    const bySeason = new Map();
    Object.keys(eps).forEach((k, gi) => {      // an object keyed by season number, or (some panels) an array of arrays
      const arr = eps[k];
      (Array.isArray(arr) ? arr : []).forEach((e) => {
        const season = num(e.season) || num(k) || gi + 1;
        if (!bySeason.has(season)) bySeason.set(season, []);
        bySeason.get(season).push({
          id: String(e.id), num: num(e.episode_num), title: e.title || '', ext: e.container_extension || 'mp4',
          duration: (e.info && (e.info.duration || e.info.duration_secs)) || '',
        });
      });
    });
    const seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0])
      .map(([season, episodes]) => ({ season, episodes: episodes.sort((a, b) => a.num - b.num) }));
    const info = j.info || {};
    const v = { id, name: (base && (base.title || base.name)) || info.name || 'Series', year: base ? base.year : 0,
      logo: (base && base.logo) || info.cover || '', plot: info.plot || '', seasons };
    this.info.set(id, { at: Date.now(), v });
    return v;
  }

  // Credentials are only ever resolved server-side.
  movieUrl(m) { const s = this.cfg.get().source; return `${this.sources._base()}/movie/${encodeURIComponent(s.username)}/${encodeURIComponent(s.password)}/${m.id}.${m.ext}`; }
  episodeUrl(e) { const s = this.cfg.get().source; return `${this.sources._base()}/series/${encodeURIComponent(s.username)}/${encodeURIComponent(s.password)}/${e.id}.${e.ext}`; }
}

module.exports = { Vod, BoxOffice, cleanTitle };
