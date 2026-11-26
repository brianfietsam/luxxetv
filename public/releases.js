'use strict';
/* LuxxeTV movies view: the provider library (vod.js) beside release-date lists and the auto-download watchlist.
   Loaded after app.js and vod.js and shares their helpers ($, el, api, view, setView, openStage, openLib...). */

let mvList = 'upcoming', mvSearch = '', mvPoll = null;
const DAYMS = 86400000;
const fmtDay = (ms) => {
  const d = new Date(ms), sameYear = d.getUTCFullYear() === new Date().getFullYear();
  // TMDB dates are calendar days (UTC midnight); format in UTC so they don't shift a day.
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' });
};
const daysAway = (ms) => {
  const today = Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const days = Math.round((ms - today) / DAYMS);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return days < 60 ? `in ${days} days` : `in ${Math.round(days / 30)} months`;
  return 'out now';
};
const WSTAT = { waiting: '★ Watching — waiting for provider', queued: '⏳ Found — queued', downloading: '⬇ Downloading…', done: '✔ Downloaded', failed: '⚠ Download failed' };

function dateLines(m) {
  const lines = [];
  if (m.theatrical) lines.push(el('div', { className: 'dt' }, '🎬 Theaters: ', el('b', { textContent: fmtDay(m.theatrical) }), ` · ${daysAway(m.theatrical)}`));
  if (m.digital) lines.push(el('div', { className: 'dt' }, '📺 Streaming: ', el('b', { textContent: fmtDay(m.digital) }), ` · ${daysAway(m.digital)}`));
  else if (m.digitalEstimate) lines.push(el('div', { className: 'dt' }, '📺 Streaming: ', el('span', { className: 'est', textContent: `not announced · est. ~${fmtDay(m.digitalEstimate)}` })));
  else lines.push(el('div', { className: 'dt', textContent: '📺 Streaming: not announced' }));
  return lines;
}

async function toggleWatch(m, btn) {
  btn.disabled = true;
  try {
    if (m.watch) {
      if (!confirm(`Stop watching for “${m.title}”?`)) return;
      await api('/api/watchlist/' + m.id, { method: 'DELETE' });
      m.watch = null;
    } else {
      const w = await api('/api/watchlist', { method: 'POST', body: { tmdbId: m.id } });
      m.watch = w.status;
      // Give the immediate provider check a moment, then show its result.
      setTimeout(async () => { const l = await api('/api/watchlist').catch(() => null); const x = l && l.items.find((i) => i.tmdbId === m.id); if (x) { m.watch = x.status; paintBtn(m, btn); } countWatch(l); }, 2500);
    }
    paintBtn(m, btn); countWatch();
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; }
}
function paintBtn(m, btn) {
  btn.classList.toggle('on', !!m.watch);
  btn.closest('.mv').classList.toggle('watched', !!m.watch);
  btn.textContent = m.watch ? WSTAT[m.watch] : m.onProvider ? '⬇ Download now' : '＋ Download when available';
}

function movieCard(m) {
  const poster = el('div', { className: 'poster', onclick: () => card.classList.toggle('open') },
    m.poster ? '' : el('div', { className: 'noimg', textContent: m.title }),
    el('div', { className: 'ov', textContent: m.overview || 'No description.' }));
  if (m.poster) poster.style.backgroundImage = `url("${m.poster.replace(/["\\\n]/g, "")}")`;
  if (m.onProvider) poster.append(el('span', { className: 'badge', title: m.onProvider, textContent: '✔ On your provider' }));
  const btn = el('button', { type: 'button' });
  btn.onclick = () => toggleWatch(m, btn);
  const card = el('div', { className: 'mv' }, poster,
    el('div', { className: 'body' },
      el('div', { className: 'ttl', textContent: `${m.title}${m.year ? ` (${m.year})` : ''}` }),
      m.certification || m.rating ? el('div', { className: 'dt', textContent: [m.certification, m.rating ? `★ ${m.rating.toFixed(1)}` : ''].filter(Boolean).join(' · ') }) : '',
      ...dateLines(m), btn));
  paintBtn(m, btn);
  return card;
}

function needsKeyMsg() {
  return el('div', { className: 'panel' }, el('b', { textContent: 'Connect TMDB to see upcoming movies' }),
    el('div', { className: 'muted', textContent: 'Create a free account at themoviedb.org, open Settings → API, copy the API key (or Read Access Token) and paste it under Settings → movies & tv shows here.' }),
    el('button', { type: 'button', textContent: 'Open Settings', onclick: () => setView('settings') }));
}

async function loadMovies() {
  clearTimeout(mvPoll);
  document.querySelectorAll('#mvLists button').forEach((b) => b.classList.toggle('on', !mvSearch && b.dataset.list === mvList));
  if (mvList === 'watchlist' && !mvSearch) return loadWatchlist();
  $('#wBar').hidden = true;
  $('#mvMsg').textContent = 'Loading…';
  try {
    const r = mvSearch ? await api('/api/movies/search?q=' + encodeURIComponent(mvSearch)) : await api('/api/movies?list=' + mvList);
    if (r.needsKey) { $('#mvMsg').textContent = ''; $('#movies').replaceChildren(needsKeyMsg()); return; }
    const label = mvSearch ? `Results for “${mvSearch}”` : { upcoming: 'Major movies coming to theaters, by release date', theaters: 'Now playing in theaters', streaming: 'Recent and upcoming streaming (digital) releases' }[mvList];
    $('#mvMsg').textContent = `${label} · ${r.items.length} movie${r.items.length === 1 ? "" : "s"}${r.region ? ' · ' + r.region + ' dates' : ''}${r.libraryLoaded === false ? ' · checking your provider’s library…' : ''}`;
    $('#movies').replaceChildren(r.items.length ? el('div', { className: 'mgrid' }, ...r.items.map(movieCard)) : el('p', { className: 'muted', textContent: 'No movies found.' }));
    // First load warms the provider library in the background; refresh once so the "On your provider" badges appear.
    if (r.libraryLoaded === false && !mvSearch) mvPoll = setTimeout(() => releasesShown() && loadMovies(), 8000);
  } catch (e) { $('#mvMsg').textContent = ''; $('#movies').replaceChildren(el('p', { className: 'err', textContent: e.message })); }
  countWatch();
}

async function countWatch(l) {
  try { l = l || await api('/api/watchlist'); const n = l.items.filter((i) => i.status !== 'done').length; $('#wCount').textContent = l.items.length ? `(${n || l.items.length})` : ''; } catch { /* ignore */ }
}

async function loadWatchlist() {
  clearTimeout(mvPoll);
  let r;
  try { r = await api('/api/watchlist'); } catch (e) { $('#movies').replaceChildren(el('p', { className: 'err', textContent: e.message })); return; }
  const st = r.status;
  $('#wBar').hidden = false;
  $('#wInfo').textContent = st.checking ? 'Checking your provider…'
    : `${st.lastCheck ? 'Last checked ' + stamp(st.lastCheck) : 'Not checked yet'}${st.lastError ? ' · ✘ ' + st.lastError : ''} · saves to ${st.movieDir}`;
  $('#wCheck').disabled = st.checking;
  $('#mvMsg').textContent = r.items.length ? 'Movies you marked download automatically as soon as they appear on your provider (CAM/TS copies are skipped).' : '';
  countWatch(r);
  if (!r.items.length) { $('#movies').replaceChildren(el('p', { className: 'muted', textContent: 'Nothing on your watchlist. Tap “＋ Download when available” on any movie.' })); return; }
  $('#movies').replaceChildren(...r.items.map((w) => {
    const info = [];
    if (w.theatrical) info.push(`Theaters ${fmtDay(w.theatrical)}`);
    info.push(w.digital ? `Streaming ${fmtDay(w.digital)}` : w.digitalEstimate ? `Streaming est. ~${fmtDay(w.digitalEstimate)}` : 'Streaming not announced');
    let line = WSTAT[w.status];
    if (w.status === 'downloading' && w.total) line += ` ${Math.floor(w.bytes / w.total * 100)}% · ${fmtSize(w.bytes)} of ${fmtSize(w.total)}`;
    else if (w.status === 'downloading') line += ` ${fmtSize(w.bytes)}`;
    if (w.status === 'done') line += ` · ${fmtSize(w.bytes)} · ${w.file}`;
    if (w.status === 'failed') line += ` · ${w.error}`;
    const acts = [];
    if (w.playable) acts.push(el('button', { type: 'button', className: 'solid', textContent: '▶ Play', onclick: () => {
      stageChan = null;
      openStage(w.title, [el('a', { className: 'btn', href: `/dl/movie/${w.tmdbId}?download=1`, textContent: 'download' })], `/dl/movie/${w.tmdbId}`);
    } }));
    else if (w.status === 'done') acts.push(el('a', { className: 'btn', href: `/dl/movie/${w.tmdbId}?download=1`, textContent: 'Download file' }));
    if (w.status === 'failed') acts.push(el('button', { type: 'button', textContent: 'Retry', onclick: async () => { await api(`/api/watchlist/${w.tmdbId}/retry`, { method: 'POST' }); loadWatchlist(); } }));
    acts.push(el('button', { type: 'button', textContent: 'Remove', onclick: async () => {
      const del = w.status === 'done' && confirm(`Also delete the downloaded file?\n\n${w.file}\n\nOK = delete file, Cancel = keep file`);
      if (w.status !== 'done' && !confirm(`Remove “${w.title}” from your watchlist?`)) return;
      await api(`/api/watchlist/${w.tmdbId}${del ? '?deleteFile=1' : ''}`, { method: 'DELETE' }); loadWatchlist();
    } }));
    return el('div', { className: 'item witem' + (w.status === 'downloading' ? ' live' : '') },
      el('img', { src: w.poster || '', loading: 'lazy', onerror() { this.style.visibility = 'hidden'; } }),
      el('div', { className: 't' }, el('b', { textContent: `${w.title}${w.year ? ` (${w.year})` : ''}` }),
        el('div', { className: 'muted', textContent: info.join(' · ') }),
        el('div', { className: w.status === 'failed' ? 'err' : 'muted', textContent: line }),
        w.providerName && w.status !== 'done' ? el('div', { className: 'muted', textContent: 'Provider: ' + w.providerName }) : '',
        w.status === 'downloading' && w.total ? el('div', { className: 'bar-t' }, el('i', { style: `width:${(w.bytes / w.total * 100).toFixed(1)}%` })) : ''),
      ...acts);
  }));
  if (st.checking || r.items.some((i) => i.status === 'downloading' || i.status === 'queued')) mvPoll = setTimeout(() => releasesShown() && mvList === 'watchlist' && !mvSearch && loadWatchlist(), 3000);
}

let mvqt; $('#mvq').oninput = () => { clearTimeout(mvqt); mvqt = setTimeout(() => { mvSearch = $('#mvq').value.trim(); loadMovies(); }, 400); };
$('#wCheck').onclick = async () => {
  $('#wCheck').disabled = true; $('#wInfo').textContent = 'Checking your provider…';
  try { await api('/api/watchlist/check', { method: 'POST' }); } catch (e) { alert(e.message); }
  loadWatchlist();
};

/* ---------- sections of the movies view ---------- */
let mvTab = prefs.get('movies.tab', 'library');
const releasesShown = () => view === 'movies' && mvTab !== 'library';
function openMovies() {
  if (!document.querySelector(`#mvLists button[data-list="${mvTab}"]`)) mvTab = 'library';
  const lib = mvTab === 'library';
  $('#mvLibrary').hidden = !lib; $('#mvReleases').hidden = lib;
  document.querySelectorAll('#mvLists button').forEach((b) => b.classList.toggle('on', b.dataset.list === mvTab && (lib || !mvSearch)));
  clearTimeout(mvPoll);
  countWatch();
  if (lib) return openLib('movies');
  mvList = mvTab;
  loadMovies();
}
$('#mvLists').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  mvTab = b.dataset.list; mvSearch = ''; $('#mvq').value = '';
  prefs.set('movies.tab', mvTab);
  $('#movies').replaceChildren(); $('#mvMsg').textContent = '';
  openMovies();
};
