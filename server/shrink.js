'use strict';
// Re-encodes a downloaded video to an H.264/AAC MP4 of about a target size (1080p at most, HDR toned down to SDR).
const { spawn } = require('child_process');

const TEXT_SUBS = /^(subrip|srt|ass|ssa|mov_text|webvtt|text)$/i;
const SLACK = 1.1;   // not worth hours of encoding to trim less than 10%

const needsShrink = (size, targetBytes) => targetBytes > 0 && size > targetBytes * SLACK;

// Parse the stream list ffmpeg prints for an input (no ffprobe needed).
function parseProbe(text) {
  const d = text.match(/Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  const info = { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, video: null, hdr: false, audio: [], subs: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Subtitle): (\w+)(.*)$/);
    if (!m) continue;
    const [, index, kind, codec, rest] = m;
    if (kind === 'Video') {
      if (info.video !== null || /attached pic/.test(rest)) continue;
      info.video = +index; info.hdr = /smpte2084|arib-std-b67/.test(rest);
    } else if (kind === 'Audio') {
      const layout = (rest.match(/Hz, ([^,]+)/) || [])[1] || '';
      const n = layout.match(/^(\d+) channels/) || layout.match(/^(\d)\.(\d)/);
      const channels = /^mono/.test(layout) ? 1 : /^stereo/.test(layout) ? 2 : n ? +n[1] + (+n[2] || 0) : 2;
      info.audio.push({ index: +index, channels });
    } else if (TEXT_SUBS.test(codec)) info.subs.push(+index);   // picture subtitles cannot go into MP4
  }
  return info;
}

function probe(ffmpegPath, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let out = '';
    p.stderr.on('data', (d) => { if (out.length < 4e6) out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(parseProbe(out)));
  });
}

// Bitrates that add up to the target size.
function plan(info, targetBytes) {
  const totalK = (targetBytes * 8 * 0.97) / info.duration / 1000;
  const rate = (a) => { const ch = Math.min(a.channels, 6); return { index: a.index, channels: ch, kbps: ch > 2 ? 384 : ch === 1 ? 96 : 160 }; };
  let audio = info.audio.slice(0, 3).map(rate);
  if (audio.reduce((n, a) => n + a.kbps, 0) > totalK * 0.25) audio = audio.slice(0, 1).map((a) => ({ ...a, channels: Math.min(a.channels, 2), kbps: 128 }));
  const videoK = Math.max(300, Math.floor(totalK - audio.reduce((n, a) => n + a.kbps, 0)));
  return { audio, videoK };
}

function buildArgs({ src, out, info, bitrates, encoder, tonemap }) {
  const { audio, videoK } = bitrates;
  const vf = [`scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2`];
  if (tonemap) vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  vf.push('format=yuv420p');
  const codec = {
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'medium'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak'],
  }[encoder] || ['-c:v', 'libx264', '-preset', 'faster'];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', src, '-map', `0:${info.video}`];
  audio.forEach((a) => args.push('-map', `0:${a.index}`));
  info.subs.forEach((i) => args.push('-map', `0:${i}`));
  args.push('-vf', vf.join(','), ...codec, '-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.5)}k`, '-bufsize', `${videoK * 2}k`);
  audio.forEach((a, n) => args.push(`-c:a:${n}`, 'aac', `-b:a:${n}`, `${a.kbps}k`, `-ac:a:${n}`, String(a.channels)));
  if (info.subs.length) args.push('-c:s', 'mov_text');
  args.push('-max_muxing_queue_size', '4096', '-movflags', '+faststart', '-f', 'mp4', '-y', out);
  return args;
}

function run(ffmpegPath, args, duration, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    const kill = () => p.kill('SIGKILL');
    if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true });
    p.stdout.on('data', (d) => {
      const all = [...String(d).matchAll(/out_time_(?:us|ms)=(\d+)/g)];   // both are microseconds
      if (all.length) onProgress(Math.min(0.99, +all[all.length - 1][1] / 1e6 / duration));
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('error', reject);
    p.on('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) return reject(new Error('cancelled'));
      if (code === 0) return resolve();
      reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
    });
  });
}

// Encode `src` into `out`. Falls back to the CPU encoder, then to no HDR tone mapping, if ffmpeg refuses.
async function transcode({ ffmpegPath, src, out, info, targetBytes, encoder, onProgress, signal }) {
  const bitrates = plan(info, targetBytes);
  const attempts = [{ encoder, tonemap: info.hdr }];
  if (encoder !== 'libx264') attempts.push({ encoder: 'libx264', tonemap: info.hdr });
  if (info.hdr) attempts.push({ encoder: 'libx264', tonemap: false });
  let last;
  for (const a of attempts) {
    try { return await run(ffmpegPath, buildArgs({ src, out, info, bitrates, ...a }), info.duration, onProgress, signal); }
    catch (e) { if (signal.aborted) throw e; last = e; }
  }
  throw last;
}

module.exports = { needsShrink, parseProbe, probe, plan, transcode };
