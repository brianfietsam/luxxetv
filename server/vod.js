'use strict';
// Xtream VOD: movie + TV-series catalogs, series episode lists, stream URLs, box-office enrichment (TMDB),
// and matching the movie library against TMDB movies for the release lists and watchlist.
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

// Pre-release rips that show up on providers before the real digital release; never auto-download these.
const LOW_QUALITY = /\b(cam|camrip|hdcam|hd-?cam|ts|hdts|hd-?ts|telesync|telecine|tc|hdtc|scr|screener)\b/i;
const NOISE = /\b(4k|uhd|2160p|1080p|720p|480p|fhd|hd|sd|hq|hevc|h ?26[45]|x26[45]|hdr10?|dolby vision|atmos|web-?dl|web-?rip|webrip|bluray|blu-ray|brrip|bdrip|remux|multi|multisub|multi-sub|subs|subbed|dub|dubbed|vost|vostfr|imax|extended|unrated|directors cut|remastered)\b/gi;
// Leading provider tags such as "EN - ", "|EN| ", "[4K] ", "NF: ", "US| ".
// Titles like "TRON: Legacy" also look like a tag, so matching tries the name with and without prefixes.
const PREFIX = /^\s*(?:[|[({]\s*[^|\])}]{1,14}\s*[|\])}]|[A-Z0-9]{2,5}(?:[-+][A-Z0-9]{2,5})?(?:\s*[:|•»]|\s+-|-\s+))\s*/;

function stripPrefixes(s) {
  let prev;
  do { prev = s; s = s.replace(PREFIX, ''); } while (s !== prev && s);
  return s;
}

function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}

function matchParts(s) {
  const yearM = s.match(/[([]\s*((?:19|20)\d{2})\s*[)\]]/) || s.match(/(?:^|[\s.-])((?:19|20)\d{2})(?=[\s.)\]-]*(?:$|[[(|]|\b(?:4k|uhd|fhd|hd|1080p|720p|2160p|multi)\b))/i);
  const year = yearM ? +yearM[1] : null;
  if (yearM) s = s.slice(0, yearM.index) + ' ' + s.slice(yearM.index + yearM[0].length);
  s = s.replace(/[[({][^\])}]*[\])}]/g, ' ').replace(/\./g, ' ').replace(NOISE, ' ');
  return { title: norm(s), year };
}

// "EN - Dune: Part Two (2024) [4K]" -> { title: "dune part two", titles: [...], year: 2024, uhd: true }
function parseVodName(name) {
  const raw = String(name || '');
  const a = matchParts(stripPrefixes(raw)), b = matchParts(raw);
  return { title: a.title, titles: [...new Set([a.title, b.title].filter(Boolean))], year: a.year || b.year,
    uhd: /\b(4k|uhd|2160p)\b/i.test(raw), lowQuality: LOW_QUALITY.test(raw.replace(/[._]/g, ' ')) };
}

// Best VOD entry for a movie, or null. tmdb id match wins; otherwise exact normalised title (+ year when known).
function findMatch(movie, vodItems) {
  const titles = new Set([norm(movie.title), norm(movie.originalTitle)].filter(Boolean));
  let best = null, bestScore = -Infinity;
  for (const v of vodItems) {
    if (v.p.lowQuality) continue;
    let score;
    if (v.tmdb && String(v.tmdb) === String(movie.id)) score = 100;
    else {
      if (!v.p.titles.some((t) => titles.has(t))) continue;
      if (movie.year && v.p.year) { if (Math.abs(movie.year - v.p.year) > 1) continue; score = 20; }
      else score = 5;   // no year on one side: title-only match
    }
    if (v.p.uhd) score -= 3;        // prefer 1080p over huge 4K files when both exist
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}

class BoxOffice {
  constructor({ tmdb, dataDir }) {
    this.tmdb = tmdb;
    this.file = path.join(dataDir, 'boxoffice.json');
    this.map = {};
    try { this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.queue = []; this.queued = new Set(); this.running = 0; this.saveT = null;
    this.stats = { done: 0, failed: 0, lastError: '' };
  }

  enabled() { return this.tmdb.configured(); }
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

  async _lookup(m) {
    let tmdb = m.tmdb;
    if (!tmdb) {
      const { title, year } = cleanTitle(m.name);
      if (!title) return void (this.map['m' + m.id] = { rev: 0, at: Date.now() });
      const r = await this.tmdb.find('/search/movie', { query: title, ...(year || m.year ? { year: year || m.year } : {}) });
      const hit = r && r.results && r.results[0];
      tmdb = hit && hit.id;
    }
    let rev = 0;
    if (tmdb) { const d = await this.tmdb.find('/movie/' + encodeURIComponent(tmdb)); rev = d ? num(d.revenue) : 0; }
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
  constructor({ cfg, sources, tmdb, dataDir }) {
    this.cfg = cfg; this.sources = sources; this.dataDir = dataDir;
    this.mem = {};
    this.loading = new Map();
    this.info = new Map();
    this.box = new BoxOffice({ tmdb, dataDir });
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
        ext: String(x.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4',
        tmdb: [x.tmdb, x.tmdb_id].map((v) => String(v || '')).find((v) => v && v !== '0') || '', title,
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
    // Pages, badges and the watchlist can all ask at once: share one provider request.
    const key = kind + sig;
    if (!this.loading.has(key)) {
      this.loading.set(key, (async () => {
        const data = await this._load(kind);
        const c = { at: Date.now(), sig, ...data };
        fs.writeFileSync(file, JSON.stringify(c));
        return (this.mem[kind] = this._index(c));
      })().finally(() => this.loading.delete(key)));
    }
    return this.loading.get(key);
  }

  // ---- the movie catalog in the shape findMatch() wants ----
  _matchable(d) {
    if (!d.matchable) d.matchable = d.items.map((i) => ({ streamId: i.id, name: String(i.name || ''), ext: i.ext, tmdb: i.tmdb, p: parseVodName(i.name) }));
    return { at: d.at, items: d.matchable };
  }

  async library(force = false) { return this._matchable(await this.ensure('movies', force)); }

  // Already-loaded, still-current library, or null. Never touches the network.
  cachedLibrary() {
    const m = this.mem.movies;
    return m && Date.now() - m.at < TTL && m.sig === this.sources._sig() ? this._matchable(m) : null;
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
  movieUrl(m) { return this.sources.vodUrl(m.id, m.ext); }
  episodeUrl(e) { const s = this.cfg.get().source; return `${this.sources._base()}/series/${encodeURIComponent(s.username)}/${encodeURIComponent(s.password)}/${e.id}.${e.ext}`; }
}

module.exports = { Vod, BoxOffice, cleanTitle, parseVodName, findMatch, norm };
