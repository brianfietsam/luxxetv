'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Config } = require('./config');
const { Sources } = require('./sources');
const { Recorder } = require('./recorder');
const { Live } = require('./live');
const { Scheduler } = require('./scheduler');
const { Epg } = require('./epg');
const { Vod } = require('./vod');
const { Downloads } = require('./downloads');
const { findFfmpeg, listEncoders } = require('./ffmpeg');

const PUBLIC = path.join(__dirname, '..', 'public');
const HLS_JS = path.join(require.resolve('hls.js/package.json'), '..', 'dist', 'hls.min.js');

function isPrivateIp(ip) {
  ip = (ip || '').replace(/^::ffff:/, '');
  return ip === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip);
}
const forwarded = (req) => !!(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['forwarded']);
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: e.message }));

async function start({ dataDir, port }) {
  const cfg = new Config(dataDir);
  const sources = new Sources(cfg, dataDir);
  let ffmpeg = findFfmpeg(cfg.get().ffmpegPath);
  const getFfmpeg = () => ffmpeg;
  const epg = new Epg({ cfg, sources, dataDir });
  const recorder = new Recorder({ cfg, sources, getFfmpeg });
  const live = new Live({ cfg, sources, getFfmpeg });
  const scheduler = new Scheduler({ cfg, dataDir, recorder, sources });
  const vod = new Vod({ cfg, sources, dataDir });
  const downloads = new Downloads({ cfg, vod });
  const desktopToken = crypto.randomBytes(16).toString('hex');

  const authToken = () => crypto.createHmac('sha256', cfg.get().sessionSecret).update('luxxetv-ok:' + cfg.get().webPassword).digest('hex');
  const cookieOf = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
  const setAuthCookie = (res) => res.setHeader('Set-Cookie', `ltv=${authToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 86400}`);
  const authed = (req) => {
    if (!cfg.get().webPassword) return true;
    const t = cookieOf(req).ltv || '';
    const a = Buffer.from(t), b = Buffer.from(authToken());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Without a password the server is LAN-only; with one it may be exposed (tunnel / port-forward).
  app.use((req, res, next) => {
    if (!cfg.get().webPassword && (!isPrivateIp(req.socket.remoteAddress) || forwarded(req))) {
      return res.status(403).send('LuxxeTV: set a web password in Settings to allow access from outside your home network.');
    }
    next();
  });

  // Desktop shell hands over a one-time-per-run token so it never needs the password.
  app.use((req, res, next) => {
    if (req.query.desktop && req.query.desktop === desktopToken) { setAuthCookie(res); return res.redirect('/'); }
    next();
  });

  const failures = new Map();
  app.post('/api/login', wrap(async (req, res) => {
    const ip = req.socket.remoteAddress;
    const f = failures.get(ip) || { n: 0, until: 0 };
    if (Date.now() < f.until) return res.status(429).json({ error: 'Too many attempts, wait a moment' });
    const pw = cfg.get().webPassword;
    const given = Buffer.from(String(req.body.password || ''));
    const want = Buffer.from(pw);
    if (pw && given.length === want.length && crypto.timingSafeEqual(given, want)) {
      failures.delete(ip); setAuthCookie(res); return res.json({ ok: true });
    }
    f.n++; if (f.n >= 5) f.until = Date.now() + Math.min(60000, 2000 * f.n); failures.set(ip, f);
    res.status(401).json({ error: 'Wrong password' });
  }));
  app.get('/api/auth', (req, res) => res.json({ ok: authed(req), passwordSet: !!cfg.get().webPassword }));

  app.use(express.static(PUBLIC));
  app.get('/vendor/hls.min.js', (req, res) => res.sendFile(HLS_JS));

  const guard = (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'auth' }));
  app.use(['/api', '/live', '/rec', '/dl'], guard);

  // ---- channels ----
  app.get('/api/categories', wrap(async (req, res) => {
    const d = await sources.ensure();
    const hidden = new Set(cfg.get().hiddenCategories || []);
    const counts = new Map();
    d.channels.forEach((c) => counts.set(c.cat, (counts.get(c.cat) || 0) + 1));
    const all = d.categories.map((c) => ({ ...c, count: counts.get(c.name) || 0, hidden: hidden.has(c.name) }));
    res.json(req.query.all ? all : all.filter((c) => !c.hidden));
  }));
  app.put('/api/categories/hidden', wrap(async (req, res) => {
    const list = Array.isArray(req.body.hidden) ? req.body.hidden.map(String) : [];
    cfg.update({ hiddenCategories: list });
    res.json({ ok: true });
  }));
  app.get('/api/channels', wrap(async (req, res) => {
    res.json(await sources.query({ cat: req.query.cat, q: req.query.q, offset: +req.query.offset || 0, limit: Math.min(+req.query.limit || 200, 500) }));
  }));
  app.get('/api/epg/:id', wrap(async (req, res) => {
    // Prefer the downloaded XMLTV guide (hours ahead); fall back to the provider's short EPG.
    const ch = await sources.getChannel(req.params.id);
    const now = Date.now();
    const list = ch && epg.status().ready ? epg.get(ch.epgId, now - 3600000, now + 12 * 3600000) : [];
    if (list.length) return res.json(list.map((p) => ({ title: p.t, desc: p.d, start: p.s, end: p.e })));
    res.json(await sources.epg(req.params.id));
  }));

  // ---- favorites (stored on the PC so every device shares them) ----
  app.get('/api/favorites', (req, res) => res.json(cfg.get().favorites || []));
  app.put('/api/favorites/:id', wrap(async (req, res) => {
    const id = String(req.params.id);
    const set = new Set(cfg.get().favorites || []);
    if (req.body.on) set.add(id); else set.delete(id);
    cfg.update({ favorites: [...set] });
    res.json({ ok: true, count: set.size });
  }));
  app.post('/api/refresh', wrap(async (req, res) => {
    sources.invalidate(); epg.invalidate(); vod.invalidate();
    const d = await sources.ensure(true);
    epg.ensureStarted(true);
    res.json({ channels: d.channels.length, categories: d.categories.length });
  }));

  // ---- TV guide ----
  app.get('/api/guide', wrap(async (req, res) => {
    const st = epg.ensureStarted();
    if (!st.ready) return res.json({ loading: !!st.loading, error: st.error });
    const d = await sources.ensure();
    const from = +req.query.from || Date.now();
    const to = from + (Math.min(+req.query.hours || 6, 24)) * 3600000;
    const only = req.query.cat !== '__fav__' && req.query.only !== '0';   // favorites always list every channel
    const items = (await sources.query({ cat: req.query.cat, q: req.query.q, offset: 0, limit: 1e9 })).items;
    const rows = [];
    for (const it of items) {
      const progs = epg.get(d.byId.get(it.id).epgId, from, to);
      if (only && !progs.length) continue;
      rows.push({ id: it.id, name: it.name, logo: it.logo, progs });
    }
    const offset = +req.query.offset || 0, limit = Math.min(+req.query.limit || 40, 100);
    res.json({ from, to, total: rows.length, rows: rows.slice(offset, offset + limit), updated: st.updated, refreshing: st.loading });
  }));
  app.get('/api/guide/status', (req, res) => res.json(epg.status()));
  app.post('/api/guide/refresh', (req, res) => { epg.invalidate(); res.json(epg.ensureStarted(true)); });

  // ---- recording ----
  app.post('/api/record', wrap(async (req, res) => {
    res.json(await recorder.start({ channelId: req.body.channelId, minutes: +req.body.minutes || 0, title: req.body.title || '' }));
  }));
  app.get('/api/record/status', (req, res) => res.json(recorder.status()));
  app.post('/api/record/:id/stop', (req, res) => res.json({ ok: recorder.stop(req.params.id) }));

  app.get('/api/recordings', (req, res) => res.json(recorder.list()));
  app.delete('/api/recordings/:name', (req, res) => {
    const f = recorder.resolve(req.params.name);
    if (!f) return res.status(404).json({ error: 'not found' });
    if (recorder.list().find((r) => r.name === req.params.name)?.recording) return res.status(409).json({ error: 'Still recording' });
    fs.unlinkSync(f);
    res.json({ ok: true });
  });
  app.get('/rec/:name', (req, res) => {
    const f = recorder.resolve(req.params.name);
    if (!f) return res.status(404).end();
    if (req.query.download) return res.download(f);
    res.sendFile(f); // supports HTTP Range -> seeking
  });

  // ---- movies & TV shows (Xtream VOD) ----
  const kindOf = (req) => (req.query.kind === 'series' ? 'series' : 'movies');
  app.get('/api/vod/categories', wrap(async (req, res) => res.json(await vod.categories(kindOf(req)))));
  app.get('/api/vod/items', wrap(async (req, res) => {
    res.json(await vod.query({ kind: kindOf(req), cat: req.query.cat, q: req.query.q, sort: req.query.sort,
      offset: +req.query.offset || 0, limit: Math.min(+req.query.limit || 60, 200) }));
  }));
  app.get('/api/vod/series/:id', wrap(async (req, res) => res.json(await vod.series(req.params.id))));

  // ---- downloads ----
  app.post('/api/downloads', wrap(async (req, res) => {
    const b = req.body || {};
    let jobs;
    if (b.type === 'movie') jobs = await downloads.addMovie(b.id);
    else if (b.type === 'season') jobs = await downloads.addEpisodes(b.seriesId, { season: b.season });
    else if (b.type === 'series') jobs = await downloads.addEpisodes(b.seriesId);
    else if (b.type === 'episode') jobs = await downloads.addEpisodes(b.seriesId, { episodeId: b.episodeId });
    else return res.status(400).json({ error: 'Unknown download type' });
    res.json({ queued: jobs.length, jobs });
  }));
  app.get('/api/downloads', (req, res) => res.json({ jobs: downloads.list(), files: downloads.files() }));
  app.post('/api/downloads/clear', (req, res) => { downloads.clearFinished(); res.json({ ok: true }); });
  app.post('/api/downloads/:id/cancel', (req, res) => res.json({ ok: downloads.cancel(req.params.id) }));
  app.delete('/api/downloads/file', (req, res) => res.json({ ok: downloads.remove(req.query.f) }));
  app.get('/dl', (req, res) => {
    const f = downloads.resolve(req.query.f);
    if (!f) return res.status(404).end();
    if (req.query.download) return res.download(f);
    res.sendFile(f);
  });

  // ---- schedules ----
  app.get('/api/schedules', (req, res) => res.json(scheduler.list()));
  app.post('/api/schedules', wrap(async (req, res) => res.json(await scheduler.add(req.body))));
  app.delete('/api/schedules/:id', (req, res) => res.json({ ok: scheduler.remove(req.params.id) }));

  // ---- live HLS for the web player ----
  app.get('/live/:id/index.m3u8', wrap(async (req, res) => {
    const s = await live.ensure(req.params.id);
    const f = await live.waitPlaylist(s);
    if (!f) return res.status(502).json({ error: 'Stream failed to start', detail: s.err.split('\n').pop() });
    live.touch(req.params.id);
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.send(fs.readFileSync(f));
  }));
  app.get('/live/:id/:file', (req, res) => {
    if (!/^seg_\d+\.ts$/.test(req.params.file)) return res.status(404).end();
    live.touch(req.params.id);
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(live.dirFor(req.params.id), req.params.file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // ---- settings / system ----
  app.get('/api/settings', (req, res) => {
    const c = JSON.parse(JSON.stringify(cfg.get()));
    delete c.sessionSecret;
    c.source.passwordSet = !!c.source.password; c.source.password = '';
    c.webPasswordSet = !!c.webPassword; c.webPassword = '';
    c.tmdbKeySet = !!c.tmdbKey; c.tmdbKey = '';
    res.json(c);
  });
  app.put('/api/settings', wrap(async (req, res) => {
    const p = { ...req.body };
    delete p.sessionSecret;
    if (p.source && !p.source.password) delete p.source.password;      // blank = keep
    if (p.webPassword === '') delete p.webPassword;                    // blank = keep
    if (p.clearWebPassword) { p.webPassword = ''; delete p.clearWebPassword; }
    delete p.webPasswordSet;
    if (p.source) delete p.source.passwordSet;
    if (p.tmdbKey === '') delete p.tmdbKey;                            // blank = keep
    if (p.clearTmdbKey) { p.tmdbKey = ''; delete p.clearTmdbKey; }
    delete p.tmdbKeySet;
    cfg.update(p);
    sources.invalidate(); epg.invalidate(); vod.invalidate();
    ffmpeg = findFfmpeg(cfg.get().ffmpegPath);
    if (p.webPassword) setAuthCookie(res);   // keep the current browser logged in
    res.json({ ok: true, restartNeeded: p.port !== undefined || p.listenAll !== undefined });
  }));
  app.get('/api/system', (req, res) => res.json({
    ffmpeg: ffmpeg && ffmpeg.version, ffmpegPath: ffmpeg && ffmpeg.path,
    encoders: ffmpeg ? listEncoders(ffmpeg.path) : [],
    port: server.address().port,
  }));

  const listenPort = port !== undefined ? port : cfg.get().port;
  const host = cfg.get().listenAll ? '0.0.0.0' : '127.0.0.1';
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(listenPort, host, () => resolve(s));
    s.once('error', reject);
  });
  server.requestTimeout = 0;

  return {
    port: server.address().port, desktopToken, cfg, recorder,
    async shutdown() {
      scheduler.shutdown(); live.shutdown(); downloads.cancelAll();
      await recorder.stopAll();
      server.close();
    },
  };
}

module.exports = { start };
