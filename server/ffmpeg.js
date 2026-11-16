'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

function works(p) {
  try {
    const r = spawnSync(p, ['-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return r.status === 0 ? r.stdout.split('\n')[0] : null;
  } catch { return null; }
}

function findFfmpeg(configured) {
  const candidates = [configured, process.env.FFMPEG_PATH, 'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'].filter(Boolean);
  for (const c of candidates) {
    if (c !== 'ffmpeg' && !fs.existsSync(c)) continue;
    const v = works(c);
    if (v) return { path: c, version: v };
  }
  return null;
}

function listEncoders(ffmpegPath) {
  const found = ['libx264'];
  try {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf']) if (r.stdout.includes(e)) found.push(e);
  } catch { /* ignore */ }
  return found;
}

// H.264 video args. crf is a quality number (lower = better/larger).
function videoArgs(encoder, { crf, maxHeight, maxrateK }) {
  const a = [];
  if (maxHeight) a.push('-vf', `scale=-2:min(${maxHeight}\\,ih)`);
  switch (encoder) {
    case 'h264_nvenc':
      a.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0'); break;
    case 'h264_qsv':
      a.push('-c:v', 'h264_qsv', '-global_quality', String(crf), '-preset', 'veryfast'); break;
    case 'h264_amf':
      a.push('-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf)); break;
    default:
      a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-profile:v', 'main');
  }
  if (maxrateK) a.push('-maxrate', `${maxrateK}k`, '-bufsize', `${maxrateK * 2}k`);
  a.push('-pix_fmt', 'yuv420p', '-g', '100', '-keyint_min', '100');
  if (encoder === 'libx264') a.push('-sc_threshold', '0');
  return a;
}

function inputArgs(url, userAgent) {
  return ['-hide_banner', '-loglevel', 'warning', '-user_agent', userAgent,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    '-rw_timeout', '20000000', '-fflags', '+genpts+discardcorrupt', '-i', url];
}

module.exports = { findFfmpeg, listEncoders, videoArgs, inputArgs };
