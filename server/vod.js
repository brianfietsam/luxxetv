'use strict';
// Xtream Codes VOD (movie) library: download the catalogue and match it against TMDB movies.

const TTL = 3 * 3600 * 1000;

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

function cleanTitle(s) {
  const yearM = s.match(/[([]\s*((?:19|20)\d{2})\s*[)\]]/) || s.match(/(?:^|[\s.-])((?:19|20)\d{2})(?=[\s.)\]-]*(?:$|[[(|]|\b(?:4k|uhd|fhd|hd|1080p|720p|2160p|multi)\b))/i);
  const year = yearM ? +yearM[1] : null;
  if (yearM) s = s.slice(0, yearM.index) + ' ' + s.slice(yearM.index + yearM[0].length);
  s = s.replace(/[[({][^\])}]*[\])}]/g, ' ').replace(/\./g, ' ').replace(NOISE, ' ');
  return { title: norm(s), year };
}

// "EN - Dune: Part Two (2024) [4K]" -> { title: "dune part two", titles: [...], year: 2024, uhd: true }
function parseVodName(name) {
  const raw = String(name || '');
  const a = cleanTitle(stripPrefixes(raw)), b = cleanTitle(raw);
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

class Vod {
  constructor({ sources }) {
    this.sources = sources;
    this.mem = null; this.loading = null; this.error = null;
  }

  async ensure(force = false) {
    if (!force && this.mem && Date.now() - this.mem.at < TTL) return this.mem;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const list = await this.sources.vodStreams();
        const items = list.map((x) => ({
          streamId: String(x.stream_id), name: String(x.name || ''), ext: String(x.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4',
          tmdb: x.tmdb || x.tmdb_id || '', added: (+x.added || 0) * 1000, p: parseVodName(x.name),
        }));
        this.mem = { at: Date.now(), items };
        this.error = null;
        return this.mem;
      } catch (e) { this.error = e.message; throw e; }
      finally { this.loading = null; }
    })();
    return this.loading;
  }

  // Non-throwing lookup used to badge movie lists; returns null when the library is unavailable.
  async tryMatch(movie) {
    try { const d = await this.ensure(); return findMatch(movie, d.items); } catch { return null; }
  }

  invalidate() { this.mem = null; }
}

module.exports = { Vod, parseVodName, findMatch, norm };
