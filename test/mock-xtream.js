'use strict';
// Minimal fake Xtream Codes server for testing: `npm run mock` (port 9099, user "u", pass "p").
const http = require('http');
const { spawn } = require('child_process');

function startMock(port = 9099, ffmpeg = 'ffmpeg') {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== 'u' || u.searchParams.get('password') !== 'p') return res.end('{"user_info":{"auth":0}}');
      const a = u.searchParams.get('action');
      res.setHeader('Content-Type', 'application/json');
      if (a === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'Test' }]));
      if (a === 'get_live_streams') return res.end(JSON.stringify([
        { stream_id: 1, name: 'Test Pattern HD', category_id: '1', stream_icon: '', epg_channel_id: '' },
        { stream_id: 2, name: 'Second Channel', category_id: '1', stream_icon: '', epg_channel_id: '' }]));
      if (a === 'get_short_epg') return res.end(JSON.stringify({ epg_listings: [{ title: Buffer.from('Test Show').toString('base64'), description: Buffer.from('Fake EPG').toString('base64'), start_timestamp: String(Date.now() / 1000 - 600 | 0), stop_timestamp: String(Date.now() / 1000 + 1200 | 0) }] }));
      return res.end('{}');
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
  startMock(9099, ff && ff.path).then(() => console.log('Mock Xtream on http://127.0.0.1:9099 (u/p)'));
}
module.exports = { startMock };
