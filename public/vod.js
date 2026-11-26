'use strict';
/* LuxxeTV movies, TV shows and downloads. Loaded after app.js and shares its helpers ($, el, api, toast, view, openStage...). */

const money = (n) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + Math.round(n / 1e6) + 'M' : '$' + Math.round(n / 1e3) + 'K');
const LIB = {
  movies: { kind: 'movies', n: 0, init: false, tok: 0 },
  shows: { kind: 'series', n: 0, init: false, tok: 0 },
};
let libPoll;

async function openLib(v) {
  const L = LIB[v];
  if (L.init) return;
  L.init = true;
  $(`#${v}Sort`).value = prefs.get('sort.' + v, v === 'movies' ? 'boxoffice' : 'added');
  try {
    const cs = await api('/api/vod/categories?kind=' + L.kind);
    $(`#${v}Cat`).replaceChildren(el('option', { value: '', textContent: 'all categories' }),
      ...cs.sort((a, b) => a.name.localeCompare(b.name)).map((c) => el('option', { value: c.name, textContent: `${c.name} (${c.count})` })));
  } catch (e) { $(`#${v}Note`).textContent = e.message; L.init = false; return; }
  const reload = () => { prefs.set('sort.' + v, $(`#${v}Sort`).value); loadLib(v, true); };
  $(`#${v}Cat`).onchange = reload; $(`#${v}Sort`).onchange = reload;
  let t; $(`#${v}Q`).oninput = () => { clearTimeout(t); t = setTimeout(reload, 300); };
  $(`#${v}More`).onclick = () => loadLib(v, false);
  loadLib(v, true);
}

// reset: start over; keep: refresh what is already shown in place (used while box-office numbers arrive)
async function loadLib(v, reset, keep) {
  const L = LIB[v], PAGE = 60, tok = ++L.tok;
  clearTimeout(libPoll);
  const offset = reset || keep ? 0 : L.n;
  const limit = keep ? Math.max(L.n, PAGE) : PAGE;
  const qs = `kind=${L.kind}&sort=${$(`#${v}Sort`).value}&cat=${encodeURIComponent($(`#${v}Cat`).value)}&q=${encodeURIComponent($(`#${v}Q`).value.trim())}&offset=${offset}&limit=${limit}`;
  let r;
  try { r = await api('/api/vod/items?' + qs); } catch (e) { $(`#${v}Note`).textContent = e.message; return; }
  if (tok !== L.tok) return;
  const grid = $(`#${v}Grid`);
  if (reset || keep) grid.replaceChildren();
  r.items.forEach((it) => grid.append(libCard(v, it)));
  L.n = (reset || keep ? 0 : L.n) + r.items.length;
  $(`#${v}More`).hidden = L.n >= r.total;
  if (!r.total) grid.replaceChildren(el('div', { className: 'empty' }, el('div', { className: 'big', textContent: 'nothing found' })));
  let note = `${r.total} ${v === 'movies' ? 'movies' : 'shows'}`;
  const bo = r.boxoffice;
  if (bo && $(`#${v}Sort`).value === 'boxoffice') {
    if (!bo.enabled) note += ' · add a TMDB API key in Settings to rank by box office (showing by rating for now)';
    else if (bo.pending) { note += ` · looking up box office numbers for ${bo.pending} of these…`; libPoll = setTimeout(() => view === v && loadLib(v, false, true), 3500); }
    else if (bo.lastError) note += ' · box office lookup problem: ' + bo.lastError;
  }
  $(`#${v}Note`).textContent = note;
}

function libCard(v, it) {
  const po = el('div', { className: 'po' }, el('span', { textContent: it.name }));
  if (it.logo) po.append(el('img', { src: it.logo, loading: 'lazy', alt: '', referrerPolicy: 'no-referrer', onerror() { this.remove(); } }));
  const sub = [it.year || '', it.rating ? '★ ' + it.rating.toFixed(1) : ''].filter(Boolean).join(' · ');
  return el('button', { type: 'button', className: 'card', title: it.name, onclick: () => openSheet(v, it) }, po,
    el('div', { className: 'ct' }, el('b', { textContent: it.name }), sub ? el('span', { textContent: sub }) : null,
      it.gross ? el('span', { className: 'gross', textContent: money(it.gross) + ' box office' }) : null));
}

let sheetTok = 0;
const sheetClose = () => { sheetTok++; $('#sheet').hidden = true; };
$('#shClose').onclick = sheetClose;
$('#sheet').addEventListener('pointerdown', (e) => { if (e.target.id === 'sheet') sheetClose(); });

// Open the info panel with what is already known; the caller fills in the rest as it arrives.
// Returns a check that is false once the panel was closed or reused.
function showSheet(title, { poster = '', meta = [], plot = '', actions = [] } = {}) {
  const tok = ++sheetTok;
  $('#shTitle').textContent = title;
  $('#shTagline').textContent = '';
  sheetPoster(poster);
  $('#shMeta').textContent = meta.filter(Boolean).join(' · ');
  $('#shActions').replaceChildren(...actions);
  $('#shPlot').textContent = plot;
  $('#shFacts').replaceChildren(); $('#shBody').replaceChildren();
  $('#sheet').hidden = false;
  $('#sheet .sh-in').scrollTop = 0;
  return () => tok === sheetTok;
}
function sheetPoster(src) {
  const img = $('#shPoster');
  img.hidden = !src;
  if (!src) return img.removeAttribute('src');
  img.onerror = () => { img.hidden = true; };
  img.src = src;
}
function sheetFacts(pairs) {
  $('#shFacts').replaceChildren(...pairs.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
}
const runtime = (min) => (min ? (min >= 60 ? `${Math.floor(min / 60)}h ` : '') + `${min % 60}m` : '');
const trailerLink = (url) => (url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: 'watch on YouTube' }) : '');

async function queue(body, what) {
  try {
    const r = await api('/api/downloads', { method: 'POST', body });
    toast(`${r.queued} ${r.queued === 1 ? 'download' : 'downloads'} queued: ${what}`);
  } catch (e) { toast(e.message, true); }
}

async function openSheet(v, it) {
  const meta = [it.year || '', it.rating ? '★ ' + it.rating.toFixed(1) : '', it.gross ? money(it.gross) + ' worldwide box office' : ''];
  if (v === 'movies') {
    const current = showSheet(it.name, { poster: it.logo, meta, plot: 'loading movie info…', actions: [
      el('button', { type: 'button', className: 'solid', textContent: '▶ watch now', onclick: () => { sheetClose(); playVod('m-' + it.id, it.ext, it.name); } }),
      el('button', { type: 'button', textContent: '⬇ download', onclick: () => { queue({ type: 'movie', id: it.id }, it.name); sheetClose(); } })] });
    let m;
    try { m = await api('/api/vod/movie/' + encodeURIComponent(it.id)); }
    catch (e) { if (current()) $('#shPlot').textContent = 'Movie info is unavailable: ' + e.message; return; }
    if (!current()) return;
    if (m.poster) sheetPoster(m.poster);
    $('#shTagline').textContent = m.tagline;
    $('#shMeta').textContent = [m.year || '', m.certification, runtime(m.runtime), m.rating ? '★ ' + m.rating.toFixed(1) : ''].filter(Boolean).join(' · ');
    $('#shPlot').textContent = m.plot || 'No description available.';
    sheetFacts([['Genre', m.genres], ['Director', m.director], ['Cast', m.cast], ['Box office', m.gross ? money(m.gross) + ' worldwide' : ''],
      ['Category', m.category], ['Your copy', `${m.providerName} (${m.ext.toUpperCase()})`], ['Trailer', trailerLink(m.trailer)]]);
    return;
  }
  const current = showSheet(it.name, { poster: it.logo, meta });
  $('#shBody').append(el('div', { className: 'muted', textContent: 'loading seasons…' }));
  try {
    const s = await api('/api/vod/series/' + encodeURIComponent(it.id));
    if (!current()) return;      // user closed it or opened something else meanwhile
    const total = s.seasons.reduce((n, x) => n + x.episodes.length, 0);
    $('#shPlot').textContent = s.plot;
    sheetFacts([['Genre', s.genres], ['Director', s.director], ['Cast', s.cast]]);
    $('#shMeta').textContent = [...meta, `${s.seasons.length} seasons`, `${total} episodes`].filter(Boolean).join(' · ');
    const flat = s.seasons.flatMap((se) => se.episodes.map((e) => ({ ...e, season: se.season })));
    const watch = (e) => { sheetClose(); playEpisode(it, flat, e); };
    $('#shActions').replaceChildren(
      el('button', { type: 'button', textContent: `⬇ download entire show (${total} episodes)`, onclick: () => { queue({ type: 'series', seriesId: it.id }, it.name); sheetClose(); } }));
    $('#shBody').replaceChildren(
      ...s.seasons.map((se) => el('div', { className: 'season' },
        el('div', { className: 'sh' }, el('b', { textContent: `Season ${se.season} · ${se.episodes.length} episodes` }),
          el('button', { type: 'button', textContent: '⬇ season', onclick: () => queue({ type: 'season', seriesId: it.id, season: se.season }, `${it.name} season ${se.season}`) })),
        ...se.episodes.map((e) => el('div', { className: 'ep' },
          el('span', { textContent: `${e.num}. ${e.title}`, title: e.title }),
          el('button', { type: 'button', className: 'solid', textContent: '▶', 'aria-label': 'Watch episode ' + e.num, onclick: () => watch({ ...e, season: se.season }) }),
          el('button', { type: 'button', textContent: '⬇', 'aria-label': 'Download episode ' + e.num, onclick: () => queue({ type: 'episode', seriesId: it.id, episodeId: e.id }, `${it.name} S${se.season}E${e.num}`) }))))));
  } catch (e) { if (current()) $('#shBody').replaceChildren(el('div', { className: 'err', textContent: e.message })); }
}

/* ---------- downloads ---------- */
let dlTimer, dlSig = '';
const DL_ORDER = { downloading: 0, shrinking: 1, queued: 2, 'shrink-queued': 3, failed: 4, done: 5, cancelled: 6 };
const percent = (j) => (j.status === 'shrinking' ? j.progress * 100 : j.total ? Math.min(100, j.bytes / j.total * 100) : 0);
function dlInfo(j) {
  const size = `${fmtSize(j.bytes)}${j.total ? ' of ' + fmtSize(j.total) : ''}`;
  const from = j.watchlist ? 'watchlist · ' : '';
  if (j.status === 'downloading') return `${from}downloading ${j.total ? Math.floor(percent(j)) + '% · ' : ''}${size}`;
  if (j.status === 'queued') return from + 'waiting in the queue';
  if (j.status === 'shrink-queued') return `downloaded (${fmtSize(j.bytes)}) · waiting to shrink`;
  if (j.status === 'shrinking') return `shrinking ${Math.floor(percent(j))}% · this can take a while`;
  if (j.status === 'failed') return from + j.error;
  return j.note || j.status + (j.status === 'done' ? ' · ' + fmtSize(j.bytes) : '');
}
const dlButton = (textContent, fn, className = '') => el('button', { type: 'button', textContent, className, onclick: async () => {
  try { await fn(); } catch (e) { toast(e.message, true); }
  dlSig = ''; loadDownloads();
} });
const post = (url, body) => api(url, { method: 'POST', body });

function dlRow(j) {
  const busy = j.status === 'downloading' || j.status === 'shrinking';
  const waiting = j.status === 'queued' || j.status === 'shrink-queued';
  const acts = [];
  if (j.watchlist) {
    if (j.status === 'failed') acts.push(dlButton('retry', () => post(`/api/watchlist/${j.tmdbId}/retry`)));
    acts.push(dlButton('cancel', async () => { if (confirm(`Cancel and remove “${j.title}” from your watchlist?`)) await api('/api/watchlist/' + j.tmdbId, { method: 'DELETE' }); }));
  } else {
    if (j.status === 'failed') acts.push(dlButton('retry', () => post(`/api/downloads/${j.id}/retry`)));
    if (busy || waiting) acts.push(dlButton(j.status.startsWith('shrink') ? 'keep original' : 'cancel', () => post(`/api/downloads/${j.id}/cancel`)));
  }
  const bar = el('div', { className: 'bar-t' }, el('i'));
  bar.firstChild.style.setProperty('--p', percent(j) + '%');
  const row = el('div', { className: 'item' },
    el('div', { className: 't' }, el('b', { textContent: j.title }),
      el('div', { className: 'info ' + (j.status === 'failed' ? 'err' : 'muted'), textContent: dlInfo(j) }), busy ? bar : null),
    ...acts);
  row.dataset.job = j.id;
  return row;
}

async function loadDownloads() {
  clearTimeout(dlTimer);
  let d;
  try { d = await api('/api/downloads'); } catch { if (view === 'downloads') dlTimer = setTimeout(loadDownloads, 5000); return; }
  const watched = (d.watch || []).map((w) => ({
    id: 'w' + w.tmdbId, tmdbId: w.tmdbId, watchlist: true, title: w.title + (w.year ? ` (${w.year})` : ''), status: w.status, bytes: w.bytes || 0, total: w.total || 0, error: w.error,
  }));
  // In progress and waiting first, in the order they will run; then problems and finished ones, newest first.
  const running = (j) => DL_ORDER[j.status] <= 3;
  const queueList = [...d.jobs.filter(running).reverse(), ...watched, ...d.jobs.filter((j) => !running(j))]
    .sort((a, b) => DL_ORDER[a.status] - DL_ORDER[b.status]);
  const active = queueList.some(running);
  $('#dlSpace').textContent = d.free == null ? '' : `${fmtSize(d.free)} free on the download drive`;
  // Rebuild only when something starts, stops or disappears; otherwise just update the numbers so taps are not lost.
  const sig = JSON.stringify([queueList.map((j) => [j.id, j.status]), d.partials, d.files.map((f) => [f.rel, f.size, f.shrinkable])]);
  if (sig === dlSig && $('#dlJobs').children.length) {
    for (const j of queueList) {
      const row = document.querySelector(`[data-job="${j.id}"]`);
      if (!row) continue;
      row.querySelector('.info').textContent = dlInfo(j);
      row.querySelector('.bar-t i')?.style.setProperty('--p', percent(j) + '%');
    }
  } else {
    dlSig = sig;
    renderDownloads(d, queueList);
  }
  if (view === 'downloads') dlTimer = setTimeout(loadDownloads, active ? 1500 : 8000);
}

function renderDownloads(d, queueList) {
  $('#dlJobs').replaceChildren(...(queueList.length ? queueList.map(dlRow)
    : [el('div', { className: 'empty' }, el('div', { className: 'big', textContent: 'no downloads yet' }), el('p', { textContent: 'Open a movie or show and tap download.' }))]));
  const partials = d.partials || [];
  $('#dlPartialBox').hidden = !partials.length;
  $('#dlPartials').replaceChildren(...partials.map((f) => el('div', { className: 'item' },
    el('div', { className: 't' }, el('b', { textContent: f.name }), el('div', { className: 'muted', textContent: `${fmtSize(f.size)} saved so far · ${stamp(f.mtime)}` })),
    f.resumable ? dlButton('resume', () => post('/api/downloads/partial/resume', { f: f.rel }), 'solid') : null,
    dlButton('delete', async () => { if (confirm(`Delete the unfinished download of ${f.name}?`)) await api('/api/downloads/partial?f=' + encodeURIComponent(f.rel), { method: 'DELETE' }); }))));
  const url = (f, dl) => `/dl?f=${encodeURIComponent(f.rel)}${dl ? '&download=1' : ''}`;
  const shrinking = new Set(d.jobs.filter((j) => j.status.startsWith('shrink')).map((j) => j.rel.replace(/\\/g, '/')));
  $('#dlFiles').replaceChildren(...(d.files.length ? d.files.map((f) => el('div', { className: 'item' },
    el('div', { className: 't' }, el('b', { textContent: f.rel.replace(/\.[^.]+$/, '') }), el('div', { className: 'muted', textContent: `${fmtSize(f.size)} · ${stamp(f.mtime)}` })),
    f.playable ? el('button', { type: 'button', className: 'solid', textContent: '▶ play', onclick: () => {
      stageChan = null;
      openStage(f.name.replace(/\.[^.]+$/, ''), [el('a', { className: 'btn', href: url(f, true), textContent: 'download' })], url(f));
    } }) : null,
    el('a', { className: 'btn', href: url(f, true), textContent: 'save' }),
    f.shrinkable && !shrinking.has(f.rel) ? dlButton('shrink', async () => {
      if (confirm(`Shrink ${f.name} (${fmtSize(f.size)})?\n\nThe original is replaced by a smaller MP4. This cannot be undone.`)) await post('/api/downloads/shrink', { f: f.rel });
    }) : null,
    dlButton('delete', async () => { if (confirm('Delete ' + f.name + '?')) await api('/api/downloads/file?f=' + encodeURIComponent(f.rel), { method: 'DELETE' }); })))
    : [el('div', { className: 'muted', textContent: 'Nothing saved yet.' })]));
}
$('#dlClear').onclick = async () => { await api('/api/downloads/clear', { method: 'POST' }); loadDownloads(); };

/* ---------- watch in the browser ---------- */
// Plain mp4/webm is streamed straight from the provider (seekable). Anything else, or anything the browser
// rejects, is converted to H.264/AAC HLS by ffmpeg on the PC. "no sound?" switches to the converted stream manually.
function playVod(key, ext, title, extraActions = []) {
  const q = ext ? '?ext=' + encodeURIComponent(ext) : '';
  const direct = `/vodplay/${key}/direct${q}`, hlsUrl = `/vodplay/${key}/index.m3u8${q}`;
  stageChan = null;
  let converted = false;
  const convert = (why) => {
    if (converted) return;
    converted = true;
    attach(hlsUrl);
    $('#stStatus').textContent = why;
    video.onerror = () => { $('#stStatus').textContent = 'This video could not be played or converted.'; };
  };
  const convBtn = el('button', { type: 'button', textContent: "no sound / won't play?", title: 'Convert for the browser', onclick: () => convert('Converting for your browser… the first picture takes up to 30 seconds.') });
  const direct_ok = /^(mp4|m4v|webm)$/i.test(ext || '');
  openStage(title, [...extraActions, convBtn], direct_ok ? direct : hlsUrl);
  if (direct_ok) video.onerror = () => convert('This file needs converting for the browser… the first picture takes up to 30 seconds.');
  else { converted = true; $('#stStatus').textContent = 'Converting for your browser… the first picture takes up to 30 seconds.'; }
}

function playEpisode(show, flat, e) {
  const i = flat.findIndex((x) => x.id === e.id);
  const next = flat[i + 1];
  const label = `${show.name} S${e.season}E${e.num}${e.title ? ' · ' + e.title : ''}`;
  playVod('e-' + e.id, e.ext, label, next ? [el('button', { type: 'button', textContent: '▶ next episode', onclick: () => playEpisode(show, flat, { ...next }) })] : []);
}
