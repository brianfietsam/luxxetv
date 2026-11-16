'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL = 6 * 3600 * 1000;

function b64(s) { try { return Buffer.from(s || '', 'base64').toString('utf8'); } catch { return s || ''; } }

function parseM3U(text) {
  const cats = new Map();
  const channels = [];
  let cur = null;
  const head = text.slice(0, 2000).split(/\r?\n/)[0] || '';
  const tvgUrl = ((head.match(/(?:url-tvg|x-tvg-url)="([^",]+)/i) || [])[1]) || '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const attr = (k) => (line.match(new RegExp(k + '="([^"]*)"', 'i')) || [])[1] || '';
      cur = {
        name: line.slice(line.lastIndexOf(',') + 1).trim() || attr('tvg-name'),
        cat: attr('group-title') || 'Uncategorized',
        logo: attr('tvg-logo'),
        epgId: attr('tvg-id'),
      };
    } else if (line && !line.startsWith('#') && cur) {
      cur.url = line;
      cur.id = crypto.createHash('sha1').update(line).digest('hex').slice(0, 12);
      if (!cats.has(cur.cat)) cats.set(cur.cat, { id: cur.cat, name: cur.cat });
      channels.push(cur);
      cur = null;
    }
  }
  return { categories: [...cats.values()], channels, tvgUrl };
}

class Sources {
  constructor(cfg, dataDir) {
    this.cfg = cfg;
    this.cacheFile = path.join(dataDir, 'channels-cache.json');
    this.mem = null;
  }

  _base() { return this.cfg.get().source.server.replace(/\/+$/, ''); }

  async _json(action, extra = '') {
    const s = this.cfg.get().source;
    const url = `${this._base()}/player_api.php?username=${encodeURIComponent(s.username)}&password=${encodeURIComponent(s.password)}&action=${action}${extra}`;
    const res = await fetch(url, { headers: { 'User-Agent': this.cfg.get().userAgent }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Server replied HTTP ${res.status}`);
    return res.json();
  }

  async _load() {
    const s = this.cfg.get().source;
    if (s.type === 'm3u') {
      if (!s.m3uUrl) throw new Error('No playlist URL configured');
      const res = await fetch(s.m3uUrl, { headers: { 'User-Agent': this.cfg.get().userAgent }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`Playlist download failed: HTTP ${res.status}`);
      return parseM3U(await res.text());
    }
    if (!s.server || !s.username) throw new Error('Xtream server/username not configured');
    const [cats, streams] = await Promise.all([this._json('get_live_categories'), this._json('get_live_streams')]);
    if (!Array.isArray(streams)) throw new Error('Login rejected or unexpected response from server');
    const catName = new Map((cats || []).map((c) => [String(c.category_id), c.category_name]));
    const categories = (cats || []).map((c) => ({ id: String(c.category_id), name: c.category_name }));
    const channels = streams.map((x) => ({
      id: String(x.stream_id),
      name: x.name,
      cat: catName.get(String(x.category_id)) || 'Uncategorized',
      logo: x.stream_icon || '',
      epgId: x.epg_channel_id || '',
    }));
    return { categories, channels };
  }

  async ensure(force = false) {
    if (!force && this.mem && Date.now() - this.mem.at < TTL) return this.mem;
    if (!force && !this.mem) {
      try {
        const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        if (c.sig === this._sig() && Date.now() - c.at < TTL) { this._index(c); return this.mem; }
      } catch { /* no cache */ }
    }
    const data = await this._load();
    const c = { at: Date.now(), sig: this._sig(), ...data };
    fs.writeFileSync(this.cacheFile, JSON.stringify(c));
    this._index(c);
    return this.mem;
  }

  _sig() { const s = this.cfg.get().source; return crypto.createHash('sha1').update(JSON.stringify(s)).digest('hex'); }

  _index(c) {
    c.byId = new Map(c.channels.map((ch) => [ch.id, ch]));
    c.lower = c.channels.map((ch) => ch.name.toLowerCase());
    this.mem = c;
  }

  invalidate() { this.mem = null; try { fs.unlinkSync(this.cacheFile); } catch { /* ignore */ } }

  async query({ cat, q, offset = 0, limit = 200 }) {
    const d = await this.ensure();
    const needle = (q || '').toLowerCase().trim();
    const hidden = new Set(this.cfg.get().hiddenCategories || []);
    const out = [];
    let total = 0;
    for (let i = 0; i < d.channels.length; i++) {
      const ch = d.channels[i];
      if (cat ? ch.cat !== cat : hidden.has(ch.cat)) continue;
      if (needle && !d.lower[i].includes(needle)) continue;
      if (total >= offset && out.length < limit) out.push({ id: ch.id, name: ch.name, cat: ch.cat, logo: ch.logo });
      total++;
    }
    return { total, items: out };
  }

  async getChannel(id) {
    const d = await this.ensure();
    return d.byId.get(String(id)) || null;
  }

  // Credentials are only ever resolved server-side.
  async streamUrl(id) {
    const ch = await this.getChannel(id);
    if (!ch) throw new Error('Unknown channel');
    const s = this.cfg.get().source;
    if (s.type === 'm3u') return ch.url;
    return `${this._base()}/live/${encodeURIComponent(s.username)}/${encodeURIComponent(s.password)}/${ch.id}.ts`;
  }

  async epg(id) {
    const s = this.cfg.get().source;
    if (s.type !== 'xtream') return [];
    try {
      const j = await this._json('get_short_epg', `&stream_id=${encodeURIComponent(id)}&limit=4`);
      return (j.epg_listings || []).map((e) => ({
        title: b64(e.title), desc: b64(e.description),
        start: Number(e.start_timestamp) * 1000, end: Number(e.stop_timestamp) * 1000,
      }));
    } catch { return []; }
  }
}

module.exports = { Sources, parseM3U };
