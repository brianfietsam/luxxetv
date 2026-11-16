'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL = 6 * 3600 * 1000;
const PAST = 2 * 3600 * 1000;       // keep programmes that ended within the last 2h
const FUTURE = 75 * 3600 * 1000;    // ...and up to ~3 days ahead

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] || m;
  });

// "20261115200000 +0100" -> epoch ms
function xmltvTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-])?(\d\d)?(\d\d)?/.exec(s || '');
  if (!m) return NaN;
  const off = m[7] ? (m[7] === '-' ? -1 : 1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000 : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - off;
}

const attr = (s, k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(s) || [])[1];
const tag = (s, k) => { const m = new RegExp(`<${k}\\b[^>]*>([\\s\\S]*?)</${k}>`).exec(s); return m ? unxml(m[1]).trim() : ''; };

class Epg {
  constructor({ cfg, sources, dataDir }) {
    this.cfg = cfg; this.sources = sources;
    this.file = path.join(dataDir, 'epg-cache.json');
    this.byChan = null; this.at = 0; this.loading = null; this.error = null; this.lastTry = 0;
  }

  url() {
    const c = this.cfg.get();
    if (c.epgUrl) return c.epgUrl;
    const s = c.source;
    if (s.type === 'xtream') {
      return `${s.server.replace(/\/+$/, '')}/xmltv.php?username=${encodeURIComponent(s.username)}&password=${encodeURIComponent(s.password)}`;
    }
    return (this.sources.mem && this.sources.mem.tvgUrl) || '';
  }

  _sig() { return crypto.createHash('sha1').update(this.url()).digest('hex'); }

  _fromDisk() {
    try {
      const c = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (c.sig !== this._sig()) return;
      this.byChan = new Map(c.data); this.at = c.at;
    } catch { /* none */ }
  }

  invalidate() {
    this.byChan = null; this.at = 0; this.error = null; this.lastTry = 0;
    try { fs.unlinkSync(this.file); } catch { /* ignore */ }
  }

  status() {
    let n = 0; if (this.byChan) for (const v of this.byChan.values()) n += v.length;
    return { ready: !!this.byChan, loading: !!this.loading, error: this.error, updated: this.at, programmes: n, channels: this.byChan ? this.byChan.size : 0 };
  }

  // Kicks off a background (re)download when needed; never blocks the caller.
  ensureStarted(force = false) {
    if (!this.byChan && !this.loading) this._fromDisk();
    const stale = !this.at || Date.now() - this.at > TTL;
    if ((force || stale) && !this.loading && (force || Date.now() - this.lastTry > 5 * 60000)) {
      this.lastTry = Date.now();
      this.loading = this._load().then(() => { this.error = null; }).catch((e) => { this.error = e.message; }).finally(() => { this.loading = null; });
    }
    return this.status();
  }

  async _load() {
    const d = await this.sources.ensure();
    const url = this.url();
    if (!url) throw new Error('No guide (XMLTV) URL - set one in Settings');
    const wanted = new Set(d.channels.map((c) => (c.epgId || '').toLowerCase()).filter(Boolean));
    if (!wanted.size) throw new Error('This playlist has no guide IDs (epg_channel_id / tvg-id)');
    const res = await fetch(url, { headers: { 'User-Agent': this.cfg.get().userAgent }, signal: AbortSignal.timeout(15 * 60000) });
    if (!res.ok) throw new Error(`Guide download failed: HTTP ${res.status}`);
    let stream = res.body;
    if (/\.gz(\?|$)/i.test(url) && !res.headers.get('content-encoding')) stream = stream.pipeThrough(new DecompressionStream('gzip'));

    const now = Date.now(), lo = now - PAST, hi = now + FUTURE;
    const map = new Map();
    let buf = '';
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
      let m, last = 0;
      while ((m = re.exec(buf))) {
        last = re.lastIndex;
        const ch = (attr(m[1], 'channel') || '').toLowerCase();
        if (!wanted.has(ch)) continue;
        const s = xmltvTime(attr(m[1], 'start')), e = xmltvTime(attr(m[1], 'stop'));
        if (!(e > s) || e < lo || s > hi) continue;
        let arr = map.get(ch); if (!arr) map.set(ch, (arr = []));
        arr.push([s, e, tag(m[2], 'title'), tag(m[2], 'desc').slice(0, 400)]);
      }
      buf = buf.slice(last);
      if (!buf.includes('<programme')) buf = buf.slice(-20);
    }
    for (const arr of map.values()) arr.sort((a, b) => a[0] - b[0]);
    if (!map.size) throw new Error('Guide downloaded but contained no matching programmes');
    this.byChan = map; this.at = Date.now();
    fs.writeFileSync(this.file, JSON.stringify({ at: this.at, sig: this._sig(), data: [...map] }));
  }

  // programmes overlapping [from, to) for a channel's guide id
  get(epgId, from, to) {
    const arr = this.byChan && this.byChan.get((epgId || '').toLowerCase());
    if (!arr) return [];
    return arr.filter((p) => p[1] > from && p[0] < to).map((p) => ({ s: p[0], e: p[1], t: p[2], d: p[3] }));
  }
}

module.exports = { Epg, xmltvTime };
