'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((k) => e.append(k));
  return e;
};
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
const fmtTime = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  if (r.status === 401) { showLogin(); throw new Error('Please sign in'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------- login ----------
function showLogin() { $('#login').hidden = false; $('#loginPw').focus(); }
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/api/login', { method: 'POST', body: { password: $('#loginPw').value } }); location.reload(); }
  catch (err) { $('#loginErr').textContent = err.message; }
};

// ---------- tabs ----------
let tab = 'live';
function setTab(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + t));
  if (t === 'live' && dirtyLive) { dirtyLive = false; loadChannels(true); }
  if (t === 'guide' && (dirtyGuide || !gTrack)) { dirtyGuide = false; loadGuide(true); }
  if (t === 'movies') loadMovies();
  if (t === 'recordings') loadRecordings();
  if (t === 'schedule') loadSchedules();
  if (t === 'settings') loadSettings();
}
$('#tabs').onclick = (e) => e.target.dataset.tab && setTab(e.target.dataset.tab);

// ---------- player ----------
let hls = null;
const video = $('#video');
function stopPlayer() {
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src'); video.load();
}
function attach(src, statusEl) {
  stopPlayer();
  const status = (m) => (statusEl.textContent = m);
  status('Starting stream… (first picture takes ~10 s)');
  video.onplaying = () => status('');
  if (src.includes('.m3u8') && window.Hls && Hls.isSupported()) {
    hls = new Hls({ liveSyncDurationCount: 3, maxBufferLength: 30 });
    hls.loadSource(src); hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { status('Connection hiccup, retrying…'); setTimeout(() => hls && hls.startLoad(), 2000); }
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else status('Playback failed: ' + d.details);
    });
  } else {
    video.src = src; video.play().catch(() => {});   // native HLS (Safari) or MP4
  }
}
function openPlayer(title, sub, actions) {
  $('#player').hidden = false;
  $('#pTitle').textContent = title; $('#pSub').textContent = sub || '';
  $('#pActions').replaceChildren(...actions);
  $('#player').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let current = null;
async function playChannel(ch) {
  current = ch;
  document.querySelectorAll('.ch').forEach((b) => b.classList.toggle('on', b.dataset.id === ch.id));
  const recSel = el('select', { style: 'width:auto' },
    ...[['Until I stop', 0], ['30 min', 30], ['1 hour', 60], ['2 hours', 120], ['3 hours', 180]].map(([l, v]) => el('option', { value: v, textContent: l })));
  const recBtn = el('button', { className: 'rec', textContent: '● Record', onclick: async () => {
    try { await api('/api/record', { method: 'POST', body: { channelId: ch.id, minutes: +recSel.value } }); pollStatus(); recBtn.textContent = '✔ Recording'; }
    catch (e) { alert(e.message); }
  } });
  const schedBtn = el('button', { textContent: 'Schedule…', onclick: () => { setTab('schedule'); pickChannel(ch); } });
  const closeBtn = el('button', { textContent: '✕', onclick: () => { stopPlayer(); $('#player').hidden = true; } });
  openPlayer(ch.name, '', [recSel, recBtn, schedBtn, closeBtn]);
  attach(`/live/${encodeURIComponent(ch.id)}/index.m3u8`, $('#pStatus'));
  api('/api/epg/' + encodeURIComponent(ch.id)).then((e) => {
    const now = Date.now();
    const n = e.find((x) => x.start <= now && x.end > now) || e[0];
    if (n && current === ch) $('#pSub').textContent = `${n.title}${n.end ? ' · until ' + new Date(n.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}`;
  }).catch(() => {});
}

// ---------- channels ----------
let offset = 0, loading = false;
async function loadChannels(reset) {
  if (loading) return; loading = true;
  if (reset) { offset = 0; $('#channels').replaceChildren(); }
  try {
    const r = await api(`/api/channels?offset=${offset}&limit=120&q=${encodeURIComponent($('#q').value)}&cat=${encodeURIComponent($('#cat').value)}`);
    r.items.forEach((ch) => {
      const b = el('button', { className: 'ch', onclick: () => playChannel(ch) },
        el('img', { src: ch.logo || '', loading: 'lazy', onerror() { this.style.visibility = 'hidden'; } }), el('span', { textContent: ch.name }));
      b.dataset.id = ch.id;
      $('#channels').append(b);
    });
    offset += r.items.length;
    $('#more').hidden = offset >= r.total;
    if (!r.total) $('#channels').append(el('p', { className: 'muted', textContent: 'No channels. Add your playlist under Settings.' }));
  } catch (e) { $('#channels').append(el('p', { className: 'err', textContent: e.message })); }
  loading = false;
}
let qt;
$('#q').oninput = () => { clearTimeout(qt); qt = setTimeout(() => loadChannels(true), 250); };
$('#cat').onchange = () => loadChannels(true);
$('#more').onclick = () => loadChannels(false);
// show/hide categories (saved on the PC, so it applies to every device)
let allCats = [];
async function saveHidden() {
  await api('/api/categories/hidden', { method: 'PUT', body: { hidden: allCats.filter((c) => c.hidden).map((c) => c.name) } });
  dirtyLive = dirtyGuide = true; catSummary(); loadCats();
}
function renderCatPanel() {
  const f = $('#catFilter').value.toLowerCase();
  $('#catList').replaceChildren(...allCats.filter((c) => c.name.toLowerCase().includes(f)).map((c) => {
    const cb = el('input', { type: 'checkbox', checked: !c.hidden, onchange: async () => { c.hidden = !cb.checked; await saveHidden(); } });
    return el('label', {}, cb, el('span', { textContent: c.name }), el('small', { textContent: c.count }));
  }));
}
const catSummary = () => { $('#catSummary').textContent = allCats.length ? `${allCats.filter((c) => !c.hidden).length} of ${allCats.length} categories shown` : ''; };
var dirtyLive = false, dirtyGuide = false;   // lists need a reload after category changes
$('#manageCats').onclick = async () => {
  const p = $('#catPanel');
  if (!p.hidden) { p.hidden = true; return; }
  try {
    allCats = (await api('/api/categories?all=1')).sort((a, b) => a.name.localeCompare(b.name));
    $('#catFilter').value = ''; renderCatPanel(); catSummary(); p.hidden = false;
  } catch (e) { $('#catSummary').textContent = 'Save your playlist settings and press "Test & reload" first (' + e.message + ')'; }
};
$('#catFilter').oninput = renderCatPanel;
const bulk = (hide) => async () => {
  const f = $('#catFilter').value.toLowerCase();
  allCats.forEach((c) => { if (c.name.toLowerCase().includes(f)) c.hidden = hide; });
  await saveHidden(); renderCatPanel();
};
$('#catShowAll').onclick = bulk(false);
$('#catHideAll').onclick = bulk(true);
async function loadCats() {
  for (const sel of [$('#cat'), $('#gcat')]) sel.replaceChildren(el('option', { value: '', textContent: 'All categories' }));
  try {
    (await api('/api/categories')).sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => {
      $('#cat').append(el('option', { value: c.name, textContent: c.name }));
      $('#gcat').append(el('option', { value: c.name, textContent: c.name }));
    });
  } catch { /* shown via channels */ }
}

// ---------- TV guide ----------
const PPM = 5;   // pixels per minute
const GUIDE_HOURS = 6;
let gFrom = 0, gOffset = 0, gLoading = false, gSched = [], gTrack = null;
const snap30 = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0); return +d; };
const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function initGuide() {
  const days = $('#gDay'); days.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const d = new Date(); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0);
    days.append(el('option', { value: i === 0 ? 'now' : +d, textContent: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long' }) }));
  }
}
function guideStart(ms) { gFrom = Math.max(snap30(Date.now() - 3600000), ms); loadGuide(true); }
$('#gNow').onclick = () => { $('#gDay').value = 'now'; guideStart(snap30(Date.now() - 1800000)); };
$('#gPrev').onclick = () => guideStart(gFrom - 3 * 3600000);
$('#gNext').onclick = () => guideStart(gFrom + 3 * 3600000);
$('#gDay').onchange = () => guideStart($('#gDay').value === 'now' ? snap30(Date.now() - 1800000) : +$('#gDay').value);
let gqt; $('#gq').oninput = () => { clearTimeout(gqt); gqt = setTimeout(() => loadGuide(true), 300); };
$('#gcat').onchange = () => loadGuide(true);
$('#gOnly').onchange = () => loadGuide(true);
$('#gMore').onclick = () => loadGuide(false);

async function loadGuide(reset) {
  if (gLoading) return; gLoading = true;
  if (!gFrom) gFrom = snap30(Date.now() - 1800000);
  if (reset) gOffset = 0;
  try {
    gSched = await api('/api/schedules').catch(() => gSched);
    const r = await api(`/api/guide?from=${gFrom}&hours=${GUIDE_HOURS}&offset=${gOffset}&limit=40&only=${$('#gOnly').checked ? 1 : 0}&q=${encodeURIComponent($('#gq').value)}&cat=${encodeURIComponent($('#gcat').value)}`);
    if (r.loading || r.error) {
      $('#gMsg').textContent = r.error ? '✘ ' + r.error + ' — you can set a guide URL in Settings.' : 'Downloading guide data from your provider… (first time can take a minute)';
      $('#guide').replaceChildren(); $('#gMore').hidden = true; gLoading = false;
      if (r.loading) setTimeout(() => tab === 'guide' && loadGuide(true), 4000);
      return;
    }
    $('#gMsg').textContent = `${r.total} channels · guide updated ${new Date(r.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${r.refreshing ? ' (refreshing…)' : ''}`;
    const width = GUIDE_HOURS * 60 * PPM;
    if (reset || !gTrack) {
      const head = el('div', { className: 'grow ghead' }, el('div', { className: 'gch' }),
        el('div', { className: 'gtrack', style: `width:${width}px` }));
      for (let m = 0; m < GUIDE_HOURS * 60; m += 30) head.lastChild.append(el('div', { className: 'gtick', style: `left:${m * PPM}px`, textContent: hm(gFrom + m * 60000) }));
      const nowMs = Date.now();
      if (nowMs >= gFrom && nowMs < gFrom + GUIDE_HOURS * 3600000) head.lastChild.append(el('div', { className: 'gnow', style: `left:${(nowMs - gFrom) / 60000 * PPM}px` }));
      gTrack = el('div', { className: 'ginner', style: `width:${width + 170}px` }, head);
      $('#guide').replaceChildren(el('div', { className: 'gwrap' }, gTrack));
    }
    r.rows.forEach((row) => {
      const track = el('div', { className: 'gtrack', style: `width:${width}px` });
      row.progs.forEach((p) => {
        const s = Math.max(p.s, r.from), e = Math.min(p.e, r.to);
        const sched = gSched.some((x) => x.channelId === row.id && x.start === p.s);
        const airing = p.s <= Date.now() && p.e > Date.now();
        track.append(el('div', { className: 'gp' + (airing ? ' now' : '') + (sched ? ' sched' : ''), title: p.t,
          style: `left:${(s - r.from) / 60000 * PPM}px;width:${Math.max(2, (e - s) / 60000 * PPM - 2)}px`,
          textContent: (sched ? '● ' : '') + p.t, onclick: () => openProgram(row, p) }));
      });
      if (!row.progs.length) track.append(el('div', { className: 'muted', style: 'padding:16px', textContent: 'No guide data' }));
      gTrack.append(el('div', { className: 'grow' },
        el('div', { className: 'gch', onclick: () => { setTab('live'); playChannel({ id: row.id, name: row.name }); } },
          el('img', { src: row.logo || '', loading: 'lazy', onerror() { this.style.visibility = 'hidden'; } }), el('span', { textContent: row.name })), track));
    });
    gOffset += r.rows.length;
    $('#gMore').hidden = gOffset >= r.total;
  } catch (e) { $('#gMsg').textContent = '✘ ' + e.message; }
  gLoading = false;
}

function openProgram(row, p) {
  const m = $('#progModal'), now = Date.now();
  const airing = p.s <= now && p.e > now;
  const existing = gSched.find((x) => x.channelId === row.id && x.start === p.s);
  $('#mTitle').textContent = p.t;
  $('#mWhen').textContent = `${row.name} · ${new Date(p.s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${hm(p.s)}–${hm(p.e)}${airing ? ' · on now' : ''}`;
  $('#mDesc').textContent = p.d || '';
  $('#mMsg').textContent = ''; $('#mRepeat').value = 'none'; $('#mRepeat').parentElement.hidden = !!existing;
  const done = () => { m.hidden = true; loadGuide(true); };
  const acts = [];
  if (existing) {
    acts.push(el('button', { textContent: '✔ Scheduled — cancel', onclick: async () => { await api('/api/schedules/' + existing.id, { method: 'DELETE' }); done(); } }));
  } else {
    acts.push(el('button', { className: 'rec', textContent: airing ? '● Record from now' : '● Record', onclick: async () => {
      try {
        await api('/api/schedules', { method: 'POST', body: { channelId: row.id, start: new Date(p.s).toISOString(), end: new Date(p.e).toISOString(), title: p.t, repeat: $('#mRepeat').value } });
        $('#mMsg').textContent = airing ? 'Recording will begin within ~15 seconds.' : 'Scheduled.';
        setTimeout(done, 900); pollStatus();
      } catch (e) { $('#mMsg').textContent = e.message; }
    } }));
  }
  if (airing) acts.push(el('button', { textContent: '▶ Watch', onclick: () => { m.hidden = true; setTab('live'); playChannel({ id: row.id, name: row.name }); } }));
  acts.push(el('button', { textContent: 'Close', onclick: () => { m.hidden = true; } }));
  $('#mActions').replaceChildren(...acts);
  m.hidden = false;
}
$('#progModal').onclick = (e) => { if (e.target.id === 'progModal') e.target.hidden = true; };

// ---------- movies ----------
let mvList = 'upcoming', mvSearch = '', mvPoll = null;
const DAYMS = 86400000;
const fmtDay = (ms) => {
  const d = new Date(ms), sameYear = d.getUTCFullYear() === new Date().getFullYear();
  // TMDB dates are calendar days (UTC midnight); format in UTC so they don't shift a day.
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' });
};
const rel = (ms) => {
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
  if (m.theatrical) lines.push(el('div', { className: 'dt' }, '🎬 Theaters: ', el('b', { textContent: fmtDay(m.theatrical) }), ` · ${rel(m.theatrical)}`));
  if (m.digital) lines.push(el('div', { className: 'dt' }, '📺 Streaming: ', el('b', { textContent: fmtDay(m.digital) }), ` · ${rel(m.digital)}`));
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
  const btn = el('button', {});
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
  return el('div', { className: 'card' }, el('b', { textContent: 'Connect TMDB to see upcoming movies' }),
    el('div', { className: 'muted', textContent: 'Create a free account at themoviedb.org, open Settings → API, copy the API key (or Read Access Token) and paste it under Settings → Movies here.' }),
    el('button', { type: 'button', textContent: 'Open Settings', onclick: () => setTab('settings') }));
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
    if (r.libraryLoaded === false && !mvSearch) mvPoll = setTimeout(() => tab === 'movies' && loadMovies(), 8000);
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
    : `${st.lastCheck ? 'Last checked ' + fmtTime(st.lastCheck) : 'Not checked yet'}${st.lastError ? ' · ✘ ' + st.lastError : ''} · saves to ${st.movieDir}`;
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
    if (w.playable) acts.push(el('button', { textContent: '▶ Play', onclick: () => {
      openPlayer(w.title, w.file, [el('a', { href: `/dl/movie/${w.tmdbId}?download=1`, textContent: 'Download', className: 'muted' }), el('button', { textContent: '✕', onclick: () => { stopPlayer(); $('#player').hidden = true; } })]);
      attach(`/dl/movie/${w.tmdbId}`, $('#pStatus'));
    } }));
    else if (w.status === 'done') acts.push(el('a', { href: `/dl/movie/${w.tmdbId}?download=1`, className: 'muted', textContent: 'Download file' }));
    if (w.status === 'failed') acts.push(el('button', { textContent: 'Retry', onclick: async () => { await api(`/api/watchlist/${w.tmdbId}/retry`, { method: 'POST' }); loadWatchlist(); } }));
    acts.push(el('button', { textContent: 'Remove', onclick: async () => {
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
        w.status === 'downloading' && w.total ? el('div', { className: 'prog' }, el('div', { style: `width:${(w.bytes / w.total * 100).toFixed(1)}%` })) : ''),
      ...acts);
  }));
  if (st.checking || r.items.some((i) => i.status === 'downloading' || i.status === 'queued')) mvPoll = setTimeout(() => tab === 'movies' && mvList === 'watchlist' && !mvSearch && loadWatchlist(), 3000);
}

$('#mvLists').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; mvList = b.dataset.list; mvSearch = ''; $('#mvq').value = ''; loadMovies(); };
let mvqt; $('#mvq').oninput = () => { clearTimeout(mvqt); mvqt = setTimeout(() => { mvSearch = $('#mvq').value.trim(); loadMovies(); }, 400); };
$('#wCheck').onclick = async () => {
  $('#wCheck').disabled = true; $('#wInfo').textContent = 'Checking your provider…';
  try { await api('/api/watchlist/check', { method: 'POST' }); } catch (e) { alert(e.message); }
  loadWatchlist();
};

// ---------- recordings ----------
async function pollStatus() {
  try {
    const s = await api('/api/record/status');
    const b = $('#recbadge');
    b.hidden = !s.active.length;
    b.textContent = `● REC ${s.active.length}`;
    if (tab === 'recordings') renderActive(s);
  } catch { /* ignore */ }
}
function renderActive(s) {
  $('#active').replaceChildren(...s.active.map((r) => el('div', { className: 'item live' },
    el('div', { className: 't' }, el('b', { textContent: '● ' + r.name }),
      el('div', { className: 'muted', textContent: `${fmtSize(r.bytes)} · started ${fmtTime(r.startedAt)}${r.endAt ? ' · ends ' + new Date(r.endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}` })),
    el('button', { textContent: 'Stop', onclick: async () => { await api(`/api/record/${r.id}/stop`, { method: 'POST' }); setTimeout(() => { pollStatus(); loadRecordings(); }, 1500); } })),
  ), ...s.recent.filter((r) => r.error).slice(0, 3).map((r) => el('div', { className: 'item' }, el('span', { className: 'err', textContent: `${r.name}: ${r.error}` }))));
}
async function loadRecordings() {
  const list = await api('/api/recordings').catch(() => []);
  renderActive(await api('/api/record/status'));
  $('#recList').replaceChildren(...(list.length ? list.map((r) => el('div', { className: 'item' },
    el('div', { className: 't' }, el('div', { textContent: r.name }), el('div', { className: 'muted', textContent: `${fmtSize(r.size)} · ${fmtTime(r.mtime)}${r.recording ? ' · recording' : ''}` })),
    r.playable ? el('button', { textContent: '▶ Play', onclick: () => {
      openPlayer(r.name, fmtSize(r.size), [el('a', { href: `/rec/${encodeURIComponent(r.name)}?download=1`, textContent: 'Download', className: 'muted' }), el('button', { textContent: '✕', onclick: () => { stopPlayer(); $('#player').hidden = true; } })]);
      attach(`/rec/${encodeURIComponent(r.name)}`, $('#pStatus'));
    } }) : el('span', { className: 'muted', textContent: 'mkv: download only' }),
    el('button', { textContent: 'Delete', disabled: r.recording, onclick: async () => { if (confirm('Delete ' + r.name + '?')) { await api('/api/recordings/' + encodeURIComponent(r.name), { method: 'DELETE' }); loadRecordings(); } } }),
  )) : [el('p', { className: 'muted', textContent: 'No recordings yet.' })]));
}

// ---------- schedules ----------
let pickedCh = null;
function pickChannel(ch) {
  pickedCh = ch; $('#sq').value = ch.name;
  $('#sch').replaceChildren(el('option', { value: ch.id, textContent: ch.name, selected: true }));
  const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
  const iso = (x) => new Date(x - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  if (!$('#sStart').value) { $('#sStart').value = iso(d); $('#sEnd').value = iso(new Date(+d + 3600000)); }
}
let sqt;
$('#sq').oninput = () => { clearTimeout(sqt); sqt = setTimeout(async () => {
  const r = await api('/api/channels?limit=30&q=' + encodeURIComponent($('#sq').value)).catch(() => ({ items: [] }));
  $('#sch').replaceChildren(...r.items.map((c) => el('option', { value: c.id, textContent: c.name })));
  if (r.items[0]) { $('#sch').selectedIndex = 0; pickedCh = r.items[0]; }
}, 250); };
$('#sch').onchange = () => { pickedCh = { id: $('#sch').value }; };
$('#schedForm').onsubmit = async (e) => {
  e.preventDefault(); $('#schedErr').textContent = '';
  try {
    const id = $('#sch').value || (pickedCh && pickedCh.id);
    if (!id) throw new Error('Pick a channel');
    await api('/api/schedules', { method: 'POST', body: { channelId: id, start: new Date($('#sStart').value).toISOString(), end: new Date($('#sEnd').value).toISOString(), title: $('#sTitle').value, repeat: $('#sRepeat').value } });
    loadSchedules();
  } catch (err) { $('#schedErr').textContent = err.message; }
};
async function loadSchedules() {
  const l = await api('/api/schedules').catch(() => []);
  $('#schedList').replaceChildren(...(l.length ? l.map((s) => el('div', { className: 'item' },
    el('div', { className: 't' }, el('b', { textContent: s.channelName + (s.title ? ' — ' + s.title : '') }),
      el('div', { className: 'muted', textContent: `${fmtTime(s.start)} → ${new Date(s.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${s.repeat === 'none' ? 'once' : s.repeat}${s.lastError ? ' · ' + s.lastError : ''}` })),
    el('button', { textContent: 'Remove', onclick: async () => { await api('/api/schedules/' + s.id, { method: 'DELETE' }); loadSchedules(); } }))) : [el('p', { className: 'muted', textContent: 'Nothing scheduled.' })]));
}

// ---------- settings ----------
const typeUi = () => { $('#xtreamF').hidden = $('#sType').value !== 'xtream'; $('#m3uF').hidden = $('#sType').value !== 'm3u'; };
$('#sType').onchange = typeUi;
if (window.desktop) {
  $('#browse').hidden = false; $('#browse').onclick = async () => { const d = await window.desktop.pickFolder(); if (d) $('#sDir').value = d; };
  $('#browseMovies').hidden = false; $('#browseMovies').onclick = async () => { const d = await window.desktop.pickFolder(); if (d) $('#sMovieDir').value = d; };
}
async function loadSettings() {
  const [c, sys] = await Promise.all([api('/api/settings'), api('/api/system')]);
  $('#sType').value = c.source.type; typeUi();
  $('#sServer').value = c.source.server; $('#sUser').value = c.source.username; $('#sM3u').value = c.source.m3uUrl;
  $('#sPass').placeholder = c.source.passwordSet ? '(saved — leave blank to keep)' : '';
  $('#sDir').value = c.recordDir; $('#sRecQ').value = c.recordQuality; $('#sLiveQ').value = c.liveQuality;
  $('#sPadB').value = c.padBeforeMin; $('#sPadA').value = c.padAfterMin;
  $('#sWebPw').placeholder = c.webPasswordSet ? '(saved — leave blank to keep)' : 'none (LAN only)';
  $('#sTmdb').placeholder = c.tmdbKeySet ? '(saved — leave blank to keep)' : '(not set)'; $('#sTmdb').value = '';
  $('#sRegion').value = c.tmdbRegion || 'US'; $('#sMovieDir').value = c.movieDir || ''; $('#sMovieHrs').value = c.movieCheckHours;
  $('#sPort').value = c.port; $('#sListen').checked = c.listenAll; $('#sFf').value = c.ffmpegPath; $('#sEpg').value = c.epgUrl || '';
  $('#sEnc').replaceChildren(...(sys.encoders.length ? sys.encoders : ['libx264']).map((e) => el('option', { value: e, textContent: e === 'libx264' ? 'libx264 (CPU, best compression)' : e + ' (GPU)' })));
  $('#sEnc').value = c.encoder;
  $('#sys').textContent = sys.ffmpeg ? `✔ ${sys.ffmpeg}` : '✘ ffmpeg not found — install it or set the path above.';
  const lan = location.origin;
  $('#urls').replaceChildren(el('b', { textContent: 'Open on your Tesla / phone' }),
    el('div', { className: 'muted', textContent: `At home (same Wi-Fi): http://<this-PC-IP>:${sys.port}/   (currently ${lan})` }),
    el('div', { className: 'muted', textContent: 'Away from home: use a Cloudflare Tunnel or similar to this port, and set a web password first. See README.' }));
  $('#about').replaceChildren(el('b', { textContent: 'About LuxxeTV' }),
    el('div', { className: 'muted', textContent: `Version: ${sys.version}` }),
    el('div', { className: 'muted', textContent: `Commit: ${sys.commit}` }),
    el('div', { className: 'muted', textContent: `Environment: ${sys.environment}` }),
    el('div', { className: 'muted', textContent: `Build date: ${sys.buildDate ? new Date(sys.buildDate).toLocaleDateString() : 'development build'}` }));
}
$('#refresh').onclick = async () => {
  $('#refreshMsg').textContent = 'Saving & loading…';
  try {
    await saveSettings(true);
    const r = await api('/api/refresh', { method: 'POST' });
    $('#refreshMsg').textContent = `✔ ${r.channels} channels in ${r.categories} categories`;
    loadCats(); loadChannels(true); dirtyGuide = true; gTrack = null;
  } catch (e) { $('#refreshMsg').textContent = '✘ ' + e.message; }
};
async function saveSettings(quiet) {
  const body = {
    source: { type: $('#sType').value, server: $('#sServer').value.trim(), username: $('#sUser').value.trim(), password: $('#sPass').value, m3uUrl: $('#sM3u').value.trim() },
    recordDir: $('#sDir').value.trim(), recordQuality: $('#sRecQ').value, liveQuality: $('#sLiveQ').value,
    padBeforeMin: +$('#sPadB').value || 0, padAfterMin: +$('#sPadA').value || 0,
    epgUrl: $('#sEpg').value.trim(), port: +$('#sPort').value, listenAll: $('#sListen').checked, ffmpegPath: $('#sFf').value.trim(), encoder: $('#sEnc').value,
    webPassword: $('#sWebPw').value, clearWebPassword: $('#sClearPw').checked,
    tmdbKey: $('#sTmdb').value.trim(), tmdbRegion: ($('#sRegion').value.trim() || 'US').toUpperCase(), movieDir: $('#sMovieDir').value.trim(), movieCheckHours: +$('#sMovieHrs').value || 3,
  };
  const r = await api('/api/settings', { method: 'PUT', body });
  if (!quiet) $('#setMsg').textContent = r.restartNeeded ? 'Saved. Restart the app for port/network changes.' : 'Saved.';
}
$('#setForm').onsubmit = async (e) => { e.preventDefault(); try { await saveSettings(); loadSettings(); } catch (err) { $('#setMsg').textContent = err.message; } };

// ---------- boot ----------
(async () => {
  const a = await fetch('/api/auth').then((r) => r.json());
  if (!a.ok) return showLogin();
  initGuide(); loadCats(); loadChannels(true); pollStatus(); countWatch();
  setInterval(pollStatus, 5000);
})();
