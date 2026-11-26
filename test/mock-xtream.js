'use strict';
// Minimal fake Xtream Codes server for testing: `npm run mock` (port 9099, user "u", pass "p").
const http = require('http');
const { spawn } = require('child_process');

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const FILE_SIZE = 3 * 1024 * 1024;
const fileByte = (i) => (i * 31 + 7) & 255;   // deterministic movie bytes so the test can verify the download

// Fake TMDB catalogue: one upcoming theatrical release, one in theaters (streaming soon), one already streaming.
function tmdbMovies() {
  const now = Date.now();
  return [
    { id: 501, title: 'Future Film', theatrical: now + 20 * DAY, digital: null, popularity: 80 },
    { id: 502, title: 'Now Showing', theatrical: now - 10 * DAY, digital: now + 25 * DAY, popularity: 60 },
    { id: 503, title: 'Streamer', theatrical: now - 60 * DAY, digital: now - 5 * DAY, popularity: 40 },
  ].map((m) => ({ ...m, release_date: ymd(m.theatrical), year: new Date(m.theatrical).getUTCFullYear() }));
}

function tmdb(u, req, res) {
  const key = u.searchParams.get('api_key') || (req.headers.authorization || '').replace(/^Bearer /, '');
  res.setHeader('Content-Type', 'application/json');
  if (key !== 'tmdbkey') { res.statusCode = 401; return res.end('{"status_message":"Invalid API key"}'); }
  const all = tmdbMovies();
  const brief = (m) => ({ id: m.id, title: m.title, original_title: m.title, release_date: m.release_date, popularity: m.popularity, poster_path: '/p' + m.id + '.jpg', overview: 'About ' + m.title, vote_count: 100, vote_average: 7.1 });
  const p = u.pathname.replace(/^\/tmdb\/3/, '');
  if (p === '/discover/movie') {
    const type = u.searchParams.get('with_release_type');
    const gte = Date.parse(u.searchParams.get('release_date.gte')), lte = Date.parse(u.searchParams.get('release_date.lte')) + DAY;
    const hit = all.filter((m) => { const d = type === '4' ? m.digital : m.theatrical; return d && d >= gte && d <= lte; });
    return res.end(JSON.stringify({ page: 1, total_pages: 1, results: hit.map(brief) }));
  }
  if (p === '/search/movie') {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    return res.end(JSON.stringify({ page: 1, total_pages: 1, results: all.filter((m) => m.title.toLowerCase().includes(q)).map(brief) }));
  }
  let m = /^\/movie\/(\d+)\/release_dates$/.exec(p);
  if (m) {
    const mv = all.find((x) => x.id === +m[1]);
    if (!mv) { res.statusCode = 404; return res.end('{}'); }
    const rd = [{ type: 3, release_date: new Date(mv.theatrical).toISOString(), certification: 'PG-13' }];
    if (mv.digital) rd.push({ type: 4, release_date: new Date(mv.digital).toISOString(), certification: '' });
    return res.end(JSON.stringify({ id: mv.id, results: [{ iso_3166_1: 'GB', release_dates: [{ type: 3, release_date: '2001-01-01T00:00:00.000Z' }] }, { iso_3166_1: 'US', release_dates: rd }] }));
  }
  m = /^\/movie\/(\d+)$/.exec(p);
  if (m) {
    const mv = all.find((x) => x.id === +m[1]);
    if (!mv) { res.statusCode = 404; return res.end('{}'); }
    return res.end(JSON.stringify(brief(mv)));
  }
  res.statusCode = 404; res.end('{}');
}

function startMock(port = 9099, ffmpeg = 'ffmpeg') {
  // Provider movie library; tests push entries to simulate a movie arriving.
  const vod = [
    { stream_id: 900, name: 'EN - Streamer (YEAR) 4K', container_extension: 'mp4' },
    { stream_id: 901, name: 'EN - Streamer (YEAR)', container_extension: 'mp4' },
    { stream_id: 902, name: 'EN - Now Showing (YEAR) HDCAM', container_extension: 'mp4' },
    { stream_id: 904, name: 'EN - Streamer (1999)', container_extension: 'mp4' },
  ];
  const yearOf = Object.fromEntries(tmdbMovies().map((m) => [m.title, m.year]));
  vod.forEach((v) => { v.name = v.name.replace('YEAR', yearOf[v.name.includes('Streamer') ? 'Streamer' : 'Now Showing']); });
  const drops = new Set([903]);   // first download of these is cut off mid-way to exercise resume
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/tmdb/3/')) return tmdb(u, req, res);
    const mv = /^\/movie\/u\/p\/(\d+)\.(\w+)$/.exec(u.pathname);
    if (mv) {
      const id = +mv[1];
      hits.push({ id, range: req.headers.range || null });
      if (!vod.some((v) => v.stream_id === id)) { res.statusCode = 404; return res.end(); }
      let start = 0;
      const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      if (r) start = +r[1];
      if (start >= FILE_SIZE) { res.writeHead(416, { 'Content-Range': `bytes */${FILE_SIZE}` }); return res.end(); }
      const headers = { 'Content-Type': 'video/mp4', 'Content-Length': FILE_SIZE - start, 'Accept-Ranges': 'bytes' };
      if (r) headers['Content-Range'] = `bytes ${start}-${FILE_SIZE - 1}/${FILE_SIZE}`;
      res.writeHead(r ? 206 : 200, headers);
      const buf = Buffer.alloc(FILE_SIZE - start);
      for (let i = 0; i < buf.length; i++) buf[i] = fileByte(start + i);
      if (drops.has(id)) { drops.delete(id); res.write(buf.subarray(0, 1024 * 1024)); setTimeout(() => res.destroy(), 50); return; }
      return res.end(buf);
    }
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== 'u' || u.searchParams.get('password') !== 'p') return res.end('{"user_info":{"auth":0}}');
      const a = u.searchParams.get('action');
      res.setHeader('Content-Type', 'application/json');
      if (a === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'Test' }, { category_id: '2', category_name: 'Other' }]));
      if (a === 'get_live_streams') return res.end(JSON.stringify([
        { stream_id: 1, name: 'Test Pattern HD', category_id: '1', stream_icon: '', epg_channel_id: 'Test.One' },
        { stream_id: 2, name: 'Second Channel', category_id: '2', stream_icon: '', epg_channel_id: '' }]));
      if (a === 'get_vod_streams') return res.end(JSON.stringify(vod));
      if (a === 'get_short_epg') return res.end(JSON.stringify({ epg_listings: [{ title: Buffer.from('Test Show').toString('base64'), description: Buffer.from('Fake EPG').toString('base64'), start_timestamp: String(Date.now() / 1000 - 600 | 0), stop_timestamp: String(Date.now() / 1000 + 1200 | 0) }] }));
      return res.end('{}');
    }
    if (u.pathname === '/xmltv.php') {
      // 30-minute programmes, from 2h ago to 48h ahead, timestamps written with a +0100 offset
      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (ms) => { const d = new Date(ms + 3600000); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0100`; };
      const base = Math.floor(Date.now() / 1800000) * 1800000 - 4 * 1800000;
      let x = '<?xml version="1.0"?>\n<tv><channel id="test.one"><display-name>One</display-name></channel>\n';
      for (let i = 0; i < 100; i++) {
        const s = base + i * 1800000;
        x += `<programme start="${fmt(s)}" stop="${fmt(s + 1800000)}" channel="test.one"><title lang="en">Show ${i} &amp; Friends</title><desc>Episode &#35;${i}</desc></programme>\n`;
        x += `<programme start="${fmt(s)}" stop="${fmt(s + 1800000)}" channel="not.ours"><title>Ignored</title></programme>\n`;
      }
      res.setHeader('Content-Type', 'application/xml');
      return res.end(x + '</tv>');
    }
    if (u.pathname.startsWith('/live/u/p/')) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      // 1280x720 25fps test pattern + tone, realtime, as MPEG-TS
      const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1'], { windowsHide: true });
      p.stdout.pipe(res);
      res.on('close', () => p.kill());
      return;
    }
    res.statusCode = 404; res.end();
  });
  srv.vod = vod; srv.hits = hits;
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

if (require.main === module) {
  const { findFfmpeg } = require('../server/ffmpeg');
  const ff = findFfmpeg('');
  startMock(9099, ff && ff.path).then(() => console.log('Mock Xtream on http://127.0.0.1:9099 (u/p)'));
}
module.exports = { startMock, FILE_SIZE, fileByte };
