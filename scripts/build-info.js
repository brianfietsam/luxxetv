'use strict';
// Stamps commit + build date into build-info.json for packaged builds (shown in Settings → About).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let commit = process.env.GITHUB_SHA || '';
if (!commit) { try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { commit = 'unknown'; } }
const info = { commit: commit.slice(0, 7), buildDate: new Date().toISOString() };
fs.writeFileSync(path.join(__dirname, '..', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('build-info.json', info);
