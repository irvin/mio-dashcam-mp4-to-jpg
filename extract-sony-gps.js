#!/usr/bin/env node
/**
 * Sony Action Cam: extract JPEG frames from a video using either an external GPX
 * track or Sony .moff NMEA data, then write EXIF GPS/time metadata.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { exiftool } = require('exiftool-vendored');
const {
  cropTopLeftIfNeeded,
  rotateJpegIfNeeded,
} = require('./tools/image-transform');
const {
  applyFrameOffset,
  defaultOutDirFromVideo,
  ffprobeVideoMeta,
  formatIsoFilenameLocal,
  frameIndexFromVideoTime,
  parseTzOffsetToMinutes,
  runFfmpegExtractBatch,
  runWithConcurrency,
  writeGpsExif,
} = require('./extract');

function printHelp() {
  console.log(`
用法:
  node extract-sony-gps.js --video <檔.MP4> (--gpx <檔.gpx> --video-start <ISO> | --moff <檔.moff>) [選項]

說明:
  - GPX 模式：用 --video-start 指定影片真實開始時間，取 GPX 中落在影片範圍內的點抽圖。
  - MOFF 模式：從 @Sonygps / @Sonygpsoption 推算影片開始時間，並使用 MOFF 內的 NMEA RMC/GGA。
  - 未指定 --out 時，輸出至 ./_out/<MP4主檔名>/。

選項:
  --out <目錄>           輸出目錄
  --video-start <時間>   影片開始時間；GPX 模式必填。例：2023-07-01T17:59:35+08:00
  --video-end <時間>     影片結束時間；省略時用影片長度推算
  --point-step <N>       每 N 筆 GPS 點位抽 1 張（預設 1）
  --max-points <N>       最多抽 N 張
  --full-interval-sec <N>
                          整片固定每 N 秒抽一張；時間用影片起點推算，GPS 只寫入可匹配點
  --gps-max-delta-sec <N> 整片固定間隔模式：GPS 最近點最大容許秒差（預設 0.5）；超過則 GPS 留空
  --write-gpx            將 GPS 點位另存為 <影片主檔名>.gpx 到輸出目錄
  --start-sec <秒>       略過影片 t 小於此秒數的點（預設 0）
  --video-time-offset-sec <秒>
                          抽幀用影片秒數校正；負數代表往前抽，EXIF/GPS 不變（預設 0）
  --gps-offset <N>       EXIF GPS 改用錨點前/後第 N 筆點位（預設 0）
  --frame-offset <N>     抽幀 frame index 位移（預設 0）
  --rotate-deg <deg>     抽圖後順時針旋轉（預設 0）
  --crop <w>x<h>         抽圖後裁切
  --crop-origin <x>x<y>  裁切起點；搭配 --crop 使用
  --offset <±HH:MM>      DateTimeOriginal 時區（預設 +08:00）
  --jpeg-quality <n>     MJPEG -q:v（1 最佳，預設 3）
  --write-parallel <N>   EXIF/裁切平行數（預設 4）
  --make <字串>          EXIF Make（預設 SONY）
  --model <字串>         EXIF Model（選填）
  --artist <字串>        EXIF Artist（選填）
  --dry-run              只列出會抽幾張與時間範圍，不輸出 JPEG
`);
}

function parseArgs(argv) {
  const opts = {
    video: null,
    gpx: null,
    moff: null,
    outDir: null,
    videoStartUtcMs: null,
    videoEndUtcMs: null,
    pointStep: 1,
    maxPoints: null,
    fullIntervalSec: null,
    gpsMaxDeltaSec: 0.5,
    writeGpx: false,
    startSec: 0,
    videoTimeOffsetSec: 0,
    gpsOffset: 0,
    frameOffset: 0,
    rotateDeg: 0,
    crop: null,
    tzOffsetStr: '+08:00',
    jpegQuality: 3,
    writeParallel: 4,
    make: 'SONY',
    model: null,
    artist: null,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--video') opts.video = argv[++i];
    else if (a === '--gpx') opts.gpx = argv[++i];
    else if (a === '--moff') opts.moff = argv[++i];
    else if (a === '--out') opts.outDir = argv[++i];
    else if (a === '--video-start') opts.videoStartUtcMs = parseDateArg(argv[++i], '--video-start');
    else if (a === '--video-end') opts.videoEndUtcMs = parseDateArg(argv[++i], '--video-end');
    else if (a === '--point-step') opts.pointStep = parsePositiveInt(argv[++i], 1);
    else if (a === '--max-points') opts.maxPoints = parsePositiveInt(argv[++i], null);
    else if (a === '--full-interval-sec') opts.fullIntervalSec = parsePositiveInt(argv[++i], null);
    else if (a === '--gps-max-delta-sec') opts.gpsMaxDeltaSec = parseNonNegativeFloat(argv[++i], 0.5);
    else if (a === '--write-gpx') opts.writeGpx = true;
    else if (a === '--start-sec') opts.startSec = parseNonNegativeFloat(argv[++i], 0);
    else if (a === '--video-time-offset-sec') opts.videoTimeOffsetSec = parseFloatNumber(argv[++i], 0);
    else if (a === '--gps-offset') opts.gpsOffset = parseInteger(argv[++i], 0);
    else if (a === '--frame-offset') opts.frameOffset = parseInteger(argv[++i], 0);
    else if (a === '--rotate-deg') opts.rotateDeg = parseFloatNumber(argv[++i], 0);
    else if (a === '--crop') opts.crop = { ...(opts.crop || {}), ...parseCrop(argv[++i]) };
    else if (a === '--crop-origin') opts.crop = { ...(opts.crop || {}), ...parseCropOrigin(argv[++i]) };
    else if (a === '--offset') opts.tzOffsetStr = argv[++i];
    else if (a === '--jpeg-quality') opts.jpegQuality = parsePositiveInt(argv[++i], 3);
    else if (a === '--write-parallel') opts.writeParallel = parsePositiveInt(argv[++i], 4);
    else if (a === '--make') opts.make = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--artist') opts.artist = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else {
      console.error('未知參數:', a);
      process.exit(1);
    }
  }
  return opts;
}

function parseInteger(raw, fallback) {
  const v = parseInt(String(raw ?? '').trim(), 10);
  return Number.isNaN(v) ? fallback : v;
}

function parseFloatNumber(raw, fallback) {
  const v = parseFloat(String(raw ?? '').trim());
  return Number.isNaN(v) ? fallback : v;
}

function parsePositiveInt(raw, fallback) {
  const v = parseInt(String(raw ?? '').trim(), 10);
  if (Number.isNaN(v) || v < 1) return fallback;
  return v;
}

function parseNonNegativeFloat(raw, fallback) {
  const v = parseFloat(String(raw ?? '').trim());
  if (!Number.isFinite(v) || v < 0) return fallback;
  return v;
}

function parseCrop(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!m) {
    console.error('--crop 須為 <寬>x<高> 正整數');
    process.exit(1);
  }
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

function parseCropOrigin(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+)\s*[xX,]\s*(\d+)$/);
  if (!m) {
    console.error('--crop-origin 須為 <x>x<y> 非負整數');
    process.exit(1);
  }
  return { left: parseInt(m[1], 10), top: parseInt(m[2], 10) };
}

function parseDateArg(raw, label) {
  const ms = Date.parse(String(raw ?? '').trim());
  if (!Number.isFinite(ms)) {
    console.error(`${label} 不是可解析時間: ${raw}`);
    process.exit(1);
  }
  return ms;
}

function parseCompactDateTimeUtc(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/);
  if (!m) return null;
  const ms = m[7] ? parseInt(m[7].padEnd(3, '0').slice(0, 3), 10) : 0;
  return Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    parseInt(m[6], 10),
    ms
  );
}

function nmeaLatToDecimal(raw, hemi) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let dec = deg + min / 60;
  if (hemi === 'S') dec = -dec;
  return dec;
}

function nmeaLonToDecimal(raw, hemi) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let dec = deg + min / 60;
  if (hemi === 'W') dec = -dec;
  return dec;
}

function utcMsFromNmea(dateStr, timeStr) {
  const d = String(dateStr ?? '').padStart(6, '0');
  const t = String(timeStr ?? '').trim();
  const [whole, frac = '0'] = t.split('.');
  const w = whole.padStart(6, '0');
  const day = parseInt(d.slice(0, 2), 10);
  const mo = parseInt(d.slice(2, 4), 10);
  const year = 2000 + parseInt(d.slice(4, 6), 10);
  const h = parseInt(w.slice(0, 2), 10);
  const mi = parseInt(w.slice(2, 4), 10);
  const sec = parseInt(w.slice(4, 6), 10);
  const ms = parseInt(frac.padEnd(3, '0').slice(0, 3), 10);
  return Date.UTC(year, mo - 1, day, h, mi, sec, Number.isFinite(ms) ? ms : 0);
}

function stripChecksum(line) {
  const star = line.indexOf('*');
  return star >= 0 ? line.slice(0, star) : line;
}

function parseNmeaLines(lines) {
  const rmc = [];
  const gga = [];
  for (const line of lines) {
    const L = stripChecksum(line.trim());
    if (!L) continue;
    const p = L.split(',');
    const type = p[0];
    if (/^\$(GP|GN|GL|GA|BD)RMC$/.test(type)) {
      if (p[2] !== 'A') continue;
      const utcMs = utcMsFromNmea(p[9], p[1]);
      const latDec = nmeaLatToDecimal(p[3], p[4]);
      const lonDec = nmeaLonToDecimal(p[5], p[6]);
      if (!Number.isFinite(utcMs) || latDec == null || lonDec == null) continue;
      const speedKnots = parseFloat(p[7]);
      const course = parseFloat(p[8]);
      rmc.push({
        utcMs,
        latDec,
        lonDec,
        speedKmh: Number.isFinite(speedKnots) ? speedKnots * 1.852 : undefined,
        course: Number.isFinite(course) ? course : undefined,
      });
    } else if (/^\$(GP|GN|GL|GA|BD)GGA$/.test(type)) {
      const latDec = nmeaLatToDecimal(p[2], p[3]);
      const lonDec = nmeaLonToDecimal(p[4], p[5]);
      const altM = parseFloat(p[9]);
      const hdop = parseFloat(p[8]);
      gga.push({
        timeStr: p[1],
        latDec,
        lonDec,
        altM: Number.isFinite(altM) ? altM : undefined,
        hdop: Number.isFinite(hdop) ? hdop : undefined,
      });
    }
  }
  rmc.sort((a, b) => a.utcMs - b.utcMs);
  return { rmc, gga };
}

function attachNearestGga(points, gga) {
  if (!gga.length || !points.length) return points;
  const bySec = new Map();
  for (const g of gga) {
    if (!g.timeStr) continue;
    bySec.set(String(g.timeStr).split('.')[0].padStart(6, '0'), g);
  }
  return points.map((p) => {
    const d = new Date(p.utcMs);
    const key =
      String(d.getUTCHours()).padStart(2, '0') +
      String(d.getUTCMinutes()).padStart(2, '0') +
      String(d.getUTCSeconds()).padStart(2, '0');
    const g = bySec.get(key);
    if (!g) return p;
    return {
      ...p,
      altM: Number.isFinite(g.altM) ? g.altM : p.altM,
      hdop: Number.isFinite(g.hdop) ? g.hdop : p.hdop,
    };
  });
}

function readMoffPoints(moffPath) {
  const text = fs.readFileSync(moffPath).toString('latin1');
  const startMatch = text.match(/@Sonygps\/[^/]*\/[^/]*\/(\d{14}\.\d{3})\//);
  const optionMatch = text.match(/@Sonygpsoption\/[^/]*\/(\d{14}\.\d{3})\/(\d{14}\.\d{3})\//);
  const nmeaLines = text.match(/\$(?:GP|GN|GL|GA|BD)(?:RMC|GGA),[^\r\n\0]*/g) || [];
  const { rmc, gga } = parseNmeaLines(nmeaLines);
  if (rmc.length === 0) {
    throw new Error(`MOFF 內沒有有效 RMC: ${moffPath}`);
  }

  let videoStartUtcMs = rmc[0].utcMs;
  if (startMatch && optionMatch) {
    const cameraStartMs = parseCompactDateTimeUtc(startMatch[1]);
    const optionCameraMs = parseCompactDateTimeUtc(optionMatch[1]);
    const optionGpsMs = parseCompactDateTimeUtc(optionMatch[2]);
    if (
      Number.isFinite(cameraStartMs) &&
      Number.isFinite(optionCameraMs) &&
      Number.isFinite(optionGpsMs)
    ) {
      videoStartUtcMs = optionGpsMs - (optionCameraMs - cameraStartMs);
    }
  }

  return {
    points: attachNearestGga(rmc, gga),
    videoStartUtcMs,
    sourceInfo:
      startMatch && optionMatch
        ? `moff:${path.basename(moffPath)} sonyGpsStart=${startMatch[1]} option=${optionMatch[1]}=>${optionMatch[2]}`
        : `moff:${path.basename(moffPath)} first-rmc-as-start`,
  };
}

function parseGpxPoints(gpxPath) {
  const xml = fs.readFileSync(gpxPath, 'utf8');
  const points = [];
  const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[2];
    const latMatch = attrs.match(/\blat=["']([^"']+)["']/i);
    const lonMatch = attrs.match(/\blon=["']([^"']+)["']/i);
    const timeMatch = body.match(/<time>([^<]+)<\/time>/i);
    if (!latMatch || !lonMatch || !timeMatch) continue;
    const latDec = Number(latMatch[1]);
    const lonDec = Number(lonMatch[1]);
    const utcMs = Date.parse(timeMatch[1]);
    if (!Number.isFinite(latDec) || !Number.isFinite(lonDec) || !Number.isFinite(utcMs)) continue;
    const eleMatch = body.match(/<ele>([^<]+)<\/ele>/i);
    const ele = eleMatch ? Number(eleMatch[1]) : undefined;
    points.push({
      latDec,
      lonDec,
      utcMs,
      altM: Number.isFinite(ele) ? ele : undefined,
    });
  }
  points.sort((a, b) => a.utcMs - b.utcMs);
  return points;
}

function formatGpxTime(utcMs) {
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeXmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildGpx(points, name) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<gpx version="1.0"',
    ' creator="extract-sony-gps"',
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    ' xmlns="http://www.topografix.com/GPX/1/0"',
    ' xsi:schemaLocation="http://www.topografix.com/GPX/1/0 http://www.topografix.com/GPX/1/0/gpx.xsd">',
    ' <trk>',
    `  <name>${escapeXmlText(name)}</name>`,
    '  <trkseg>',
  ];
  for (const p of points) {
    lines.push(`   <trkpt lat="${p.latDec}" lon="${p.lonDec}">`);
    if (Number.isFinite(p.altM)) lines.push(`    <ele>${p.altM}</ele>`);
    lines.push(`    <time>${formatGpxTime(p.utcMs)}</time>`);
    lines.push('   </trkpt>');
  }
  lines.push('  </trkseg>', ' </trk>', '</gpx>', '');
  return lines.join('\n');
}

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, filePath);
}

function writeGpxLog(outDir, videoPath, points) {
  const stem = path.basename(videoPath, path.extname(videoPath));
  const gpxPath = path.join(outDir, `${stem}.gpx`);
  writeTextAtomic(gpxPath, buildGpx(points, path.basename(videoPath)));
  console.log(`GPX log: ${gpxPath}（${points.length} 點）`);
}

function utcMsToLocalExif(utcMs, offsetMinutes) {
  const localMs = utcMs + offsetMinutes * 60 * 1000;
  const d = new Date(localMs);
  const pad = (n) => String(n).padStart(2, '0');
  const dateTime =
    `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return {
    dateTime,
    subSec: String(d.getUTCMilliseconds()).padStart(3, '0'),
  };
}

function formatOffsetExif(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function writeTimeExif(jpegPath, meta) {
  const { dateTime, subSec } = utcMsToLocalExif(meta.utcMs, meta.offsetMinutes);
  const offStr = formatOffsetExif(meta.offsetMinutes);
  const tags = {
    DateTimeOriginal: dateTime,
    DateTimeDigitized: dateTime,
    CreateDate: dateTime,
    ModifyDate: dateTime,
    'IFD0:ModifyDate': dateTime,
    'EXIF:DateTimeOriginal': dateTime,
    'EXIF:DateTimeDigitized': dateTime,
    'EXIF:CreateDate': dateTime,
    'EXIF:ModifyDate': dateTime,
    OffsetTime: offStr,
    'EXIF:OffsetTime': offStr,
    OffsetTimeOriginal: offStr,
    'EXIF:OffsetTimeOriginal': offStr,
    OffsetTimeDigitized: offStr,
    'EXIF:OffsetTimeDigitized': offStr,
    SubSecTimeOriginal: subSec,
    SubSecTimeDigitized: subSec,
  };
  if (meta.make) tags.Make = meta.make;
  if (meta.model) tags.Model = meta.model;
  if (meta.artist) tags.Artist = meta.artist;
  try {
    const sharp = require('sharp');
    const dim = await sharp(jpegPath).metadata();
    if (Number.isFinite(dim.width) && dim.width > 0) tags.ExifImageWidth = dim.width;
    if (Number.isFinite(dim.height) && dim.height > 0) tags.ExifImageHeight = dim.height;
  } catch (_) {
    /* keep time-only EXIF best-effort */
  }
  await exiftool.write(jpegPath, tags, ['-overwrite_original', '-XMP:all=']);
}

function nearestPointByUtcMs(points, utcMs) {
  if (points.length === 0) return { point: null, deltaMs: Infinity };
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].utcMs < utcMs) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [points[lo]];
  if (lo > 0) candidates.push(points[lo - 1]);
  let best = candidates[0];
  let bestDelta = Math.abs(best.utcMs - utcMs);
  for (const p of candidates.slice(1)) {
    const d = Math.abs(p.utcMs - utcMs);
    if (d < bestDelta) {
      best = p;
      bestDelta = d;
    }
  }
  return { point: best, deltaMs: bestDelta };
}

function buildJobs(points, opts, probe) {
  const fps = probe.fps;
  const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
  const videoStartUtcMs = opts.videoStartUtcMs;
  const videoEndUtcMs =
    opts.videoEndUtcMs != null
      ? opts.videoEndUtcMs
      : videoStartUtcMs + Math.max(0, duration) * 1000;
  const maxFrame =
    probe.nbFrames != null && probe.nbFrames > 0
      ? probe.nbFrames - 1
      : Math.max(0, Math.floor(duration * fps) - 1);
  const step = Math.max(1, opts.pointStep || 1);
  const maxPoints =
    opts.maxPoints != null && Number.isFinite(opts.maxPoints)
      ? Math.max(1, Math.floor(opts.maxPoints))
      : Infinity;
  const startSec = Math.max(0, opts.startSec || 0);
  const usedFrames = new Set();
  const jobs = [];

  for (let i = 0; i < points.length; i += step) {
    const anchor = points[i];
    if (anchor.utcMs < videoStartUtcMs || anchor.utcMs > videoEndUtcMs) continue;
    const t = (anchor.utcMs - videoStartUtcMs) / 1000 + opts.videoTimeOffsetSec;
    if (t + 1e-9 < startSec) continue;

    const gpsIndex = i + opts.gpsOffset;
    if (gpsIndex < 0 || gpsIndex >= points.length) continue;
    const gps = points[gpsIndex];

    let frameIndex = frameIndexFromVideoTime(t, fps);
    frameIndex = applyFrameOffset(frameIndex, opts.frameOffset);
    if (frameIndex > maxFrame) continue;
    if (usedFrames.has(frameIndex)) continue;
    usedFrames.add(frameIndex);
    jobs.push({ frameIndex, t, gps });
    if (jobs.length >= maxPoints) break;
  }
  jobs.sort((a, b) => a.frameIndex - b.frameIndex);
  return { jobs, fps, maxFrame, videoEndUtcMs };
}

function runFfmpegExtractInterval(videoPath, intervalSec, outPattern, qv, maxPoints) {
  const q = Math.min(31, Math.max(1, Number(qv) || 1));
  const fpsExpr = intervalSec === 1 ? '1' : `1/${intervalSec}`;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    videoPath,
    '-vf',
    `fps=${fpsExpr}`,
    '-f',
    'image2',
    '-q:v',
    String(q),
  ];
  if (maxPoints != null && Number.isFinite(maxPoints)) {
    args.push('-frames:v', String(Math.max(1, Math.floor(maxPoints))));
  }
  args.push(outPattern);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`ffmpeg 失敗: ${r.stderr || r.stdout}`);
  }
}

async function extractIntervalJpegs(opts, points) {
  const probe = ffprobeVideoMeta(opts.video);
  const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
  const intervalSec = Math.max(1, Math.floor(opts.fullIntervalSec || 1));
  const estimatedCount = Math.floor(duration / intervalSec) + 1;
  const maxPoints =
    opts.maxPoints != null && Number.isFinite(opts.maxPoints)
      ? Math.min(estimatedCount, Math.max(1, Math.floor(opts.maxPoints)))
      : null;
  const offsetMinutes = parseTzOffsetToMinutes(opts.tzOffsetStr);

  if (opts.dryRun) {
    console.log(`[dry-run] video=${opts.video}`);
    console.log(`[dry-run] interval=${intervalSec}s estimated=${estimatedCount} output=${maxPoints ?? estimatedCount}`);
    console.log(`[dry-run] videoStart=${new Date(opts.videoStartUtcMs).toISOString()}`);
    return;
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const tmpPrefix = '_interval_';
  const tmpPattern = path.join(opts.outDir, `${tmpPrefix}%05d.jpg`);
  runFfmpegExtractInterval(
    opts.video,
    intervalSec,
    tmpPattern,
    opts.jpegQuality,
    maxPoints
  );

  const names = fs
    .readdirSync(opts.outDir)
    .filter((name) => name.startsWith(tmpPrefix) && /\.jpg$/i.test(name))
    .sort();

  await runWithConcurrency(
    names.map((name, i) => ({ name, i })),
    opts.writeParallel,
    async ({ name, i }) => {
      const seqPath = path.join(opts.outDir, name);
      const t = i * intervalSec;
      const utcMs = opts.videoStartUtcMs + t * 1000;
      const { point: gps, deltaMs } = nearestPointByUtcMs(points, utcMs);
      const gpsMatches =
        gps &&
        !(
          opts.gpsMaxDeltaSec != null &&
          Number.isFinite(opts.gpsMaxDeltaSec) &&
          deltaMs > opts.gpsMaxDeltaSec * 1000
        );
      if (
        opts.gpsMaxDeltaSec != null &&
        Number.isFinite(opts.gpsMaxDeltaSec) &&
        deltaMs > opts.gpsMaxDeltaSec * 1000
      ) {
        // Keep the image with timestamp EXIF only; GPS tags are intentionally blank.
      }
      const iso = formatIsoFilenameLocal(utcMs, offsetMinutes);
      const finalName = `${iso}_t${String(t).padStart(5, '0')}s.jpg`;
      const finalPath = path.join(opts.outDir, finalName);
      fs.renameSync(seqPath, finalPath);
      await rotateJpegIfNeeded(finalPath, opts.rotateDeg, opts.jpegQuality);
      await cropTopLeftIfNeeded(finalPath, opts.crop, opts.jpegQuality);
      const baseMeta = {
        utcMs,
        offsetMinutes,
        make: opts.make,
        model: opts.model,
        artist: opts.artist,
      };
      if (gpsMatches) {
        await writeGpsExif(finalPath, {
          ...baseMeta,
          latDec: gps.latDec,
          lonDec: gps.lonDec,
          course: gps.course,
          speedKmh: gps.speedKmh,
          altM: gps.altM,
          hdop: gps.hdop,
        });
      } else {
        await writeTimeExif(finalPath, baseMeta);
      }
      const gpsNote = gpsMatches
        ? `gps_delta=${(deltaMs / 1000).toFixed(3)}s`
        : `gps=blank delta=${Number.isFinite(deltaMs) ? (deltaMs / 1000).toFixed(3) : 'n/a'}s`;
      console.log(`${finalName}  t=${t}s  ${gpsNote}`);
    }
  );

  console.log(
    `完成：${names.length} 張（interval=${intervalSec}s，duration=${duration.toFixed(3)}s，tz=${opts.tzOffsetStr}，source=${opts.gpx ? 'gpx' : 'moff'}）`
  );
}

async function extractJpegs(opts, points) {
  const probe = ffprobeVideoMeta(opts.video);
  const { jobs, fps, maxFrame, videoEndUtcMs } = buildJobs(points, opts, probe);
  const offsetMinutes = parseTzOffsetToMinutes(opts.tzOffsetStr);

  if (opts.dryRun) {
    console.log(`[dry-run] video=${opts.video}`);
    console.log(`[dry-run] points=${points.length} jobs=${jobs.length} fps=${fps} maxFrame=${maxFrame}`);
    console.log(`[dry-run] videoStart=${new Date(opts.videoStartUtcMs).toISOString()} videoEnd=${new Date(videoEndUtcMs).toISOString()}`);
    return;
  }

  if (jobs.length === 0) {
    console.log('無可輸出 JPEG 項目。');
    return;
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const tmpPrefix = '_sony_';
  const tmpPattern = path.join(opts.outDir, `${tmpPrefix}%05d.jpg`);
  runFfmpegExtractBatch(
    opts.video,
    jobs.map((j) => j.frameIndex),
    tmpPattern,
    opts.jpegQuality
  );

  await runWithConcurrency(
    jobs.map((j, i) => ({ j, i })),
    opts.writeParallel,
    async ({ j, i }) => {
      const seqPath = path.join(
        opts.outDir,
        `${tmpPrefix}${String(i + 1).padStart(5, '0')}.jpg`
      );
      if (!fs.existsSync(seqPath)) {
        throw new Error(`預期輸出不存在: ${seqPath}`);
      }
      const iso = formatIsoFilenameLocal(j.gps.utcMs, offsetMinutes);
      const finalName = `${iso}_f${String(j.frameIndex).padStart(5, '0')}.jpg`;
      const finalPath = path.join(opts.outDir, finalName);
      fs.renameSync(seqPath, finalPath);
      await rotateJpegIfNeeded(finalPath, opts.rotateDeg, opts.jpegQuality);
      await cropTopLeftIfNeeded(finalPath, opts.crop, opts.jpegQuality);
      await writeGpsExif(finalPath, {
        latDec: j.gps.latDec,
        lonDec: j.gps.lonDec,
        utcMs: j.gps.utcMs,
        course: j.gps.course,
        speedKmh: j.gps.speedKmh,
        altM: j.gps.altM,
        hdop: j.gps.hdop,
        offsetMinutes,
        make: opts.make,
        model: opts.model,
        artist: opts.artist,
      });
      console.log(`${finalName}  frame=${j.frameIndex}  t=${j.t.toFixed(3)}s`);
    }
  );

  console.log(
    `完成：${jobs.length} 張（fps=${fps}，maxFrame=${maxFrame}，tz=${opts.tzOffsetStr}，point-step=${opts.pointStep}，source=${opts.gpx ? 'gpx' : 'moff'}）`
  );
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (!opts.video) {
    console.error('請提供 --video');
    printHelp();
    process.exit(1);
  }
  if (!fs.existsSync(opts.video)) {
    console.error('找不到影片:', opts.video);
    process.exit(1);
  }
  if ((opts.gpx ? 1 : 0) + (opts.moff ? 1 : 0) !== 1) {
    console.error('請擇一提供 --gpx 或 --moff');
    process.exit(1);
  }
  if (!opts.outDir) opts.outDir = defaultOutDirFromVideo(opts.video);

  let points;
  if (opts.gpx) {
    if (!fs.existsSync(opts.gpx)) {
      console.error('找不到 GPX:', opts.gpx);
      process.exit(1);
    }
    if (opts.videoStartUtcMs == null) {
      console.error('GPX 模式需提供 --video-start');
      process.exit(1);
    }
    points = parseGpxPoints(opts.gpx);
    console.log(`GPX: ${opts.gpx}（${points.length} 點）`);
  } else {
    if (!fs.existsSync(opts.moff)) {
      console.error('找不到 MOFF:', opts.moff);
      process.exit(1);
    }
    const moff = readMoffPoints(opts.moff);
    points = moff.points;
    if (opts.videoStartUtcMs == null) opts.videoStartUtcMs = moff.videoStartUtcMs;
    console.log(`MOFF: ${moff.sourceInfo}（${points.length} 點）`);
  }

  if (points.length === 0) {
    console.error('沒有可用 GPS 點位');
    process.exit(1);
  }

  if (opts.writeGpx) {
    writeGpxLog(opts.outDir, opts.video, points);
  }

  if (opts.fullIntervalSec != null) {
    await extractIntervalJpegs(opts, points);
  } else {
    await extractJpegs(opts, points);
  }
  await exiftool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    exiftool.end().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  buildGpx,
  parseGpxPoints,
  readMoffPoints,
};
