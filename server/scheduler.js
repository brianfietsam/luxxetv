'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;

class Scheduler {
  constructor({ cfg, dataDir, recorder, sources }) {
    this.cfg = cfg; this.recorder = recorder; this.sources = sources;
    this.file = path.join(dataDir, 'schedules.json');
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.items = []; }
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000);
    this.timer.unref();
  }

  save() { fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2)); }

  async add({ channelId, start, end, title = '', repeat = 'none' }) {
    const ch = await this.sources.getChannel(channelId);
    if (!ch) throw new Error('Unknown channel');
    const s = Date.parse(start), e = Date.parse(end);
    if (!(s > 0) || !(e > s)) throw new Error('Invalid start/end time');
    const item = { id: crypto.randomBytes(4).toString('hex'), channelId: ch.id, channelName: ch.name,
      start: s, end: e, title, repeat: ['none', 'daily', 'weekly'].includes(repeat) ? repeat : 'none', lastRun: 0 };
    this.items.push(item);
    this.save();
    return item;
  }

  remove(id) {
    const n = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    this.save();
    return this.items.length !== n;
  }

  list() { return [...this.items].sort((a, b) => a.start - b.start); }

  async tick() {
    const now = Date.now();
    const c = this.cfg.get();
    let dirty = false;
    for (const it of [...this.items]) {
      const begin = it.start - c.padBeforeMin * 60000;
      const finish = it.end + c.padAfterMin * 60000;
      if (now >= finish) {                 // window passed (missed or done)
        if (it.repeat === 'none') { this.items = this.items.filter((x) => x !== it); }
        else { const step = it.repeat === 'daily' ? DAY : 7 * DAY; while (it.end + c.padAfterMin * 60000 <= now) { it.start += step; it.end += step; } }
        dirty = true; continue;
      }
      if (now >= begin && it.lastRun !== it.start) {
        it.lastRun = it.start; dirty = true;
        const minutes = Math.max(1, (finish - now) / 60000);
        try { await this.recorder.start({ channelId: it.channelId, minutes, title: it.title }); } catch (e) { it.lastError = e.message; }
      }
    }
    if (dirty) this.save();
  }

  shutdown() { clearInterval(this.timer); }
}

module.exports = { Scheduler };
