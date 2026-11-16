'use strict';
// Minimal fake Xtream Codes server for testing: `npm run mock` (port 9099, user "u", pass "p").
const http = require('http');
const { spawn } = require('child_process');

// Rich mode (npm run mock): 14 channels in 4 categories with varied-length programmes, for visual checks.
const RICH_CATS = [['1', 'Sports'], ['2', 'News'], ['3', 'Movies'], ['4', 'Kids']];
const RICH_CHANNELS = [
  ['Arena Sports 1', '1'], ['Arena Sports 2', '1'], ['Motor Racing HD', '1'], ['Golf Channel', '1'],
  ['World News 24', '2'], ['Daily Headlines', '2'], ['Business Report', '2'],
  ['Cinema Classics', '3'], ['Action Movies HD', '3'], ['Late Night Cinema', '3'], ['Indie Film', '3'],
  ['Toon Parade', '4'], ['Little Explorers', '4'], ['Storytime TV', '4'],
];
const TITLES = ['Morning Report', 'The Big Match', 'Grand Prix Live', 'Highlights Show', 'Evening News', 'Market Watch', 'The Long Goodbye', 'Night Heist', 'Space Pups', 'Bedtime Stories', 'Weather and Traffic', 'Documentary: Deep Blue', 'Studio Sessions', 'Cooking With Fire', 'Late Edition', 'Coastal Walks', 'Championship Replay', 'Kids Quiz', 'Detective Mara', 'The Last Lighthouse'];
const LENGTHS = [30, 60, 90, 120, 45, 25, 60, 30];

function startMock(port = 9099, ffmpeg = 'ffmpeg', { rich = false } = {}) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== 'u' || u.searchParams.get('password') !== 'p') return res.end('{"user_info":{"auth":0}}');
      const a = u.searchParams.get('action');
      res.setHeader('Content-Type', 'application/json');
      if (rich && a === 'get_live_categories') return res.end(JSON.stringify(RICH_CATS.map(([id, n]) => ({ category_id: id, category_name: n }))));
      if (rich && a === 'get_live_streams') return res.end(JSON.stringify(RICH_CHANNELS.map(([n, c], i) => ({ stream_id: i + 1, name: n, category_id: c, stream_icon: '', epg_channel_id: 'ch.' + (i + 1) }))));
      if (a === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'Test' }, { category_id: '2', category_name: 'Other' }]));
      if (a === 'get_live_streams') return res.end(JSON.stringify([
        { stream_id: 1, name: 'Test Pattern HD', category_id: '1', stream_icon: '', epg_channel_id: 'Test.One' },
        { stream_id: 2, name: 'Second Channel', category_id: '2', stream_icon: '', epg_channel_id: '' }]));
      if (a === 'get_short_epg') return res.end(JSON.stringify({ epg_listings: [{ title: Buffer.from('Test Show').toString('base64'), description: Buffer.from('Fake EPG').toString('base64'), start_timestamp: String(Date.now() / 1000 - 600 | 0), stop_timestamp: String(Date.now() / 1000 + 1200 | 0) }] }));
      return res.end('{}');
    }
    if (u.pathname === '/xmltv.php') {
      // 30-minute programmes, from 2h ago to 48h ahead, timestamps written with a +0100 offset
      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (ms) => { const d = new Date(ms + 3600000); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0100`; };
      if (rich) {
        let y = '<?xml version="1.0"?>\n<tv>\n';
        const start0 = Math.floor(Date.now() / 1800000) * 1800000 - 3 * 3600000;
        RICH_CHANNELS.forEach((c, ci) => {
          let t = start0 - (ci % 4) * 20 * 60000, k = ci;
          while (t < start0 + 80 * 3600000) {
            const len = LENGTHS[k % LENGTHS.length] * 60000;
            const title = TITLES[(k * 7 + ci) % TITLES.length];
            y += `<programme start="${fmt(t)}" stop="${fmt(t + len)}" channel="ch.${ci + 1}"><title>${title}</title><desc>A fine episode of ${title}. Synthetic demo programme.</desc></programme>\n`;
            t += len; k++;
          }
        });
        res.setHeader('Content-Type', 'application/xml');
        return res.end(y + '</tv>');
      }
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
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

if (require.main === module) {
  const { findFfmpeg } = require('../server/ffmpeg');
  const ff = findFfmpeg('');
  startMock(9099, ff && ff.path, { rich: true }).then(() => console.log('Mock Xtream on http://127.0.0.1:9099 (u/p)'));
}
module.exports = { startMock };
