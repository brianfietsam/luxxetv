'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULTS = {
  source: { type: 'xtream', server: '', username: '', password: '', m3uUrl: '' },
  recordDir: path.join(os.homedir(), 'Videos', 'LuxxeTV'),
  downloadDir: path.join(os.homedir(), 'Videos', 'LuxxeTV Downloads'),
  tmdbKey: '',               // optional TMDB API key (v3 key or v4 token): enables box-office sorting for movies
  tmdbBase: '',              // blank = https://api.themoviedb.org/3 (override for testing)
  recordQuality: 'balanced', // small | balanced | high | copy
  liveQuality: '720p',       // 480p | 720p | 1080p | copy
  encoder: 'libx264',        // libx264 | h264_nvenc | h264_qsv | h264_amf
  ffmpegPath: '',
  commSkip: 'off',           // off | cut (remove commercials after recording, needs comskip)
  comskipPath: '',
  port: 8484,
  listenAll: true,
  webPassword: '',
  padBeforeMin: 1,
  padAfterMin: 2,
  maxLiveSessions: 2,
  hiddenCategories: [],
  favorites: [],
  epgUrl: '',                // optional XMLTV override; blank = auto
  userAgent: 'VLC/3.0.20 LibVLC/3.0.20',
  sessionSecret: '',
};

class Config {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'config.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data = { ...DEFAULTS, ...saved, source: { ...DEFAULTS.source, ...(saved.source || {}) } };
    if (!this.data.sessionSecret) {
      this.data.sessionSecret = crypto.randomBytes(32).toString('hex');
      this.save();
    }
  }
  get() { return this.data; }
  update(patch) {
    const next = { ...this.data, ...patch };
    if (patch.source) next.source = { ...this.data.source, ...patch.source };
    next.sessionSecret = this.data.sessionSecret; // never client-controlled
    next.port = Math.max(1, Math.min(65535, parseInt(next.port, 10) || 8484));
    this.data = next;
    this.save();
    return this.data;
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Config, DEFAULTS };
