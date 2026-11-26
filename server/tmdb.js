'use strict';
// TMDB client: theatrical / streaming (digital) release dates for upcoming movies.
// Docs: https://developer.themoviedb.org/reference/discover-movie
const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const LIST_TTL = 6 * 3600 * 1000;
const DATES_TTL = 24 * 3600 * 1000;
// Typical gap between a theatrical opening and the digital (PVOD) release, used only for a labelled estimate.
const EST_DIGITAL_DAYS = 45;
const RT = { premiere: 1, limited: 2, theatrical: 3, digital: 4, physical: 5, tv: 6 };

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

class Tmdb {
  constructor({ cfg, dataDir }) {
    this.cfg = cfg;
    this.base = (process.env.LUXXETV_TMDB_BASE || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
    this.file = path.join(dataDir, 'tmdb-cache.json');
    this.lists = new Map();   // key -> { at, items }
    this.dates = new Map();   // `${id}:${region}` -> { at, theatrical, digital, physical, certification }
    try {
      const c = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(c.dates || {})) if (Date.now() - v.at < DATES_TTL) this.dates.set(k, v);
    } catch { /* no cache yet */ }
    this.saveTimer = null;
  }

  configured() { return !!(this.cfg.get().tmdbKey || '').trim(); }
  region() { return ((this.cfg.get().tmdbRegion || 'US').trim().toUpperCase().slice(0, 2)) || 'US'; }

  async _get(p, params = {}) {
    const key = (this.cfg.get().tmdbKey || '').trim();
    if (!key) throw new Error('Add a free TMDB API key in Settings → Movies to see upcoming movies');
    const q = new URLSearchParams({ language: 'en-US', ...params });
    const headers = { Accept: 'application/json' };
    // v4 "API Read Access Token" (a JWT) goes in the header; a 32-char v3 key goes in the query.
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; else q.set('api_key', key);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}${p}?${q}`, { headers, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
      if (res.status === 401) throw new Error('TMDB rejected the API key — check it in Settings → Movies');
      if (!res.ok) throw new Error(`TMDB replied HTTP ${res.status}`);
      return res.json();
    }
  }

  _scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { fs.writeFileSync(this.file, JSON.stringify({ dates: Object.fromEntries(this.dates) })); } catch { /* ignore */ }
    }, 2000);
    this.saveTimer.unref();
  }

  // Earliest release of each type in the configured region (falls back to the US, then any country).
  async releaseDates(id) {
    const region = this.region();
    const k = `${id}:${region}`;
    const hit = this.dates.get(k);
    if (hit && Date.now() - hit.at < DATES_TTL) return hit;
    const j = await this._get(`/movie/${id}/release_dates`);
    const pick = (cc) => (j.results || []).find((r) => r.iso_3166_1 === cc);
    const rows = (pick(region) || pick('US') || { release_dates: [] }).release_dates || [];
    const first = (...types) => {
      const t = rows.filter((r) => types.includes(r.type)).map((r) => Date.parse(r.release_date)).filter((n) => n > 0);
      return t.length ? Math.min(...t) : null;
    };
    const out = {
      at: Date.now(),
      theatrical: first(RT.theatrical) || first(RT.limited, RT.premiere),
      digital: first(RT.digital),
      physical: first(RT.physical),
      certification: (rows.find((r) => r.certification) || {}).certification || '',
    };
    this.dates.set(k, out);
    this._scheduleSave();
    return out;
  }

  _shape(m, d) {
    const theatrical = (d && d.theatrical) || (m.release_date ? Date.parse(m.release_date) : null);
    const digital = d && d.digital;
    return {
      id: m.id,
      title: m.title,
      originalTitle: m.original_title,
      year: (m.release_date || '').slice(0, 4) ? +(m.release_date || '').slice(0, 4) : (theatrical ? new Date(theatrical).getUTCFullYear() : null),
      overview: m.overview || '',
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : '',
      popularity: m.popularity || 0,
      rating: m.vote_count >= 20 ? m.vote_average : null,
      theatrical,
      digital,
      digitalEstimate: !digital && theatrical ? theatrical + EST_DIGITAL_DAYS * DAY : null,
      physical: d && d.physical,
      certification: (d && d.certification) || '',
    };
  }

  async _withDates(movies) {
    const out = new Array(movies.length);
    let i = 0;
    const worker = async () => {
      while (i < movies.length) {
        const n = i++;
        let d = null;
        try { d = await this.releaseDates(movies[n].id); } catch { /* keep the list even if one lookup fails */ }
        out[n] = this._shape(movies[n], d);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return out;
  }

  async _discover(params, pages) {
    const seen = new Set(), all = [];
    for (let page = 1; page <= pages; page++) {
      const j = await this._get('/discover/movie', { include_adult: 'false', include_video: 'false', region: this.region(), sort_by: 'popularity.desc', page: String(page), ...params });
      for (const m of j.results || []) if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
      if (page >= (j.total_pages || 1)) break;
    }
    return all;
  }

  // theaters: in cinemas now · upcoming: major movies coming to cinemas · streaming: digital releases (recent + upcoming)
  async list(kind) {
    const k = `${kind}:${this.region()}`;
    const hit = this.lists.get(k);
    if (hit && Date.now() - hit.at < LIST_TTL) return hit.items;
    const now = Date.now();
    let raw;
    if (kind === 'theaters') {
      raw = await this._discover({ with_release_type: `${RT.limited}|${RT.theatrical}`, 'release_date.gte': ymd(now - 50 * DAY), 'release_date.lte': ymd(now) }, 2);
    } else if (kind === 'upcoming') {
      // "Major": popularity-ranked, with a vote/popularity floor to drop tiny releases.
      raw = (await this._discover({ with_release_type: `${RT.limited}|${RT.theatrical}`, 'release_date.gte': ymd(now + DAY), 'release_date.lte': ymd(now + 180 * DAY) }, 3))
        .filter((m, idx) => idx < 20 || (m.popularity || 0) >= 5);
    } else if (kind === 'streaming') {
      raw = await this._discover({ with_release_type: String(RT.digital), 'release_date.gte': ymd(now - 30 * DAY), 'release_date.lte': ymd(now + 90 * DAY) }, 3);
    } else throw new Error('Unknown list');
    let items = await this._withDates(raw);
    const key = kind === 'streaming' ? (m) => m.digital || m.digitalEstimate || Infinity : (m) => m.theatrical || Infinity;
    if (kind === 'theaters') items = items.filter((m) => !m.theatrical || m.theatrical <= now + DAY);
    if (kind === 'upcoming') items = items.filter((m) => !m.theatrical || m.theatrical > now - DAY);
    items.sort((a, b) => key(a) - key(b));
    this.lists.set(k, { at: Date.now(), items });
    return items;
  }

  async search(q) {
    const j = await this._get('/search/movie', { query: String(q).slice(0, 100), include_adult: 'false' });
    return this._withDates((j.results || []).slice(0, 20));
  }

  async movie(id) {
    const m = await this._get(`/movie/${encodeURIComponent(id)}`);
    let d = null; try { d = await this.releaseDates(m.id); } catch { /* optional */ }
    return this._shape(m, d);
  }

  invalidate() { this.lists.clear(); }
}

module.exports = { Tmdb };
