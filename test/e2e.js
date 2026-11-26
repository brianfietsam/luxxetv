'use strict';
// End-to-end: mock provider -> LuxxeTV server -> record 12s -> live HLS -> verify output with ffprobe-ish checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startMock, FILE_SIZE, fileByte } = require('./mock-xtream');
const { parseVodName, findMatch } = require('../server/vod');
process.env.LUXXETV_TMDB_BASE = 'http://127.0.0.1:9099/tmdb/3';
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

  await post('/api/settings', { padBeforeMin: 0, padAfterMin: 0 }, 'PUT');
  const sch = await post('/api/schedules', { channelId: '1', start: new Date(Date.now() + 2000).toISOString(), end: new Date(Date.now() + 60000).toISOString(), title: 'Scheduled Test' });
  ok(sch.id, 'programme scheduled');
  let started = null;
  for (let i = 0; i < 40 && !started; i++) { await sleep(1000); started = (await j('/api/record/status')).active[0]; }
  ok(started && started.title === 'Scheduled Test', 'scheduler started the recording on time');
  // Wait for real data (ffmpeg probes the input for a few seconds first) instead of a fixed delay.
  for (let i = 0; i < 40; i++) { const a = (await j('/api/record/status')).active[0]; if (!a || a.bytes > 50000) break; await sleep(500); }
  if (started) await post(`/api/record/${started.id}/stop`, {});
  for (let i = 0; i < 20; i++) { if (!(await j('/api/record/status')).active.length) break; await sleep(500); }
  const list2 = await j('/api/recordings');
  ok(list2.some((r) => r.name.includes('Scheduled Test') && r.size > 20000), 'scheduled recording file saved with program title');

  // ---- movies: TMDB lists, streaming dates, watchlist auto-download ----
  const DAY = 86400000;
  ok((await j('/api/movies?list=upcoming')).needsKey === true, 'movies ask for a TMDB key when none is set');
  await post('/api/settings', { tmdbKey: 'wrong' }, 'PUT');
  const badKey = await fetch(`${base}/api/movies?list=upcoming`);
  ok(badKey.status === 500 && /TMDB rejected/.test((await badKey.json()).error), 'bad TMDB key reported clearly');
  await post('/api/settings', { tmdbKey: 'tmdbkey', tmdbRegion: 'us' }, 'PUT');
  const st = await j('/api/settings');
  ok(st.tmdbKeySet === true && st.tmdbKey === '' && st.tmdbRegion === 'US', 'TMDB key stored server-side, never returned; region normalised');
  await post('/api/settings', { tmdbKey: '' }, 'PUT');
  ok((await j('/api/settings')).tmdbKeySet === true, 'blank TMDB key field keeps the saved key');

  const up = (await j('/api/movies?list=upcoming')).items;
  const fut = up.find((m) => m.id === 501);
  ok(up.length === 1 && fut && fut.title === 'Future Film', 'coming to theaters: lists upcoming release only');
  ok(fut && !fut.digital && fut.digitalEstimate - fut.theatrical === 45 * DAY, 'unannounced streaming date gets a labelled ~45-day estimate');
  const th = (await j('/api/movies?list=theaters')).items;
  ok(th.length === 1 && th[0].id === 502 && th[0].digital > Date.now() && th[0].certification === 'PG-13', 'in theaters: has announced streaming date (US, not GB)');
  let sm;
  for (let i = 0; i < 20; i++) { sm = await j('/api/movies?list=streaming'); if (sm.libraryLoaded && sm.items[0] && sm.items[0].onProvider) break; await sleep(500); }
  ok(sm.items.length === 2 && sm.items[0].id === 503 && sm.items[0].digital < Date.now() && sm.items[1].id === 502, 'streaming soon: recent + upcoming digital releases, by streaming date');
  ok(sm.items[0] && /^EN - Streamer \(\d{4}\)$/.test(sm.items[0].onProvider), 'already-on-provider badge picks the 1080p copy over 4K and wrong-year decoy');
  ok((await j('/api/movies/search?q=future')).items.some((m) => m.id === 501), 'search any movie');

  const waitStatus = async (id, want, secs = 30) => {
    let w;
    for (let i = 0; i < secs * 4; i++) { w = (await j('/api/watchlist')).items.find((x) => x.tmdbId === id); if (w && want.includes(w.status)) return w; await sleep(250); }
    return w;
  };
  const verifyFile = (f) => {
    const b = fs.readFileSync(f);
    if (b.length !== FILE_SIZE) return false;
    for (let i = 0; i < b.length; i += 4093) if (b[i] !== fileByte(i)) return false;
    return b[b.length - 1] === fileByte(b.length - 1);
  };
  const movieDir = path.join(tmp, 'rec', 'Movies');
  const a1 = await post('/api/watchlist', { tmdbId: 503 });
  ok(a1.status === 'waiting' && a1.title === 'Streamer', 'movie added to watchlist');
  ok((await post('/api/watchlist', { tmdbId: 503 })).tmdbId === 503 && (await j('/api/watchlist')).items.length === 1, 'adding twice does not duplicate');
  const w1 = await waitStatus(503, ['done', 'failed']);
  ok(w1 && w1.status === 'done' && w1.providerName === sm.items[0].onProvider, 'already-available movie downloaded immediately: ' + (w1 && (w1.error || w1.file)));
  ok(w1 && verifyFile(path.join(movieDir, w1.file)), 'downloaded movie is complete and byte-exact');
  ok(!fs.readdirSync(movieDir).some((n) => n.endsWith('.part')), 'no leftover .part file');
  const dl = await fetch(`${base}/dl/movie/503`, { headers: { Range: 'bytes=0-9' } });
  ok(dl.status === 206, 'downloaded movie plays in the web player (range requests)');

  const a2 = await post('/api/watchlist', { tmdbId: 502 });
  await sleep(1500);
  ok((await waitStatus(502, ['waiting'], 1)).status === 'waiting', 'CAM copy on provider is ignored; movie keeps waiting');
  mock.vod.push({ stream_id: 903, name: '|EN| Now Showing ' + new Date(th[0].theatrical).getUTCFullYear() + ' FHD', container_extension: 'mp4' });
  const chk = await post('/api/watchlist/check', {});
  ok(chk.lastCheck > 0 && !chk.lastError, 'manual provider check ran');
  const w2 = await waitStatus(502, ['done', 'failed']);
  ok(w2 && w2.status === 'done', 'movie downloaded as soon as it appeared on the provider: ' + (w2 && (w2.error || w2.file)));
  ok(mock.hits.filter((h) => h.id === 903).some((h) => h.range && h.range !== 'bytes=0-'), 'interrupted download resumed with a Range request');
  ok(w2 && verifyFile(path.join(movieDir, w2.file)), 'resumed download is byte-exact');
  ok((await j('/api/watchlist')).status.lastCheck > 0, 'watchlist reports last check time');

  ok((await post('/api/watchlist', { tmdbId: 'abc' })).error, 'invalid movie id rejected');
  const rm = await fetch(`${base}/api/watchlist/502?deleteFile=1`, { method: 'DELETE' });
  ok((await rm.json()).ok && !fs.existsSync(path.join(movieDir, w2.file)), 'remove with deleteFile deletes the movie file');
  ok((await fetch(`${base}/dl/movie/502`)).status === 404, 'removed movie no longer served');

  // title matching rules
  const yr = (n) => parseVodName(n);
  ok(yr('EN - Dune: Part Two (2024) [4K]').title === 'dune part two' && yr('EN - Dune: Part Two (2024) [4K]').year === 2024, 'parses "EN - Title (Year) [4K]"');
  ok(findMatch({ id: 1, title: 'TRON: Legacy', year: 2010 }, [{ p: yr('TRON: Legacy (2010)') }]), 'title with a colon is not mistaken for a tag');
  ok(!findMatch({ id: 1, title: 'Dune', year: 2021 }, [{ p: yr('EN - Dune (1984)') }]), 'remake with a different year not matched');
  ok(findMatch({ id: 7, title: 'Whatever', year: 2020 }, [{ tmdb: '7', p: yr('Totally Different Name') }]), 'provider tmdb id match wins');
  ok(!findMatch({ id: 1, title: 'Big Movie', year: 2026 }, [{ p: yr('Big.Movie.2026.HDTS.x264') }]), 'telesync rips skipped');

  // version info
  const sys = await j('/api/system');
  ok(sys.version === require('../package.json').version && sys.commit && sys.environment, `version info exposed: ${sys.version} ${sys.commit} ${sys.environment}`);

  // auth + LAN guard
  await post('/api/settings', { webPassword: 'secret' }, 'PUT');
  ok((await fetch(`${base}/api/channels`)).status === 401, 'API locked once password set');
  const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"x"}' });
  ok(bad.status === 401, 'wrong password rejected');
  const good = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"secret"}' });
  const cookie = good.headers.get('set-cookie').split(';')[0];
  ok((await fetch(`${base}/api/channels`, { headers: { cookie } })).status === 200, 'login grants access');
  ok((await fetch(`${base}/api/watchlist`)).status === 401 && (await fetch(`${base}/dl/movie/503`)).status === 401, 'movies API and downloads require login');

  await app.shutdown(); mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(process.exitCode ? 'FAILED' : 'ALL PASSED');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
