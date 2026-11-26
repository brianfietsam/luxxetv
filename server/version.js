'use strict';
// Version / build details shown in Settings → About.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let cached = null;

function buildInfo() {
  if (cached) return cached;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, 'build-info.json'), 'utf8')); } catch { /* dev checkout */ }
  let commit = process.env.LUXXETV_COMMIT || file.commit || '';
  if (!commit) {
    try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { commit = 'unknown'; }
  }
  cached = {
    version: pkg.version,
    commit: commit.slice(0, 7),
    buildDate: file.buildDate || null,
    environment: process.env.LUXXETV_ENV || (process.versions.electron ? 'Desktop' : 'Server'),
  };
  return cached;
}

module.exports = { buildInfo };
