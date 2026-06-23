#!/usr/bin/env node
/**
 * 從 MOV/MP4 內嵌 QuickTime GPS 軌跡擷取 GPX，再依同一批 GPS 點位抽 JPEG 並寫入 EXIF GPS。
 * GPS 來源等同：
 *   exiftool -G1 -a -s -ee "-*gps*" <video>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { exiftool } = require('exiftool-vendored');
const {
  applyFrameOffset,
  cropTopLeftIfNeeded,
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
  node extract-mov-gps.js --video <檔.MOV> [選項]

說明:
  - 使用 exiftool -ee 抽出 MOV/MP4 內嵌 GPS 軌跡，先寫成 <out>/<影片主檔名>.gpx。
  - 再依 GPS 點位相對於第一筆 GPS 的時間差，從影片擷取 JPEG 並寫入 EXIF GPS。
  - 未指定 --out 時，輸出至 ./_out/<影片主檔名>/。

選項:
  --out <目錄>           輸出目錄（省略則 ./_out/<影片主檔名>/）
  --gpx-only             只輸出 GPX，不抽 JPEG
  --point-step <N>       每 N 筆 GPS 點位抽 1 張 JPEG（預設 1）
  --max-points <N>       最多抽 N 張 JPEG；方便先做短測試
  --start-sec <秒>       略過 t_base 小於此秒數的 GPS 點位（預設 0）
  --gps-offset <N>       擷取幀不變，JPEG EXIF GPS 改用錨點前/後第 N 筆點位（預設 0）
  --frame-offset <N|-N>  在算出的 frame_index 上加 N 幀（預設 0）
  --crop <w>x<h>         擷取後自左上角裁切
  --offset <±HH:MM>      當地時區（DateTimeOriginal 用），預設 +09:00
  --jpeg-quality <n>     MJPEG -q:v（1 最佳畫質，預設 1）
  --write-parallel <N>   擷取後寫檔平行數，預設 4
  --make <字串>          EXIF Make（選填）
  --model <字串>         EXIF Model（選填）
  --artist <字串>        EXIF Artist（選填）
  --help                 顯示此說明

範例:
  node extract-mov-gps.js --video ./NOML000256.MOV --offset +09:00 --make "Action Cam"
  node extract-mov-gps.js --video ./NOML000256.MOV --out ./_out/NOML000256-test --max-points 5
`);
}

function parseArgs(argv) {
  const opts = {
    video: null,
    outDir: null,
    gpxOnly: false,
    pointStep: 1,
    maxPoints: null,
    startSec: 0,
    gpsOffset: 0,
    frameOffset: 0,
    crop: null,
    tzOffsetStr: '+09:00',
    jpegQuality: 1,
    writeParallel: 4,
    make: null,
    model: null,
    artist: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--video') opts.video = argv[++i];
    else if (a === '--out') opts.outDir = argv[++i];
    else if (a === '--gpx-only') opts.gpxOnly = true;
    else if (a === '--point-step') opts.pointStep = parsePositiveInt(argv[++i], 1);
    else if (a === '--max-points') opts.maxPoints = parsePositiveInt(argv[++i], null);
    else if (a === '--start-sec') opts.startSec = parseNonNegativeFloat(argv[++i], 0);
    else if (a === '--gps-offset') opts.gpsOffset = parseInteger(argv[++i], 0);
    else if (a === '--frame-offset') opts.frameOffset = parseInteger(argv[++i], 0);
    else if (a === '--crop') opts.crop = parseCrop(argv[++i]);
    else if (a === '--offset') opts.tzOffsetStr = argv[++i];
    else if (a === '--jpeg-quality') opts.jpegQuality = parsePositiveInt(argv[++i], 1);
    else if (a === '--write-parallel') opts.writeParallel = parsePositiveInt(argv[++i], 4);
    else if (a === '--make') opts.make = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--artist') opts.artist = argv[++i];
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
    console.error('--crop 須為 <寬>x<高> 正整數，例如 1920x960');
    process.exit(1);
  }
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (width < 1 || height < 1) {
    console.error('--crop 寬高須為正整數');
    process.exit(1);
  }
  return { width, height };
}

function parseExiftoolGpsDateTime(raw) {
  const s = String(raw ?? '').trim();
  const iso = s.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/
  );
  if (iso) {
    const ms = iso[7] ? parseInt(iso[7].padEnd(3, '0').slice(0, 3), 10) : 0;
    return Date.UTC(
      parseInt(iso[1], 10),
      parseInt(iso[2], 10) - 1,
      parseInt(iso[3], 10),
      parseInt(iso[4], 10),
      parseInt(iso[5], 10),
      parseInt(iso[6], 10),
      ms
    );
  }

  const exif = s.match(
    /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/
  );
  if (exif) {
    const ms = exif[7] ? parseInt(exif[7].padEnd(3, '0').slice(0, 3), 10) : 0;
    return Date.UTC(
      parseInt(exif[1], 10),
      parseInt(exif[2], 10) - 1,
      parseInt(exif[3], 10),
      parseInt(exif[4], 10),
      parseInt(exif[5], 10),
      parseInt(exif[6], 10),
      ms
    );
  }

  return null;
}

function parseOptionalNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s === '-') return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

function readEmbeddedGpsPoints(videoPath) {
  const fmt =
    '${GPSDateTime;DateFmt("%Y-%m-%dT%H:%M:%SZ")}\t$GPSLatitude\t$GPSLongitude\t$GPSSpeed\t$GPSTrack\t$GPSAltitude';
  const r = spawnSync(
    process.env.EXIFTOOL_BIN || 'exiftool',
    ['-q', '-q', '-f', '-ee', '-n', '-p', fmt, videoPath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 }
  );
  if (r.error) {
    throw new Error(`無法執行 exiftool: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`exiftool 失敗: ${r.stderr || r.stdout}`);
  }

  const points = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const utcMs = parseExiftoolGpsDateTime(parts[0]);
    const latDec = Number(parts[1]);
    const lonDec = Number(parts[2]);
    if (utcMs == null || !Number.isFinite(latDec) || !Number.isFinite(lonDec)) {
      continue;
    }
    points.push({
      utcMs,
      latDec,
      lonDec,
      speedKmh: parseOptionalNumber(parts[3]),
      course: parseOptionalNumber(parts[4]),
      altM: parseOptionalNumber(parts[5]),
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
    ' creator="extract-mov-gps"',
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    ' xmlns="http://www.topografix.com/GPX/1/0"',
    ' xsi:schemaLocation="http://www.topografix.com/GPX/1/0 http://www.topografix.com/GPX/1/0/gpx.xsd">',
    ' <trk>',
    `  <name>${escapeXmlText(name)}</name>`,
    '  <trkseg>',
  ];
  for (const p of points) {
    lines.push(`   <trkpt lat="${p.latDec}" lon="${p.lonDec}">`);
    if (Number.isFinite(p.altM)) {
      lines.push(`    <ele>${p.altM}</ele>`);
    }
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

function makeJobs(points, opts, fps, maxFrame) {
  const pointStep = Math.max(1, opts.pointStep || 1);
  const maxPoints =
    opts.maxPoints != null && Number.isFinite(opts.maxPoints)
      ? Math.max(1, Math.floor(opts.maxPoints))
      : Infinity;
  const startSec = Math.max(0, opts.startSec || 0);
  const utc0 = points[0].utcMs;
  const usedFrames = new Set();
  const jobs = [];

  for (let i = 0; i < points.length; i += pointStep) {
    const anchor = points[i];
    const tBase = (anchor.utcMs - utc0) / 1000;
    if (tBase + 1e-9 < startSec) continue;

    const gpsIndex = i + opts.gpsOffset;
    if (gpsIndex < 0 || gpsIndex >= points.length) {
      console.warn(
        `略過 GPS #${i}：gps-offset 後索引 ${gpsIndex} 超出 0…${points.length - 1}`
      );
      continue;
    }

    let frameIndex = frameIndexFromVideoTime(tBase, fps);
    frameIndex = applyFrameOffset(frameIndex, opts.frameOffset);
    if (frameIndex > maxFrame) {
      console.warn(
        `略過 GPS #${i}：frame_index ${frameIndex} 超過上限 ${maxFrame}（t=${tBase.toFixed(3)}s）`
      );
      continue;
    }
    if (usedFrames.has(frameIndex)) {
      console.warn(`略過重複 frame_index ${frameIndex}（GPS #${i}）`);
      continue;
    }

    usedFrames.add(frameIndex);
    jobs.push({ frameIndex, t: tBase, gps: points[gpsIndex] });
    if (jobs.length >= maxPoints) break;
  }

  jobs.sort((a, b) => a.frameIndex - b.frameIndex);
  return jobs;
}

async function extractJpegs(opts, points) {
  const probe = ffprobeVideoMeta(opts.video);
  const fps = probe.fps;
  const maxFrame =
    probe.nbFrames != null && probe.nbFrames > 0
      ? probe.nbFrames - 1
      : Math.max(0, Math.floor((probe.duration || 0) * fps) - 1);
  const jobs = makeJobs(points, opts, fps, maxFrame);

  if (jobs.length === 0) {
    console.log('無可輸出 JPEG 項目。');
    return;
  }

  const tmpPrefix = '_seq_';
  const tmpPattern = path.join(opts.outDir, `${tmpPrefix}%05d.jpg`);
  runFfmpegExtractBatch(
    opts.video,
    jobs.map((j) => j.frameIndex),
    tmpPattern,
    opts.jpegQuality
  );

  const offsetMinutes = parseTzOffsetToMinutes(opts.tzOffsetStr);
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
      await cropTopLeftIfNeeded(finalPath, opts.crop, opts.jpegQuality);
      await writeGpsExif(finalPath, {
        latDec: j.gps.latDec,
        lonDec: j.gps.lonDec,
        utcMs: j.gps.utcMs,
        course: j.gps.course,
        speedKmh: j.gps.speedKmh,
        altM: j.gps.altM,
        offsetMinutes,
        make: opts.make,
        model: opts.model,
        artist: opts.artist,
      });
      console.log(`${finalName}  frame=${j.frameIndex}`);
    }
  );

  console.log(
    `完成：${jobs.length} 張（fps=${fps}，maxFrame=${maxFrame}，tz=${opts.tzOffsetStr}，point-step=${opts.pointStep}，gps-offset=${opts.gpsOffset}，write-parallel=${opts.writeParallel}）`
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
  if (!opts.outDir) {
    opts.outDir = defaultOutDirFromVideo(opts.video);
  }
  if (!opts.outDir) {
    console.error('無法決定輸出目錄（請指定 --out）');
    process.exit(1);
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const points = readEmbeddedGpsPoints(opts.video);
  if (points.length === 0) {
    console.error('影片內沒有可用的 GPSDateTime/GPSLatitude/GPSLongitude 軌跡。');
    process.exit(1);
  }

  const stem = path.basename(opts.video, path.extname(opts.video));
  const gpxPath = path.join(opts.outDir, `${stem}.gpx`);
  writeTextAtomic(gpxPath, buildGpx(points, path.basename(opts.video)));
  console.log(`GPX: ${gpxPath}（${points.length} 點）`);

  if (!opts.gpxOnly) {
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
  readEmbeddedGpsPoints,
};
