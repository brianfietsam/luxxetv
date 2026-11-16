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
