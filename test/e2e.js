'use strict';
// End-to-end: mock provider -> LuxxeTV server -> record 12s -> live HLS -> verify output with ffprobe-ish checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startMock, FILE_SIZE, fileByte } = require('./mock-xtream');
const { parseVodName, findMatch } = require('../server/vod');
const { parseProbe, plan } = require('../server/shrink');
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
  let app = await start({ dataDir: path.join(tmp, 'data'), port: 0 });
  let base = `http://127.0.0.1:${app.port}`;
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
  // Wait for real data (ffmpeg probes the input for a few seconds first) instead of a fixed delay.
  for (let i = 0; i < 40; i++) { const a = (await j('/api/record/status')).active[0]; if (!a || a.bytes > 50000) break; await sleep(500); }
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

  // movie info panel: TMDB first, the provider's own data otherwise
  const i1 = await j('/api/vod/movie/100');
  ok(i1.plot === 'A very big film.' && i1.director === 'Dee Rector' && i1.cast === 'Star One' && i1.runtime === 136 && /abc123XYZ00$/.test(i1.trailer), 'movie info from TMDB');
  await post('/api/settings', { clearTmdbKey: true }, 'PUT');
  const i2 = await j('/api/vod/movie/100');
  ok(i2.plot === 'The provider plot.' && i2.cast === 'Provider Cast' && i2.runtime === 90, 'movie info from the provider without a TMDB key');
  ok(!JSON.stringify(i2).includes('/u/p/'), 'no credentials leak in movie info');

  // ---- the download queue survives closing the app ----
  const gem = path.join(dlDir, 'Movies', 'Unknown Gem.mp4');
  mock.hold = true;
  await post('/api/downloads', { type: 'movie', id: '102' });
  for (let i = 0; i < 40 && !(fs.existsSync(gem + '.part') && fs.statSync(gem + '.part').size > 0); i++) await sleep(100);
  await app.shutdown();
  mock.hold = false; mock.ranges.length = 0;
  ok(fs.existsSync(gem + '.part'), 'closing the app keeps the partial download');
  app = await start({ dataDir: path.join(tmp, 'data'), port: 0 });
  base = `http://127.0.0.1:${app.port}`;
  d = await waitDl(1);
  ok(d.jobs.some((x) => x.rel.endsWith('Unknown Gem.mp4') && x.status === 'done') && d.jobs.length >= 5, 'queue and history restored after restart');
  ok(mock.ranges.includes('bytes=100000-') && fs.readFileSync(gem).equals(Buffer.alloc(300000, 7)), 'interrupted download resumed where it stopped');

  // a partial file nothing owns (e.g. left by an older version) can be resumed or deleted
  fs.unlinkSync(gem);
  fs.writeFileSync(gem + '.part', Buffer.alloc(5000, 7));
  fs.writeFileSync(path.join(dlDir, 'Movies', 'Gone.mkv.part'), 'x');
  d = await j('/api/downloads');
  ok(d.partials.length === 2 && d.partials.every((p) => p.resumable), 'unfinished downloads are listed');
  await post('/api/downloads/partial/resume', { f: 'Movies/Unknown Gem.mp4.part' });
  d = await waitDl(1);
  ok(fs.existsSync(gem) && fs.statSync(gem).size === 300000 && mock.ranges.includes('bytes=5000-'), 'unfinished download resumed');
  ok(/Could not find/.test((await post('/api/downloads/partial/resume', { f: 'Movies/Gone.mkv.part' })).error), 'unknown partial reported clearly');
  await j('/api/downloads/partial?f=' + encodeURIComponent('Movies/Gone.mkv.part'), { method: 'DELETE' });
  ok((await j('/api/downloads')).partials.length === 0, 'unfinished download deleted');

  // ---- shrinking large downloads ----
  const info = parseProbe(['  Duration: 02:00:00.50, start: 0.000000, bitrate: 55000 kb/s',
    '  Stream #0:0(eng): Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160',
    '  Stream #0:1(eng): Audio: truehd, 48000 Hz, 7.1, s32 (24 bit)', '  Stream #0:2(eng): Subtitle: subrip',
    '  Stream #0:3(eng): Subtitle: hdmv_pgs_subtitle', '  Stream #0:4: Video: mjpeg, yuvj420p (attached pic)'].join('\n'));
  ok(info.video === 0 && info.hdr && info.audio[0].channels === 8 && info.subs.join() === '2', 'reads video, HDR, surround audio and text subtitles');
  const bits = plan(info, 5e9);
  const planned = (bits.videoK + bits.audio.reduce((n, a) => n + a.kbps, 0)) * 1000 * info.duration / 8;
  ok(planned > 4.5e9 && planned <= 5e9, `2 hour movie planned at ${(planned / 1e9).toFixed(2)} GB`);

  await post('/api/settings', { shrinkGB: 0.0001 }, 'PUT');
  fs.unlinkSync(gem);
  await post('/api/downloads', { type: 'movie', id: '102' });
  const waitIdle = async () => { let x; for (let i = 0; i < 240; i++) { x = await j('/api/downloads'); if (x.jobs.every((y) => y.status === 'done' || y.status === 'failed' || y.status === 'cancelled')) break; await sleep(250); } return x; };
  d = await waitIdle();
  ok(/original kept/.test(d.jobs[0].note) && fs.statSync(gem).size === 300000, 'a file that cannot be re-encoded is kept as it was');

  await post('/api/settings', { shrinkGB: 0.001 }, 'PUT');
  const big = path.join(dlDir, 'Movies', 'Shrink Me.mkv');
  const srt = path.join(tmp, 'a.srt');
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nhello\n');
  const made = spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=10', '-f', 'lavfi', '-i', 'sine=duration=10', '-i', srt,
    '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4M', '-minrate', '4M', '-maxrate', '4M', '-bufsize', '1M', '-x264-params', 'nal-hrd=cbr', '-c:a', 'ac3', '-ac', '6', '-c:s', 'srt', '-y', big]);
  const before = made.status === 0 ? fs.statSync(big).size : 0;
  ok(before > 2e6, `test movie created (${(before / 1e6).toFixed(1)} MB)`);
  ok((await j('/api/downloads')).files.find((f) => f.name === 'Shrink Me.mkv').shrinkable, 'large file offered for shrinking');
  await post('/api/downloads/shrink', { f: 'Movies/Shrink Me.mkv' });
  d = await waitIdle();
  const small = big.replace(/mkv$/, 'mp4');
  const after = fs.existsSync(small) ? fs.statSync(small).size : 0;
  ok(after > 2e5 && after < 1.35e6 && !fs.existsSync(big), `shrunk to ${(after / 1e6).toFixed(2)} MB for a 1 MB target: ${d.jobs[0].note}`);
  const sp = spawnSync(ff.path, ['-hide_banner', '-i', small], { encoding: 'utf8' }).stderr;
  ok(/Video: h264/.test(sp) && /Audio: aac.*stereo/.test(sp) && /Subtitle: mov_text/.test(sp), 'shrunk file is H.264/AAC with its subtitles');
  ok(!fs.readdirSync(path.join(dlDir, 'Movies')).some((n) => n.endsWith('.part')), 'no temporary files left');
  await post('/api/settings', { shrinkGB: 0 }, 'PUT');

  // ---- movies: TMDB lists, streaming dates, watchlist auto-download ----
  const DAY = 86400000;
  await post('/api/settings', { clearTmdbKey: true, tmdbBase: '' }, 'PUT');
  mock.vod.splice(0, mock.vod.length, ...mock.releases);   // the settings change below drops the cached library
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
  const ri = await j('/api/movies/info/503');
  ok(ri.runtime === 136 && ri.director === 'Dee Rector' && ri.provider && ri.provider.id === '901' && ri.digital < Date.now(), 'release info: details, dates and the provider copy');

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
  const movieDir = path.join(dlDir, 'Movies');
  const a1 = await post('/api/watchlist', { tmdbId: 503 });
  ok(a1.status === 'waiting' && a1.title === 'Streamer', 'movie added to watchlist');
  ok((await post('/api/watchlist', { tmdbId: 503 })).tmdbId === 503 && (await j('/api/watchlist')).items.length === 1, 'adding twice does not duplicate');
  const w1 = await waitStatus(503, ['done', 'failed']);
  ok(w1 && w1.status === 'done' && w1.providerName === sm.items[0].onProvider, 'already-available movie downloaded immediately: ' + (w1 && (w1.error || w1.file)));
  ok(w1 && verifyFile(path.join(movieDir, w1.file)), 'downloaded movie is complete and byte-exact');
  ok(!fs.readdirSync(movieDir).some((n) => n.endsWith('.part')), 'no leftover .part file');
  ok((await j('/api/downloads')).files.some((f) => f.rel === 'Movies/' + w1.file), 'watchlist download shows up under Downloads');
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
