'use strict';
/* LuxxeTV web UI: category rail + time-ruled guide + player. No build step. */

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((k) => { if (k != null) e.append(k); });
  return e;
};
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
const dayLabel = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const stamp = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const snap30 = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0); return +d; };
const HOUR = 3600000;

const prefs = {
  get(k, d) { try { return localStorage.getItem('ltv.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ltv.' + k, v); } catch { /* private mode */ } },
};

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  if (r.status === 401) { showLogin(); throw new Error('Please sign in'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.style.background = bad ? 'var(--rec)' : ''; t.style.color = bad ? '#fff' : '';
  t.hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

/* ---------- login ---------- */
function showLogin() { $('#login').hidden = false; $('#loginPw').focus(); }
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/api/login', { method: 'POST', body: { password: $('#loginPw').value } }); location.reload(); }
  catch (err) { $('#loginErr').textContent = err.message; }
};

/* ---------- Metro press response: the tile tilts toward the pointer ---------- */
document.addEventListener('pointerdown', (e) => {
  const t = e.target.closest('.prog,.chan,.cat,#menu button,.item button,.nav button');
  if (!t || e.button > 0 || e.target.closest('.fav')) return;
  const b = t.getBoundingClientRect();
  t.style.setProperty('--rx', (-((e.clientY - b.top) / b.height - 0.5) * 8).toFixed(1) + 'deg');
  t.style.setProperty('--ry', (((e.clientX - b.left) / b.width - 0.5) * 8).toFixed(1) + 'deg');
  t.classList.add('tile-press');
  const off = () => { t.classList.remove('tile-press'); removeEventListener('pointerup', off); removeEventListener('pointercancel', off); };
  addEventListener('pointerup', off); addEventListener('pointercancel', off);
});

/* ---------- views ---------- */
let view = 'guide';
let dirtyGuide = false;
function setView(v) {
  view = v;
  document.querySelectorAll('#pivot button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => { s.hidden = s.id !== 'view-' + v; });
  $('#pivot button.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });   // the phone header scrolls sideways
  if (v === 'guide' && dirtyGuide) { dirtyGuide = false; loadGuide(true); }
  if (v === 'movies') openMovies();
  if (v === 'shows') openLib(v);
  if (v === 'downloads') loadDownloads();
  if (v === 'recordings') loadRecordings();
  if (v === 'schedule') loadSchedules();
  if (v === 'settings') loadSettings();
}
$('#pivot').onclick = (e) => e.target.dataset.view && setView(e.target.dataset.view);

/* ============================================================
   FAVORITES + CATEGORY RAIL
   ============================================================ */
const FAV = '__fav__';
let favs = new Set();
let cats = [];
const cur = { cat: FAV, q: '' };

async function loadFavs() { try { favs = new Set(await api('/api/favorites')); } catch { favs = new Set(); } }
async function setFav(id, on) {
  on ? favs.add(id) : favs.delete(id);
  updateFavCount();
  try { await api('/api/favorites/' + encodeURIComponent(id), { method: 'PUT', body: { on } }); }
  catch (e) { on ? favs.delete(id) : favs.add(id); updateFavCount(); toast(e.message, true); throw e; }
}
function updateFavCount() { const n = $('.cat.fav .n'); if (n) n.textContent = favs.size; }

async function loadRail() {
  try { cats = (await api('/api/categories')).sort((a, b) => a.name.localeCompare(b.name)); }
  catch { cats = []; }
  renderRail();
}
function renderRail() {
  const f = $('#catFind').value.toLowerCase().trim();
  const list = [el('button', { type: 'button', className: 'cat fav', onclick: () => selectCat(FAV) },
    el('span', { textContent: 'favorites' }), el('span', { className: 'n', textContent: favs.size }))];
  list[0].dataset.cat = FAV;
  cats.filter((c) => !f || c.name.toLowerCase().includes(f)).forEach((c) => {
    const b = el('button', { type: 'button', className: 'cat', title: c.name, onclick: () => selectCat(c.name) },
      el('span', { textContent: c.name }), el('span', { className: 'n', textContent: c.count }));
    b.dataset.cat = c.name; list.push(b);
  });
  $('#cats').replaceChildren(...list);
  markRail();
}
function markRail() {
  document.querySelectorAll('.cat').forEach((b) => b.classList.toggle('on', !cur.q && b.dataset.cat === cur.cat));
  $('.cat.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });   // keep the active category visible in the phone strip
}
function setTitle() {
  $('#paneTitle').textContent = cur.q ? 'search' : cur.cat === FAV ? 'favorites' : cur.cat;
  $('#paneTitle').title = cur.q ? `Results for "${cur.q}"` : '';
}
function selectCat(name) {
  cur.cat = name; cur.q = ''; $('#gq').value = '';
  prefs.set('cat', name);
  setTitle(); markRail(); loadGuide(true);
}
$('#catFind').oninput = renderRail;

let qt;
$('#gq').oninput = () => {
  clearTimeout(qt);
  qt = setTimeout(() => { cur.q = $('#gq').value.trim(); setTitle(); markRail(); loadGuide(true); }, 280);
};

/* ============================================================
   GUIDE
   ============================================================ */
let gFrom = 0, gOffset = 0, gTotal = 0, gBusy = false, gToken = 0, gSched = [];
let rowsList = [], progEls = [], gHours = 3;

function initDays() {
  const days = $('#gDay'); days.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const d = new Date(); d.setDate(d.getDate() + i); d.setHours(i === 0 ? 0 : 18, 0, 0, 0);
    days.append(el('option', { value: i === 0 ? 'now' : +d, textContent: i === 0 ? 'today' : i === 1 ? 'tomorrow' : d.toLocaleDateString([], { weekday: 'long' }).toLowerCase() }));
  }
}
const nowStart = () => snap30(Date.now());
const clampFrom = (ms) => Math.min(Math.max(ms, snap30(Date.now() - HOUR)), Date.now() + 70 * HOUR);
function jump(ms) { gFrom = clampFrom(ms); loadGuide(true); }
$('#gNow').onclick = () => { $('#gDay').value = 'now'; jump(nowStart()); };
$('#gPrev').onclick = () => jump(gFrom - 2 * HOUR);
$('#gNext').onclick = () => jump(gFrom + 2 * HOUR);
$('#gDay').onchange = () => jump($('#gDay').value === 'now' ? nowStart() : +$('#gDay').value);
$('#gOnly').onchange = () => loadGuide(true);

// The time ruler lives inside the scroll area (sticky), so its width always equals the program tracks'.
let gM = null;
const rulerShell = () => el('div', { className: 'ruler', 'aria-hidden': 'true' }, el('div', { className: 'sp' }), el('div', { className: 'tk' }));
function measure() {
  const track = Math.max(180, $('#rows .ruler .tk').clientWidth);
  const hours = track >= 640 ? 3 : 2;      // 3 hours on desktop / Tesla, 2 on tablets and phones
  return { track, hours, ppm: track / (hours * 60) };
}
function fillRuler(M) {
  const tk = $('#rows .ruler .tk'); tk.replaceChildren();
  const n = Date.now();
  const nowX = n >= gFrom && n < gFrom + M.hours * HOUR ? (n - gFrom) / 60000 * M.ppm : -1;
  const step = M.ppm * 30 >= 56 ? 30 : 60;
  for (let m = 0; m < M.hours * 60; m += step) {
    const x = m * M.ppm;
    if (nowX >= 0 && Math.abs(x - nowX) < 46 && x > 0) continue;   // keep the "now" tag clear of time labels
    const t = gFrom + m * 60000;
    const showDay = m === 0 && new Date(t).toDateString() !== new Date().toDateString();
    tk.append(el('span', { className: 't', style: `left:${x}px`, textContent: (showDay ? new Date(t).toLocaleDateString([], { weekday: 'short' }).toLowerCase() + ' ' : '') + clock(t) }));
  }
  if (nowX >= 0) tk.append(el('span', { className: 'now', style: `left:${nowX}px`, textContent: 'now' }));
}

function emptyState(kind, extra) {
  const m = {
    fav: ['no favorites yet', 'Tap the ☆ beside any channel to pin it here. Favorites are shared by everyone using this DVR.'],
    search: ['nothing found', `No channels match "${cur.q}".`],
    none: ['no guide data here', 'This category has no program data. Untick "only channels with guide data" to list its channels anyway.'],
    loading: ['loading guide', 'Downloading program data from your provider. The first time can take a minute.'],
    error: ['guide unavailable', extra || ''],
    setup: ['add your playlist', 'Open settings, enter your Xtream or M3U details, then reload the channel list.'],
  }[kind];
  return el('div', { className: 'empty' }, el('div', { className: 'big', textContent: m[0] }), el('p', { textContent: m[1] }));
}

let observer;
function watchSentinel() {
  if (observer) observer.disconnect();
  const s = $('#rows .sentinel'); if (!s) return;
  observer = new IntersectionObserver((en) => { if (en[0].isIntersecting && gOffset < gTotal) loadGuide(false); }, { root: $('#rows'), rootMargin: '240px' });
  observer.observe(s);
}

async function loadGuide(reset = true) {
  if (!reset && gBusy) return;
  if (reset) { gToken++; gOffset = 0; rowsList = []; progEls = []; }
  const tok = gToken; gBusy = true;
  if (!gFrom) gFrom = nowStart();
  if (reset) { $('#rows').replaceChildren(rulerShell()); gM = measure(); }
  const M = gM; gHours = M.hours;
  try {
    const q = cur.q;
    const r = await api(`/api/guide?from=${gFrom}&hours=${M.hours}&offset=${gOffset}&limit=40&only=${$('#gOnly').checked ? 1 : 0}&q=${encodeURIComponent(q)}&cat=${encodeURIComponent(q ? '' : cur.cat)}`);
    if (tok !== gToken) return;
    if (reset) gSched = await api('/api/schedules').catch(() => gSched);
    if (tok !== gToken) return;
    if (r.loading || r.error) {
      const rowsEl = $('#rows');
      if (r.loading) { rowsEl.replaceChildren(emptyState('loading')); setTimeout(() => view === 'guide' && tok === gToken && loadGuide(true), 4000); }
      else rowsEl.replaceChildren(emptyState('error', r.error + ' You can set a guide URL in settings.'));
      return;
    }
    gTotal = r.total;
    if (reset) {
      if (!r.total) { $('#rows').replaceChildren(emptyState(q ? 'search' : cur.cat === FAV ? 'fav' : 'none')); return; }
      fillRuler(M);
    }
    const rowsEl = $('#rows');
    rowsEl.querySelector('.sentinel')?.remove();
    r.rows.forEach((row, i) => {
      rowsList.push({ id: row.id, name: row.name, logo: row.logo });
      rowsEl.append(buildRow(row, r, M, i));
    });
    gOffset += r.rows.length;
    rowsEl.append(el('div', { className: 'sentinel' }));
    watchSentinel();
    tickProgress();
  } catch (e) {
    if (tok !== gToken) return;
    const needSetup = /not configured|No playlist|Login rejected/i.test(e.message);
    $('#rows').replaceChildren(needSetup ? emptyState('setup') : emptyState('error', e.message));
  } finally {
    if (tok === gToken) gBusy = false;
  }
}

function buildRow(row, r, M, i) {
  const fav = el('button', { type: 'button', className: 'fav' + (favs.has(row.id) ? ' on' : ''), textContent: favs.has(row.id) ? '★' : '☆',
    title: 'Favorite', 'aria-label': 'Favorite ' + row.name, 'aria-pressed': favs.has(row.id) });
  fav.onclick = async (ev) => {
    ev.stopPropagation();
    const on = !favs.has(row.id);
    try { await setFav(row.id, on); } catch { return; }
    fav.classList.toggle('on', on); fav.textContent = on ? '★' : '☆'; fav.setAttribute('aria-pressed', on);
    if (!on && cur.cat === FAV && !cur.q) { rowEl.remove(); toast(row.name + ' removed from favorites'); }
  };
  const chan = el('div', { className: 'chan', role: 'button', tabIndex: 0, title: 'Watch ' + row.name },
    fav, row.logo ? el('img', { src: row.logo, loading: 'lazy', alt: '', onerror() { this.remove(); } }) : null, el('span', { className: 'nm', textContent: row.name }));
  chan.onclick = () => playChannel(row);
  chan.onkeydown = (e) => { if (e.key === 'Enter' && e.target === chan) playChannel(row); };

  const track = el('div', { className: 'track' });
  row.progs.forEach((p) => track.append(progTile(row, p, r, M)));
  if (!row.progs.length) track.append(el('div', { className: 'nodata', textContent: 'no guide data' }));
  const rowEl = el('div', { className: 'grow' }, chan, track);
  rowEl.style.setProperty('--i', i);
  return rowEl;
}

const isSched = (cid, p) => gSched.some((x) => x.channelId === cid && x.start === p.s);

function progTile(row, p, r, M) {
  const s = Math.max(p.s, r.from), e = Math.min(p.e, r.to);
  const w = (e - s) / 60000 * M.ppm - 2;
  const now = Date.now();
  const airing = p.s <= now && p.e > now;
  const b = el('button', { type: 'button', className: 'prog' + (airing ? ' now' : '') + (isSched(row.id, p) ? ' sched' : ''), title: p.t },
    el('span', { className: 'ti', textContent: p.t }), w >= 110 ? el('span', { className: 'tm', textContent: clock(p.s) }) : null);
  b.style.left = (s - r.from) / 60000 * M.ppm + 'px';
  b.style.width = Math.max(4, w) + 'px';
  if (airing) { const bar = el('i', { className: 'bar' }); b.append(bar); progEls.push({ bar, s: p.s, e: p.e }); }
  b.onclick = (ev) => openMenu(ev, row, p, b);
  b.oncontextmenu = (ev) => { ev.preventDefault(); openMenu(ev, row, p, b); };   // right-click, and long-press on touch
  return b;
}

function tickProgress() {
  const n = Date.now();
  progEls.forEach(({ bar, s, e }) => bar.style.setProperty('--p', Math.max(0, Math.min(100, (n - s) / (e - s) * 100)) + '%'));
}
setInterval(tickProgress, 30000);
setInterval(() => { if (view === 'guide' && $('#stage').hidden && $('#menu').hidden && $('#rows').scrollTop < 40) loadGuide(true); }, 10 * 60000);
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => view === 'guide' && loadGuide(true), 300); });

/* ---------- share a channel as an M3U link ---------- */
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  const ta = el('textarea', { value: text, readOnly: true });
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
  document.body.append(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
  let done = false;
  try { done = document.execCommand('copy'); } catch { done = false; }
  ta.remove();
  return done;
}
async function shareChannel(ch) {
  try {
    const r = await api('/api/share/' + encodeURIComponent(ch.id));
    const url = location.origin + r.path;
    if (await copyText(url)) toast(`M3U link for ${ch.name} copied${r.lanOnly ? '. Works on your home network only until you set a web password' : ''}`);
    else window.prompt('Copy this M3U link for ' + ch.name, url);   // no clipboard access (plain http on some browsers)
  } catch (e) { toast(e.message, true); }
}

/* ---------- action sheet: click, right-click or long-press a program ---------- */
function closeMenu() { $('#menu').hidden = true; }
function openMenu(ev, row, p, tile) {
  closeMenu();
  const now = Date.now(), airing = p.s <= now && p.e > now;
  const existing = gSched.find((x) => x.channelId === row.id && x.start === p.s);
  const act = (label, cls, fn, dot) => el('button', { type: 'button', className: cls || '', onclick: () => { closeMenu(); fn(); } }, dot ? el('i', { className: 'dot' }) : null, label);
  const items = [el('div', { className: 'hd' },
    el('b', { textContent: p.t }),
    el('div', { className: 'muted', textContent: `${row.name} · ${dayLabel(p.s)} ${clock(p.s)} to ${clock(p.e)}${airing ? ' · on now' : ''}` }),
    p.d ? el('p', { textContent: p.d }) : null)];
  if (airing) items.push(act('watch now', 'go', () => playChannel(row)));
  items.push(act('copy m3u link for ' + row.name, '', () => shareChannel(row)));
  if (existing) items.push(act('cancel this recording', '', () => unschedule(existing, tile)));
  else {
    items.push(act(airing ? 'record from now' : 'record', '', () => schedule(row, p, 'none', tile), true));
    items.push(act('record every day at this time', '', () => schedule(row, p, 'daily', tile), true));
    items.push(act('record every week at this time', '', () => schedule(row, p, 'weekly', tile), true));
  }
  const m = $('#menu');
  m.replaceChildren(...items);
  m.hidden = false;
  const coarse = matchMedia('(pointer:coarse), (hover:none)').matches || innerWidth < 600;
  if (coarse) { Object.assign(m.style, { left: '0', right: '0', top: 'auto', bottom: '0', width: '100%' }); }
  else {
    const rect = tile.getBoundingClientRect();
    const cx = ev.clientX || rect.left + 12, cy = ev.clientY || rect.bottom;
    m.style.width = ''; m.style.right = 'auto'; m.style.bottom = 'auto';
    m.style.left = Math.max(8, Math.min(cx, innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(cy, innerHeight - m.offsetHeight - 8)) + 'px';
  }
  m.querySelector('button')?.focus({ preventScroll: true });
}
addEventListener('pointerdown', (e) => { if (!$('#menu').hidden && !e.target.closest('#menu')) closeMenu(); }, true);
$('#rows').addEventListener('scroll', closeMenu, { passive: true });

async function schedule(row, p, repeat, tile) {
  try {
    const s = await api('/api/schedules', { method: 'POST', body: { channelId: row.id, start: new Date(p.s).toISOString(), end: new Date(p.e).toISOString(), title: p.t, repeat } });
    gSched.push(s); tile && tile.classList.add('sched');
    const airing = p.s <= Date.now() && p.e > Date.now();
    toast(airing ? `Recording ${p.t} starts within 15 seconds` : `Scheduled: ${p.t}, ${dayLabel(p.s)} ${clock(p.s)}${repeat === 'none' ? '' : ' (' + repeat + ')'}`);
    if (airing) setTimeout(pollStatus, 17000);
  } catch (e) { toast(e.message, true); }
}
async function unschedule(s, tile) {
  try { await api('/api/schedules/' + s.id, { method: 'DELETE' }); gSched = gSched.filter((x) => x.id !== s.id); tile && tile.classList.remove('sched'); toast('Recording cancelled'); }
  catch (e) { toast(e.message, true); }
}

/* ============================================================
   PLAYER
   ============================================================ */
let hls = null, stageChan = null;
const video = $('#video');
function stopVideo() {
  video.onerror = null;
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src'); video.load();
}
function attach(src) {
  stopVideo();
  const status = (m) => { $('#stStatus').textContent = m; };
  status('Starting stream… the first picture takes about 10 seconds.');
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
  } else { video.src = src; video.play().catch(() => {}); }
}
function openStage(title, actions, src) {
  $('#stTitle').textContent = title;
  $('#stActions').replaceChildren(...actions);
  $('#stNext').replaceChildren();
  $('#stage').hidden = false;
  attach(src);
  $('#stClose').focus({ preventScroll: true });
}
function closeStage() { stopVideo(); $('#stage').hidden = true; stageChan = null; }
$('#stClose').onclick = closeStage;

function zap(dir) {
  if (!stageChan) return;
  const i = rowsList.findIndex((c) => c.id === stageChan.id);
  const n = rowsList[i + dir];
  if (n) playChannel(n);
}

async function nowTitle(id) {
  try {
    const e = await api('/api/epg/' + encodeURIComponent(id)), now = Date.now();
    return (e.find((x) => x.start <= now && x.end > now) || {}).title || '';
  } catch { return ''; }
}
function playChannel(ch) {
  stageChan = ch;
  const favBtn = el('button', { type: 'button', textContent: favs.has(ch.id) ? '★ favorite' : '☆ favorite' });
  favBtn.onclick = async () => {
    const on = !favs.has(ch.id);
    try { await setFav(ch.id, on); favBtn.textContent = on ? '★ favorite' : '☆ favorite'; dirtyGuide = true; } catch { /* toasted */ }
  };
  const sel = el('select', { 'aria-label': 'Recording length' },
    ...[['until I stop', 0], ['30 minutes', 30], ['1 hour', 60], ['2 hours', 120], ['3 hours', 180]].map(([l, v]) => el('option', { value: v, textContent: l })));
  const rec = el('button', { type: 'button', className: 'rec', textContent: '● record' });
  rec.onclick = async () => {
    try { await api('/api/record', { method: 'POST', body: { channelId: ch.id, minutes: +sel.value, title: await nowTitle(ch.id) } }); rec.textContent = '● recording'; toast('Recording ' + ch.name); pollStatus(); }
    catch (e) { toast(e.message, true); }
  };
  const share = el('button', { type: 'button', textContent: '⧉ copy m3u link', title: 'Copy a link others can open in VLC or an IPTV app', onclick: () => shareChannel(ch) });
  openStage(ch.name, [favBtn, share, sel, rec,
    el('button', { type: 'button', textContent: '▲ previous', onclick: () => zap(-1) }),
    el('button', { type: 'button', textContent: '▼ next', onclick: () => zap(1) })],
  `/live/${encodeURIComponent(ch.id)}/index.m3u8`);
  api('/api/epg/' + encodeURIComponent(ch.id)).then((list) => {
    if (stageChan !== ch) return;
    const n = Date.now();
    const upcoming = list.filter((e) => e.end > n).slice(0, 4);
    $('#stNext').replaceChildren(...upcoming.map((e, i) => el('div', {},
      el('b', { textContent: e.title }), el('span', { className: 'muted', textContent: `${i === 0 && e.start <= n ? 'now · ' : ''}${clock(e.start)} to ${clock(e.end)}` }))));
  }).catch(() => {});
}

/* ---------- keyboard (desktop speed) ---------- */
addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === 'Escape') { if (!$('#sheet').hidden) sheetClose(); else if (!$('#menu').hidden) closeMenu(); else if (!$('#stage').hidden) closeStage(); return; }
  if (!$('#stage').hidden && !typing) {
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); zap(-1); }
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); zap(1); }
    return;
  }
  if (e.key === '/' && !typing) { e.preventDefault(); setView('guide'); $('#gq').focus(); }
});

/* ============================================================
   RECORDINGS
   ============================================================ */
async function pollStatus() {
  try {
    const s = await api('/api/record/status');
    const bt = `recording ${s.active.length}`;
    if ($('#recbadge').hidden !== !s.active.length) $('#recbadge').hidden = !s.active.length;
    if ($('#recText').textContent !== bt) $('#recText').textContent = bt;
    if (view === 'recordings') renderActive(s);
  } catch { /* ignore */ }
}
let activeSig = '';
function activeInfo(r) {
  return `${fmtSize(r.bytes)} · started ${stamp(r.startedAt)}${r.endAt ? ' · ends ' + clock(r.endAt) : ''}${r.status === 'processing' ? ' · removing commercials…' : ''}`;
}
function renderActive(s) {
  // rebuild only when recordings start/stop; otherwise patch text so the stop button doesn't flicker
  const sig = s.active.map((r) => r.id + r.status).join() + '|' + s.recent.filter((r) => r.error).slice(0, 3).map((r) => r.id).join();
  if (sig === activeSig) {
    s.active.forEach((r) => { const n = document.querySelector('.rec-' + r.id); if (n && n.textContent !== activeInfo(r)) n.textContent = activeInfo(r); });
    return;
  }
  activeSig = sig;
  $('#active').replaceChildren(
    ...s.active.map((r) => el('div', { className: 'item live' },
      el('div', { className: 't' }, el('b', { textContent: r.title || r.name }),
        r.title ? el('div', { className: 'muted', textContent: r.name }) : null,
        el('div', { className: 'muted rec-' + r.id, textContent: activeInfo(r) })),
      el('button', { type: 'button', textContent: 'stop', onclick: async () => { await api(`/api/record/${r.id}/stop`, { method: 'POST' }); setTimeout(() => { pollStatus(); loadRecordings(); }, 1500); } }))),
    ...s.recent.filter((r) => r.error).slice(0, 3).map((r) => el('div', { className: 'item' }, el('div', { className: 't' }, el('span', { className: 'err', textContent: `${r.title || r.name}: ${r.error}` })))));
}
async function loadRecordings() {
  const list = await api('/api/recordings').catch(() => []);
  renderActive(await api('/api/record/status').catch(() => ({ active: [], recent: [] })));
  $('#recList').replaceChildren(...(list.length ? list.map((r) => el('div', { className: 'item' },
    el('div', { className: 't' }, el('b', { textContent: r.name }), el('div', { className: 'muted', textContent: `${fmtSize(r.size)} · ${stamp(r.mtime)}${r.recording ? ' · recording' : ''}` })),
    r.playable
      ? el('button', { type: 'button', className: 'solid', textContent: '▶ play', onclick: () => {
        stageChan = null;
        openStage(r.name.replace(/\.mp4$/i, ''), [el('a', { className: 'btn', href: `/rec/${encodeURIComponent(r.name)}?download=1`, textContent: 'download' })], `/rec/${encodeURIComponent(r.name)}`);
      } })
      : el('a', { className: 'btn', href: `/rec/${encodeURIComponent(r.name)}?download=1`, textContent: 'download (mkv)' }),
    el('button', { type: 'button', textContent: 'delete', disabled: r.recording, onclick: async () => { if (confirm('Delete ' + r.name + '?')) { await api('/api/recordings/' + encodeURIComponent(r.name), { method: 'DELETE' }); loadRecordings(); } } })))
    : [el('div', { className: 'empty' }, el('div', { className: 'big', textContent: 'no recordings yet' }), el('p', { textContent: 'Right-click any program in the guide to record it.' }))]));
}

/* ============================================================
   SCHEDULE (manual form + list)
   ============================================================ */
let pickedCh = null;
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
  if (!$('#sStart').value) {
    const d = new Date(Date.now() + HOUR); d.setMinutes(0, 0, 0);
    const iso = (x) => new Date(x - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('#sStart').value = iso(d); $('#sEnd').value = iso(new Date(+d + HOUR));
  }
  const l = await api('/api/schedules').catch(() => []);
  $('#schedList').replaceChildren(...(l.length ? l.map((s) => el('div', { className: 'item' },
    el('div', { className: 't' }, el('b', { textContent: s.title || s.channelName }),
      el('div', { className: 'muted', textContent: `${stamp(s.start)} to ${clock(s.end)} · ${s.repeat === 'none' ? 'once' : s.repeat} · ${s.channelName}${s.lastError ? ' · ' + s.lastError : ''}` })),
    el('button', { type: 'button', textContent: 'remove', onclick: async () => { await api('/api/schedules/' + s.id, { method: 'DELETE' }); loadSchedules(); } })))
    : [el('div', { className: 'empty' }, el('div', { className: 'big', textContent: 'nothing scheduled' }))]));
}

/* ============================================================
   SETTINGS
   ============================================================ */
const ACCENTS = [['teal', 'oklch(0.52 0.11 215)'], ['blue', 'oklch(0.52 0.13 255)'], ['green', 'oklch(0.5 0.11 150)'], ['magenta', 'oklch(0.5 0.16 335)'], ['orange', 'oklch(0.5 0.12 52)']];
function applyPrefs() {
  document.documentElement.dataset.accent = prefs.get('accent', 'teal');
  document.documentElement.dataset.theme = prefs.get('theme', 'auto');
  document.querySelectorAll('#accents button').forEach((b) => b.setAttribute('aria-checked', b.dataset.accent === document.documentElement.dataset.accent));
  document.querySelectorAll('#themes button').forEach((b) => b.setAttribute('aria-checked', b.dataset.theme === document.documentElement.dataset.theme));
}
$('#accents').replaceChildren(...ACCENTS.map(([name, color]) => {
  const b = el('button', { type: 'button', title: name, role: 'radio', 'aria-label': name, onclick: () => { prefs.set('accent', name); applyPrefs(); } });
  b.dataset.accent = name; b.style.background = color; return b;
}));
$('#themes').onclick = (e) => { const t = e.target.dataset.theme; if (t) { prefs.set('theme', t); applyPrefs(); } };
$('#themes').querySelectorAll('button').forEach((b) => b.setAttribute('role', 'radio'));

let allCats = [];
async function saveHidden() {
  await api('/api/categories/hidden', { method: 'PUT', body: { hidden: allCats.filter((c) => c.hidden).map((c) => c.name) } });
  dirtyGuide = true; catSummary(); loadRail();
}
const catSummary = () => { $('#catSummary').textContent = allCats.length ? `${allCats.filter((c) => !c.hidden).length} of ${allCats.length} categories shown` : ''; };
function renderCatPanel() {
  const f = $('#catFilter').value.toLowerCase();
  $('#catList').replaceChildren(...allCats.filter((c) => c.name.toLowerCase().includes(f)).map((c) => {
    const cb = el('input', { type: 'checkbox', checked: !c.hidden, onchange: async () => { c.hidden = !cb.checked; await saveHidden(); } });
    return el('label', {}, cb, el('span', { textContent: c.name }), el('small', { textContent: c.count }));
  }));
}
$('#manageCats').onclick = async () => {
  const p = $('#catPanel');
  if (!p.hidden) { p.hidden = true; return; }
  try {
    allCats = (await api('/api/categories?all=1')).sort((a, b) => a.name.localeCompare(b.name));
    $('#catFilter').value = ''; renderCatPanel(); catSummary(); p.hidden = false;
  } catch (e) { $('#catSummary').textContent = 'Save your playlist and press "test & reload" first (' + e.message + ')'; }
};
$('#catFilter').oninput = renderCatPanel;
const bulk = (hide) => async () => {
  const f = $('#catFilter').value.toLowerCase();
  allCats.forEach((c) => { if (c.name.toLowerCase().includes(f)) c.hidden = hide; });
  await saveHidden(); renderCatPanel();
};
$('#catShowAll').onclick = bulk(false);
$('#catHideAll').onclick = bulk(true);

const typeUi = () => { $('#xtreamF').hidden = $('#sType').value !== 'xtream'; $('#m3uF').hidden = $('#sType').value !== 'm3u'; };
$('#sType').onchange = typeUi;
if (window.desktop) { $('#browseDl').hidden = false; $('#browseDl').onclick = async () => { const d = await window.desktop.pickFolder(); if (d) $('#sDlDir').value = d; }; }
if (window.desktop) { $('#browse').hidden = false; $('#browse').onclick = async () => { const d = await window.desktop.pickFolder(); if (d) $('#sDir').value = d; }; }
if (window.desktop) { $('#browseMovies').hidden = false; $('#browseMovies').onclick = async () => { const d = await window.desktop.pickFolder(); if (d) $('#sMovieDir').value = d; }; }

async function loadSettings() {
  const [c, sys] = await Promise.all([api('/api/settings'), api('/api/system')]);
  $('#sType').value = c.source.type; typeUi();
  $('#sServer').value = c.source.server; $('#sUser').value = c.source.username; $('#sM3u').value = c.source.m3uUrl;
  $('#sPass').placeholder = c.source.passwordSet ? '(saved, leave blank to keep)' : '';
  $('#sDlDir').value = c.downloadDir; $('#sTmdb').placeholder = c.tmdbKeySet ? '(saved, leave blank to keep)' : '(not set)';
  $('#sTmdb').value = ''; $('#sClearTmdb').checked = false;
  $('#sRegion').value = c.tmdbRegion || 'US'; $('#sMovieDir').value = c.movieDir || ''; $('#sMovieHrs').value = c.movieCheckHours;
  $('#sShrink').value = String(c.shrinkGB || 0);
  if (!$('#sShrink').value) { $('#sShrink').append(el('option', { value: c.shrinkGB, textContent: `Shrink to about ${c.shrinkGB} GB` })); $('#sShrink').value = String(c.shrinkGB); }
  $('#sDir').value = c.recordDir; $('#sRecQ').value = c.recordQuality; $('#sLiveQ').value = c.liveQuality;
  $('#sPadB').value = c.padBeforeMin; $('#sPadA').value = c.padAfterMin;
  $('#sWebPw').placeholder = c.webPasswordSet ? '(saved, leave blank to keep)' : 'none (LAN only)';
  $('#sPort').value = c.port; $('#sListen').checked = c.listenAll; $('#sFf').value = c.ffmpegPath; $('#sComm').value = c.commSkip || 'off'; $('#sCs').value = c.comskipPath || ''; $('#sEpg').value = c.epgUrl || '';
  $('#sEnc').replaceChildren(...(sys.encoders.length ? sys.encoders : ['libx264']).map((e) => el('option', { value: e, textContent: e === 'libx264' ? 'libx264 (CPU, best compression)' : e + ' (GPU)' })));
  $('#sEnc').value = c.encoder;
  $('#sys').textContent = sys.ffmpeg ? `✔ ${sys.ffmpeg}` : '✘ ffmpeg not found: install it or set the path above.';
  $('#urls').replaceChildren(el('h2', { textContent: 'open on your tesla or phone' }),
    el('div', { className: 'muted', textContent: `At home (same Wi-Fi): http://<this-PC-IP>:${sys.port}/   (this page: ${location.origin})` }),
    el('div', { className: 'muted', textContent: 'Away from home: put a Cloudflare Tunnel or similar in front of this port, and set a web password first. See the README.' }));
  $('#about').replaceChildren(el('h2', { textContent: 'about luxxetv' }),
    el('div', { className: 'muted', textContent: `Version: ${sys.version}` }),
    el('div', { className: 'muted', textContent: `Commit: ${sys.commit}` }),
    el('div', { className: 'muted', textContent: `Environment: ${sys.environment}` }),
    el('div', { className: 'muted', textContent: `Build date: ${sys.buildDate ? new Date(sys.buildDate).toLocaleDateString() : 'development build'}` }));
}
$('#refresh').onclick = async () => {
  $('#refreshMsg').textContent = 'Saving and loading…';
  try {
    await saveSettings(true);
    const r = await api('/api/refresh', { method: 'POST' });
    $('#refreshMsg').textContent = `✔ ${r.channels} channels in ${r.categories} categories`;
    await loadRail(); dirtyGuide = true; LIB.movies.init = LIB.shows.init = false;   // movie/show lists reload on next visit
  } catch (e) { $('#refreshMsg').textContent = '✘ ' + e.message; }
};
async function saveSettings(quiet) {
  const body = {
    source: { type: $('#sType').value, server: $('#sServer').value.trim(), username: $('#sUser').value.trim(), password: $('#sPass').value, m3uUrl: $('#sM3u').value.trim() },
    downloadDir: $('#sDlDir').value.trim(), tmdbKey: $('#sTmdb').value.trim(), clearTmdbKey: $('#sClearTmdb').checked,
    shrinkGB: +$('#sShrink').value,
    tmdbRegion: ($('#sRegion').value.trim() || 'US').toUpperCase(), movieDir: $('#sMovieDir').value.trim(), movieCheckHours: +$('#sMovieHrs').value || 3,
    recordDir: $('#sDir').value.trim(), recordQuality: $('#sRecQ').value, liveQuality: $('#sLiveQ').value,
    padBeforeMin: +$('#sPadB').value || 0, padAfterMin: +$('#sPadA').value || 0,
    epgUrl: $('#sEpg').value.trim(), port: +$('#sPort').value, listenAll: $('#sListen').checked, ffmpegPath: $('#sFf').value.trim(), commSkip: $('#sComm').value, comskipPath: $('#sCs').value.trim(), encoder: $('#sEnc').value,
    webPassword: $('#sWebPw').value, clearWebPassword: $('#sClearPw').checked,
  };
  const r = await api('/api/settings', { method: 'PUT', body });
  if (!quiet) $('#setMsg').textContent = r.restartNeeded ? 'Saved. Restart the app for port/network changes.' : 'Saved.';
}
$('#shareReset').onclick = async () => {
  if (!confirm('Stop every channel link you have shared? New links will be different.')) return;
  try { await api('/api/share/reset', { method: 'POST' }); $('#shareMsg').textContent = '✔ All share links reset. Old links no longer work.'; }
  catch (e) { $('#shareMsg').textContent = '✘ ' + e.message; }
};
$('#setForm').onsubmit = async (e) => { e.preventDefault(); try { await saveSettings(); loadSettings(); } catch (err) { $('#setMsg').textContent = err.message; } };

/* ============================================================
   INSTALL AS AN APP (PWA)
   ============================================================ */
let installPrompt = null;
function paintInstall() {
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  $('#install').hidden = !!window.desktop || installed;   // nothing to offer inside the desktop app or the installed one
  $('#installBtn').hidden = !installPrompt;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('#installHelp').textContent = installPrompt ? 'Put LuxxeTV on this device with its own icon and full screen.'
    : ios ? 'In Safari, tap Share, then “Add to Home Screen”.'
      : window.isSecureContext ? 'Open your browser’s menu and choose “Install app” or “Add to Home screen”.'
        : 'A full install needs an https:// address (see the README). Over plain http, your browser’s “Add to Home screen” makes a shortcut.';
}
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; paintInstall(); });
addEventListener('appinstalled', () => { installPrompt = null; $('#install').hidden = true; });
$('#installBtn').onclick = async () => {
  const p = installPrompt;
  if (!p) return;
  installPrompt = null;   // a prompt can be used only once
  p.prompt();
  await p.userChoice;
  paintInstall();
};
paintInstall();
if ('serviceWorker' in navigator && window.isSecureContext && !window.desktop) navigator.serviceWorker.register('/sw.js').catch(() => { /* the app works without it */ });

/* ============================================================
   BOOT
   ============================================================ */
(async () => {
  applyPrefs();
  const a = await fetch('/api/auth').then((r) => r.json()).catch(() => ({ ok: false }));
  if (!a.ok) return showLogin();
  initDays();
  await Promise.all([loadFavs(), loadRail()]);
  const saved = prefs.get('cat', FAV);
  cur.cat = saved === FAV || cats.some((c) => c.name === saved) ? saved : FAV;
  if (cur.cat === FAV && !favs.size && cats[0]) cur.cat = cats[0].name;   // nothing pinned yet: start on a real category
  setTitle(); markRail();
  loadGuide(true); pollStatus(); countWatch();
  setInterval(pollStatus, 5000);
})();
