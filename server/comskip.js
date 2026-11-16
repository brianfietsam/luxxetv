'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function findComskip(configured) {
  const candidates = [configured, process.env.COMSKIP_PATH, 'comskip',
    'C:\comskip\comskip.exe', 'C:\Program Files\Comskip\comskip.exe', 'C:\Program Files (x86)\Comskip\comskip.exe'].filter(Boolean);
  for (const c of candidates) {
    if (c !== 'comskip' && !fs.existsSync(c)) continue;
    try {
      // comskip exits non-zero with no args but still prints its banner; only a spawn error means "not found"
      const r = spawnSync(c, [], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (!r.error) return { path: c };
    } catch { /* next */ }
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve(-1));
    p.on('close', (code) => resolve(code));
  });
}

function parseEdl(text) {
  return text.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2)
    .map((p) => ({ s: parseFloat(p[0]), e: parseFloat(p[1]) })).filter((r) => isFinite(r.s) && isFinite(r.e) && r.e > r.s)
    .sort((a, b) => a.s - b.s);
}

// Detect commercials with comskip and cut them out of `file` (stream copy, in place).
// Returns { removed: seconds } or { skipped: reason }. The original is left untouched on any failure.
async function stripCommercials({ file, comskipPath, ffmpegPath }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'luxxetv-cs-'));
  try {
    const ini = path.join(work, 'comskip.ini');
    fs.writeFileSync(ini, 'output_edl=1\noutput_default=0\noutput_txt=0\n');
    await run(comskipPath, [`--ini=${ini}`, `--output=${work}`, file]);
    const edl = fs.readdirSync(work).find((n) => n.toLowerCase().endsWith('.edl'));
    if (!edl) return { skipped: 'no commercials detected' };
    const cuts = parseEdl(fs.readFileSync(path.join(work, edl), 'utf8'));
    if (!cuts.length) return { skipped: 'no commercials detected' };

    const keep = []; let pos = 0;
    for (const c of cuts) { if (c.s - pos > 1) keep.push([pos, c.s]); pos = Math.max(pos, c.e); }
    keep.push([pos, null]);
    const q = (f) => f.split(String.fromCharCode(92)).join('/').split("'").join("'" + String.fromCharCode(92) + "''");
    const list = path.join(work, 'keep.txt');
    fs.writeFileSync(list, keep.map(([s, e]) => `file '${q(file)}'\ninpoint ${s.toFixed(3)}${e == null ? '' : `\noutpoint ${e.toFixed(3)}`}`).join('\n'));
    const out = path.join(work, 'out' + path.extname(file));
    const code = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-c', 'copy', ...(out.endsWith('.mp4') ? ['-movflags', '+faststart'] : []), '-y', out]);
    if (code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 20000) return { skipped: 'cut failed, original kept' };
    fs.copyFileSync(out, file);
    return { removed: cuts.reduce((a, c) => a + (c.e - c.s), 0) };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { findComskip, stripCommercials, parseEdl };
