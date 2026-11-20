'use strict';
// End-to-end: mock provider -> LuxxeTV server -> record 12s -> live HLS -> verify output with ffprobe-ish checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startMock } = require('./mock-xtream');
const { start } = require('../server');
const { findFfmpeg } = require('../server/ffmpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };

(async () => {
  const ff = findFfmpeg('');
  if (!ff) throw new Error('ffmpeg not found');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ltv-e2e-'));
  const mock = await startMock(9099, ff.path);
  const app = await start({ dataDir: path.join(tmp, 'data'), port: 0 });
  const base = `http://127.0.0.1:${app.port}`;
  const j = async (u, o) => (await fetch(base + u, o)).json();
  const post = (u, body, method = 'POST') => j(u, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await post('/api/settings', { source: { type: 'xtream', server: 'http://127.0.0.1:9099', username: 'u', password: 'p' },
    recordDir: path.join(tmp, 'rec'), recordQuality: 'balanced' }, 'PUT');

  const ch = await j('/api/channels?q=test');
  ok(ch.total === 1 && ch.items[0].name === 'Test Pattern HD', 'channel search');
  ok(!JSON.stringify(ch).includes('"p"'), 'no credentials leak in channel list');
  const epg = await j('/api/epg/1');
  ok(epg[0] && epg[0].title === 'Test Show', 'EPG decode');

  const r = await post('/api/record', { channelId: '1', minutes: 0.2 });
  ok(r.id, 'recording started');
  // live HLS while recording (second ffmpeg on the provider)
  const t0 = Date.now();
  const m3u8 = await fetch(`${base}/live/2/index.m3u8`);
  const text = await m3u8.text();
  ok(m3u8.status === 200 && text.includes('#EXTM3U'), `live HLS playlist ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const seg = text.split('\n').find((l) => l.endsWith('.ts'));
  const sr = await fetch(`${base}/live/2/${seg}`);
  ok(sr.status === 200 && (await sr.arrayBuffer()).byteLength > 1000, 'live segment served');

  for (let i = 0; i < 40; i++) { const s = await j('/api/record/status'); if (!s.active.length) break; await sleep(1000); }
  const list = await j('/api/recordings');
  ok(list.length === 1 && list[0].size > 50000, `recording saved: ${list[0] && list[0].name} (${list[0] && Math.round(list[0].size / 1024)} KB)`);
  const probe = spawnSync(ff.path, ['-hide_banner', '-i', path.join(tmp, 'rec', list[0].name)], { encoding: 'utf8' }).stderr;
  ok(/Video: h264/.test(probe) && /Audio: aac/.test(probe), 'output is H.264/AAC');
  ok(/Duration: 00:00:(0[89]|1\d)/.test(probe), 'duration ~12s: ' + (probe.match(/Duration: [\d:.]+/) || [''])[0]);
  const rng = await fetch(`${base}/rec/${encodeURIComponent(list[0].name)}`, { headers: { Range: 'bytes=0-99' } });
  ok(rng.status === 206, 'HTTP range playback (seeking)');

  // TV guide (XMLTV) + category hiding + scheduling from a guide entry
  let g;
  for (let i = 0; i < 30; i++) { g = await j('/api/guide?hours=6'); if (!g.loading) break; await sleep(500); }
  ok(g.rows && g.rows.length === 1 && g.rows[0].name === 'Test Pattern HD', 'guide lists only channels that have data');
  const p0 = g.rows[0].progs[0];
  ok(p0.t.includes('& Friends') && p0.d.startsWith('Episode #'), 'XMLTV entities decoded');
  const nowMs = Date.now();
  const cur = g.rows[0].progs.find((p) => p.s <= nowMs && p.e > nowMs);
  ok(cur && cur.e - cur.s === 1800000, 'timezone offset parsed (a programme is airing now)');
  ok((await j('/api/guide?only=0')).rows.length === 2, 'channels without guide data shown when requested');
  await post('/api/categories/hidden', { hidden: ['Other'] }, 'PUT');
  ok((await j('/api/guide?only=0')).rows.length === 1, 'hidden categories excluded from guide');
  await post('/api/categories/hidden', { hidden: [] }, 'PUT');

  // favorites: stored server-side, listed as a pseudo-category even with no guide data, ignoring hidden categories
  await j('/api/favorites/2', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"on":true}' });
  ok(JSON.stringify(await j('/api/favorites')) === '["2"]', 'favorite saved');
  await post('/api/categories/hidden', { hidden: ['Other'] }, 'PUT');
  const fg = await j('/api/guide?cat=__fav__');
  ok(fg.rows.length === 1 && fg.rows[0].name === 'Second Channel' && fg.rows[0].progs.length === 0, 'favorites guide lists the channel even without guide data or in a hidden category');
  await post('/api/categories/hidden', { hidden: [] }, 'PUT');
  await j('/api/favorites/2', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' });
  ok((await j('/api/favorites')).length === 0, 'favorite removed');
  const e1 = await j('/api/epg/1');
  ok(e1.length > 3 && e1[0].title.includes('& Friends'), 'player EPG uses the XMLTV guide (hours ahead)');

  await post('/api/settings', { padBeforeMin: 0, padAfterMin: 0 }, 'PUT');
  const sch = await post('/api/schedules', { channelId: '1', start: new Date(Date.now() + 2000).toISOString(), end: new Date(Date.now() + 60000).toISOString(), title: 'Scheduled Test' });
  ok(sch.id, 'programme scheduled');
  let started = null;
  for (let i = 0; i < 40 && !started; i++) { await sleep(1000); started = (await j('/api/record/status')).active[0]; }
  ok(started && started.title === 'Scheduled Test', 'scheduler started the recording on time');
  await sleep(4000);
  if (started) await post(`/api/record/${started.id}/stop`, {});
  for (let i = 0; i < 20; i++) { if (!(await j('/api/record/status')).active.length) break; await sleep(500); }
  const list2 = await j('/api/recordings');
  ok(list2.some((r) => r.name.includes('Scheduled Test') && r.size > 20000), 'scheduled recording file saved with program title');

  // ---- VOD: movies, series, box-office sort, downloads ----
  const dlDir = path.join(tmp, 'dl');
  await post('/api/settings', { downloadDir: dlDir, tmdbKey: 'testkey', tmdbBase: 'http://127.0.0.1:9099/tmdb' }, 'PUT');
  ok(!JSON.stringify(await j('/api/settings')).includes('testkey'), 'TMDB key not exposed by settings API');
  const mcats = await j('/api/vod/categories?kind=movies');
  ok(mcats.length === 2 && mcats[0].count >= 1, 'movie categories');
  let mv;
  for (let i = 0; i < 20; i++) { mv = await j('/api/vod/items?kind=movies&sort=boxoffice'); if (!mv.boxoffice.pending) break; await sleep(300); }
  mv = await j('/api/vod/items?kind=movies&sort=boxoffice');
  ok(mv.total === 3 && mv.items[0].name === 'Big Blockbuster' && mv.items[0].gross === 463000000, 'movies sorted by box office (tmdb id)');
  ok(mv.items[1].name === 'Small Drama' && mv.items[1].gross === 12000000, 'box office found by title search when no tmdb id');
  ok(mv.items[2].gross === null, 'unknown box office sorts last');
  ok((await j('/api/vod/items?kind=movies&sort=rating')).items[0].name === 'Small Drama', 'sort by rating');
  ok((await j('/api/vod/items?kind=movies&q=gem')).total === 1, 'movie search');
  ok(!JSON.stringify(mv).includes('"p"'), 'no credentials leak in movie list');
  const sr1 = await j('/api/vod/items?kind=series');
  ok(sr1.total === 1, 'series list');
  const show = await j('/api/vod/series/7');
  ok(show.seasons.length === 2 && show.seasons[0].episodes.length === 2, 'series seasons/episodes');

  const waitDl = async (n) => { let d; for (let i = 0; i < 40; i++) { d = await j('/api/downloads'); if (d.jobs.length >= n && d.jobs.every((x) => x.status === 'done' || x.status === 'failed')) break; await sleep(250); } return d; };
  await post('/api/downloads', { type: 'movie', id: mv.items[0].id });
  let d = await waitDl(1);
  ok(d.jobs[0].status === 'done' && d.files.some((f) => f.rel === 'Movies/Big Blockbuster (2003).mp4' && f.size === 300000), 'movie downloaded with Plex-style name');
  const q2 = await post('/api/downloads', { type: 'season', seriesId: '7', season: 1 });
  ok(q2.queued === 2, 'season queues 2 episodes');
  await post('/api/downloads', { type: 'series', seriesId: '7' });
  d = await waitDl(4);
  ok(d.files.some((f) => f.rel === 'TV Shows/Space Show/Season 01/Space Show - S01E02 - Orbit.mp4') && d.files.some((f) => f.rel.endsWith('Season 02/Space Show - S02E01 - Return.mkv')), 'show episodes saved by season');
  ok(d.files.length === 4 && d.jobs.every((x) => x.status === 'done'), 'whole-show download completes without duplicates');
  const dlr = await fetch(`${base}/dl?f=${encodeURIComponent('Movies/Big Blockbuster (2003).mp4')}`);
  ok(dlr.status === 200, 'downloaded file served');
  ok((await fetch(`${base}/dl?f=${encodeURIComponent('../config.json')}`)).status === 404, 'download path traversal blocked');
  await j('/api/downloads/file?f=' + encodeURIComponent('Movies/Big Blockbuster (2003).mp4'), { method: 'DELETE' });
  ok((await j('/api/downloads')).files.length === 3, 'downloaded file deleted');

  // watch in the browser: direct passthrough with Range, bad ids rejected
  const dr = await fetch(`${base}/vodplay/m-${mv.items[0].id}/direct`);
  ok(dr.status === 200 && dr.headers.get('content-type') === 'video/mp4' && (await dr.arrayBuffer()).byteLength === 300000, 'movie streams directly from provider');
  const dr2 = await fetch(`${base}/vodplay/e-501/direct?ext=mp4`, { headers: { Range: 'bytes=100-199' } });
  ok(dr2.status === 206 && dr2.headers.get('content-range') === 'bytes 100-299999/300000', 'episode direct stream honours Range (seeking)');
  ok((await fetch(`${base}/vodplay/x-1/direct`)).status === 500, 'bad vod key rejected');
  const hl = await fetch(`${base}/vodplay/e-601/index.m3u8?ext=mkv`);
  const hlText = await hl.text();
  ok(hl.status === 200 && hlText.includes('#EXTM3U') && hlText.includes('seg_'), 'mkv with AC3 converted to HLS for the browser');
  const hseg = hlText.split('\n').find((l) => l.endsWith('.ts'));
  const hs = await fetch(`${base}/vodplay/e-601/${hseg}`);
  ok(hs.status === 200 && (await hs.arrayBuffer()).byteLength > 1000, 'converted VOD segment served');
  // auth + LAN guard
  await post('/api/settings', { webPassword: 'secret' }, 'PUT');
  ok((await fetch(`${base}/api/channels`)).status === 401, 'API locked once password set');
  const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"x"}' });
  ok(bad.status === 401, 'wrong password rejected');
  const good = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"secret"}' });
  const cookie = good.headers.get('set-cookie').split(';')[0];
  ok((await fetch(`${base}/api/channels`, { headers: { cookie } })).status === 200, 'login grants access');

  await app.shutdown(); mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(process.exitCode ? 'FAILED' : 'ALL PASSED');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
