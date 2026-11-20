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

const sheetClose = () => { $('#sheet').hidden = true; };
$('#shClose').onclick = sheetClose;
$('#sheet').addEventListener('pointerdown', (e) => { if (e.target.id === 'sheet') sheetClose(); });

async function queue(body, what) {
  try {
    const r = await api('/api/downloads', { method: 'POST', body });
    toast(`${r.queued} ${r.queued === 1 ? 'download' : 'downloads'} queued: ${what}`);
  } catch (e) { toast(e.message, true); }
}

async function openSheet(v, it) {
  const meta = [it.year || '', it.rating ? '★ ' + it.rating.toFixed(1) : '', it.gross ? money(it.gross) + ' worldwide box office' : ''].filter(Boolean);
  $('#shTitle').textContent = it.name;
  $('#shMeta').textContent = meta.join(' · ');
  $('#shPlot').textContent = ''; $('#shBody').replaceChildren();
  $('#sheet').hidden = false;
  if (v === 'movies') {
    $('#shBody').append(el('button', { type: 'button', className: 'solid', textContent: '▶ watch now', onclick: () => { sheetClose(); playVod('m-' + it.id, it.ext, it.name); } }),
      el('button', { type: 'button', textContent: '⬇ download movie', onclick: () => { queue({ type: 'movie', id: it.id }, it.name); sheetClose(); } }));
    return;
  }
  $('#shBody').append(el('div', { className: 'muted', textContent: 'loading seasons…' }));
  try {
    const s = await api('/api/vod/series/' + encodeURIComponent(it.id));
    if ($('#shTitle').textContent !== it.name) return;      // user opened something else meanwhile
    const total = s.seasons.reduce((n, x) => n + x.episodes.length, 0);
    $('#shPlot').textContent = s.plot;
    $('#shMeta').textContent = [...meta, `${s.seasons.length} seasons`, `${total} episodes`].join(' · ');
    const flat = s.seasons.flatMap((se) => se.episodes.map((e) => ({ ...e, season: se.season })));
    const watch = (e) => { sheetClose(); playEpisode(it, flat, e); };
    $('#shBody').replaceChildren(
      el('button', { type: 'button', textContent: `⬇ download entire show (${total} episodes)`, onclick: () => { queue({ type: 'series', seriesId: it.id }, it.name); sheetClose(); } }),
      ...s.seasons.map((se) => el('div', { className: 'season' },
        el('div', { className: 'sh' }, el('b', { textContent: `Season ${se.season} · ${se.episodes.length} episodes` }),
          el('button', { type: 'button', textContent: '⬇ season', onclick: () => queue({ type: 'season', seriesId: it.id, season: se.season }, `${it.name} season ${se.season}`) })),
        ...se.episodes.map((e) => el('div', { className: 'ep' },
          el('span', { textContent: `${e.num}. ${e.title}`, title: e.title }),
          el('button', { type: 'button', className: 'solid', textContent: '▶', 'aria-label': 'Watch episode ' + e.num, onclick: () => watch({ ...e, season: se.season }) }),
          el('button', { type: 'button', textContent: '⬇', 'aria-label': 'Download episode ' + e.num, onclick: () => queue({ type: 'episode', seriesId: it.id, episodeId: e.id }, `${it.name} S${se.season}E${e.num}`) }))))));
  } catch (e) { $('#shBody').replaceChildren(el('div', { className: 'err', textContent: e.message })); }
}

/* ---------- downloads ---------- */
let dlTimer;
async function loadDownloads() {
  clearTimeout(dlTimer);
  let d;
  try { d = await api('/api/downloads'); } catch { return; }
  const active = d.jobs.some((j) => j.status === 'queued' || j.status === 'downloading');
  $('#dlJobs').replaceChildren(...(d.jobs.length ? d.jobs.map((j) => {
    const info = j.status === 'downloading' ? `${fmtSize(j.bytes)}${j.total ? ' of ' + fmtSize(j.total) : ''}`
      : j.status === 'failed' ? j.error : j.note || j.status + (j.status === 'done' ? ' · ' + fmtSize(j.bytes) : '');
    const bar = el('div', { className: 'bar-t' }, el('i'));
    bar.firstChild.style.setProperty('--p', (j.total ? Math.min(100, j.bytes / j.total * 100) : 0) + '%');
    return el('div', { className: 'item' },
      el('div', { className: 't' }, el('b', { textContent: j.title }), el('div', { className: j.status === 'failed' ? 'err' : 'muted', textContent: info }), j.status === 'downloading' ? bar : null),
      j.status === 'queued' || j.status === 'downloading'
        ? el('button', { type: 'button', textContent: 'cancel', onclick: async () => { await api(`/api/downloads/${j.id}/cancel`, { method: 'POST' }); loadDownloads(); } }) : null);
  }) : [el('div', { className: 'empty' }, el('div', { className: 'big', textContent: 'no downloads yet' }), el('p', { textContent: 'Open a movie or show and tap download.' }))]));
  const url = (f, dl) => `/dl?f=${encodeURIComponent(f.rel)}${dl ? '&download=1' : ''}`;
  $('#dlFiles').replaceChildren(...(d.files.length ? d.files.map((f) => el('div', { className: 'item' },
    el('div', { className: 't' }, el('b', { textContent: f.rel.replace(/\.[^.]+$/, '') }), el('div', { className: 'muted', textContent: `${fmtSize(f.size)} · ${stamp(f.mtime)}` })),
    f.playable ? el('button', { type: 'button', className: 'solid', textContent: '▶ play', onclick: () => {
      stageChan = null;
      openStage(f.name.replace(/\.[^.]+$/, ''), [el('a', { className: 'btn', href: url(f, true), textContent: 'download' })], url(f));
    } }) : null,
    el('a', { className: 'btn', href: url(f, true), textContent: 'save' }),
    el('button', { type: 'button', textContent: 'delete', onclick: async () => {
      if (confirm('Delete ' + f.name + '?')) { await api('/api/downloads/file?f=' + encodeURIComponent(f.rel), { method: 'DELETE' }); loadDownloads(); }
    } })))
    : [el('div', { className: 'muted', textContent: 'Nothing saved yet.' })]));
  if (view === 'downloads' && active) dlTimer = setTimeout(loadDownloads, 1500);
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
