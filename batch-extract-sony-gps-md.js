#!/usr/bin/env node
/**
 * Batch Sony Action Cam extraction from sony-gps-video-matches.md.
 *
 * - Rows under "## 清單" are processed with external GPX files.
 * - Rows under "## 有 MOFF 旁車檔的影片" are processed with the corresponding
 *   .moff file.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const extractJs = path.join(__dirname, 'extract-sony-gps.js');

function printHelp() {
  console.log(`
用法:
  node batch-extract-sony-gps-md.js --manifest <sony-gps-video-matches.md> --sony-root <影片根目錄> --gpx-root <GPX根目錄> --out <輸出根目錄> [選項]

選項:
  --only <相對影片路徑>  只處理指定影片；可重複
  --include-gpx          處理 ## 清單 的外部 GPX 影片（預設啟用）
  --no-gpx               不處理外部 GPX 影片
  --include-moff         處理 ## 有 MOFF 旁車檔的影片（預設啟用）
  --no-moff              不處理 MOFF 影片
  --max-points <N>       整批最多輸出 N 張；短測用
  --per-video-max <N>    每支影片最多輸出 N 張
  --point-step <N>       每 N 筆 GPS 點位取 1 張
  --full-interval-sec <N>
                         整片固定每 N 秒抽一張；時間用影片起點推算
  --gps-max-delta-sec <N>
                         整片固定間隔模式：GPS 最近點最大容許秒差；超過則 GPS 留空
  --write-gpx            將 GPS 點位另存 GPX 到每支影片輸出目錄
  --video-time-offset-sec <秒>
                         抽幀用影片秒數校正；負數代表往前抽，EXIF/GPS 不變
  --offset <±HH:MM>      DateTimeOriginal 時區（預設 +08:00）
  --jpeg-quality <n>     MJPEG -q:v（預設 3）
  --make <字串>          EXIF Make（預設 SONY）
  --model <字串>         EXIF Model（選填）
  --artist <字串>        EXIF Artist（選填）
  --rotate-deg <deg>     轉給單檔抽取器
  --crop <w>x<h>         轉給單檔抽取器
  --crop-origin <x>x<y>  轉給單檔抽取器
  --dry-run              只列出配對與命令，不輸出 JPEG
`);
}

function parseArgs(argv) {
  const opts = {
    manifest: null,
    sonyRoot: null,
    gpxRoot: null,
    outRoot: null,
    only: new Set(),
    includeGpx: true,
    includeMoff: true,
    maxPoints: null,
    perVideoMax: null,
    pointStep: null,
    fullIntervalSec: null,
    gpsMaxDeltaSec: null,
    writeGpx: false,
    videoTimeOffsetSec: null,
    offset: '+08:00',
    jpegQuality: 3,
    make: 'SONY',
    model: null,
    artist: null,
    rotateDeg: null,
    crop: null,
    cropOrigin: null,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--sony-root') opts.sonyRoot = argv[++i];
    else if (a === '--gpx-root') opts.gpxRoot = argv[++i];
    else if (a === '--out') opts.outRoot = argv[++i];
    else if (a === '--only') opts.only.add(normalizeRel(argv[++i]));
    else if (a === '--include-gpx') opts.includeGpx = true;
    else if (a === '--no-gpx') opts.includeGpx = false;
    else if (a === '--include-moff') opts.includeMoff = true;
    else if (a === '--no-moff') opts.includeMoff = false;
    else if (a === '--max-points') opts.maxPoints = parsePositiveInt(argv[++i], null);
    else if (a === '--per-video-max') opts.perVideoMax = parsePositiveInt(argv[++i], null);
    else if (a === '--point-step') opts.pointStep = parsePositiveInt(argv[++i], null);
    else if (a === '--full-interval-sec') opts.fullIntervalSec = parsePositiveInt(argv[++i], null);
    else if (a === '--gps-max-delta-sec') opts.gpsMaxDeltaSec = argv[++i];
    else if (a === '--write-gpx') opts.writeGpx = true;
    else if (a === '--video-time-offset-sec') opts.videoTimeOffsetSec = argv[++i];
    else if (a === '--offset') opts.offset = argv[++i];
    else if (a === '--jpeg-quality') opts.jpegQuality = parsePositiveInt(argv[++i], 3);
    else if (a === '--make') opts.make = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--artist') opts.artist = argv[++i];
    else if (a === '--rotate-deg') opts.rotateDeg = argv[++i];
    else if (a === '--crop') opts.crop = argv[++i];
    else if (a === '--crop-origin') opts.cropOrigin = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else {
      console.error('未知參數:', a);
      process.exit(1);
    }
  }
  return opts;
}

function parsePositiveInt(raw, fallback) {
  const v = parseInt(String(raw ?? '').trim(), 10);
  if (Number.isNaN(v) || v < 1) return fallback;
  return v;
}

function normalizeRel(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function splitSection(md, title) {
  const re = new RegExp(`^## ${escapeRegExp(title)}\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return '';
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLocalRange(cell, offset) {
  const m = String(cell).match(
    /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+-\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/
  );
  if (!m) throw new Error(`無法解析時間範圍: ${cell}`);
  return {
    startIso: `${m[1]}T${m[2]}${offset}`,
    endIso: `${m[3]}T${m[4]}${offset}`,
  };
}

function parseTableRows(section) {
  return section
    .split(/\r?\n/)
    .filter((line) => /^\| `/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function parseGpxJobs(md, opts) {
  const section = splitSection(md, '清單');
  const rows = parseTableRows(section);
  const jobs = [];
  for (const cells of rows) {
    const videoRel = normalizeRel(matchBacktick(cells[0]));
    const gpxRel = normalizeRel(matchBacktick(cells[3]));
    if (!videoRel || !gpxRel) continue;
    const range = parseLocalRange(cells[1], opts.offset);
    jobs.push({
      kind: 'gpx',
      videoRel,
      gpxRel,
      videoStart: range.startIso,
      videoEnd: range.endIso,
    });
  }
  return jobs;
}

function parseMoffJobs(md) {
  const section = splitSection(md, '有 MOFF 旁車檔的影片');
  const rows = parseTableRows(section);
  const jobs = [];
  for (const cells of rows) {
    const videoRel = normalizeRel(matchBacktick(cells[0]));
    const moffRel = normalizeRel(matchBacktick(cells[1]));
    if (!videoRel || !moffRel) continue;
    jobs.push({ kind: 'moff', videoRel, moffRel });
  }
  return jobs;
}

function matchBacktick(s) {
  const m = String(s ?? '').match(/`([^`]+)`/);
  return m ? m[1] : null;
}

function safeOutSubdir(videoRel) {
  const dir = path.dirname(videoRel);
  const stem = path.basename(videoRel, path.extname(videoRel));
  return path.join(dir === '.' ? '' : dir, stem);
}

function shellQuoteArg(s) {
  const raw = String(s);
  if (!/\s/.test(raw)) return raw;
  return JSON.stringify(raw);
}

function buildCommand(job, opts, maxForThisJob) {
  const videoPath = path.join(opts.sonyRoot, job.videoRel);
  const outDir = path.join(opts.outRoot, safeOutSubdir(job.videoRel));
  const args = [
    extractJs,
    '--video',
    videoPath,
    '--out',
    outDir,
    '--offset',
    opts.offset,
    '--jpeg-quality',
    String(opts.jpegQuality),
    '--make',
    opts.make,
  ];

  if (job.kind === 'gpx') {
    args.push(
      '--gpx',
      path.join(opts.gpxRoot, job.gpxRel),
      '--video-start',
      job.videoStart,
      '--video-end',
      job.videoEnd
    );
  } else {
    args.push('--moff', path.join(opts.sonyRoot, job.moffRel));
  }

  if (maxForThisJob != null) args.push('--max-points', String(maxForThisJob));
  if (opts.pointStep != null) args.push('--point-step', String(opts.pointStep));
  if (opts.fullIntervalSec != null) {
    args.push('--full-interval-sec', String(opts.fullIntervalSec));
  }
  if (opts.gpsMaxDeltaSec != null) {
    args.push('--gps-max-delta-sec', opts.gpsMaxDeltaSec);
  }
  if (opts.writeGpx) args.push('--write-gpx');
  if (opts.videoTimeOffsetSec != null) {
    args.push('--video-time-offset-sec', opts.videoTimeOffsetSec);
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.artist) args.push('--artist', opts.artist);
  if (opts.rotateDeg != null) args.push('--rotate-deg', opts.rotateDeg);
  if (opts.crop != null) args.push('--crop', opts.crop);
  if (opts.cropOrigin != null) args.push('--crop-origin', opts.cropOrigin);
  if (opts.dryRun) args.push('--dry-run');
  return { args, videoPath, outDir };
}

function validateJobFiles(job, opts) {
  const videoPath = path.join(opts.sonyRoot, job.videoRel);
  if (!fs.existsSync(videoPath)) return `找不到影片: ${videoPath}`;
  if (job.kind === 'gpx') {
    const gpxPath = path.join(opts.gpxRoot, job.gpxRel);
    if (!fs.existsSync(gpxPath)) return `找不到 GPX: ${gpxPath}`;
  } else {
    const moffPath = path.join(opts.sonyRoot, job.moffRel);
    if (!fs.existsSync(moffPath)) return `找不到 MOFF: ${moffPath}`;
  }
  return null;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  for (const key of ['manifest', 'sonyRoot', 'outRoot']) {
    if (!opts[key]) {
      console.error(`請提供 --${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
      printHelp();
      process.exit(1);
    }
  }
  if (opts.includeGpx && !opts.gpxRoot) {
    console.error('處理 GPX 清單時需提供 --gpx-root');
    process.exit(1);
  }
  if (!fs.existsSync(opts.manifest)) {
    console.error('找不到 manifest:', opts.manifest);
    process.exit(1);
  }

  const md = fs.readFileSync(opts.manifest, 'utf8');
  let jobs = [];
  if (opts.includeGpx) jobs = jobs.concat(parseGpxJobs(md, opts));
  if (opts.includeMoff) jobs = jobs.concat(parseMoffJobs(md));
  if (opts.only.size > 0) {
    jobs = jobs.filter((job) => opts.only.has(normalizeRel(job.videoRel)));
  }

  if (jobs.length === 0) {
    console.error('沒有可處理項目');
    process.exit(1);
  }

  let remaining = opts.maxPoints;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  console.log(`工作數：${jobs.length}（GPX=${jobs.filter((j) => j.kind === 'gpx').length}，MOFF=${jobs.filter((j) => j.kind === 'moff').length}）`);

  for (const job of jobs) {
    if (remaining != null && remaining <= 0) {
      skipped += 1;
      continue;
    }
    const err = validateJobFiles(job, opts);
    if (err) {
      failed += 1;
      console.error(`[missing] ${job.videoRel}: ${err}`);
      continue;
    }
    let maxForThisJob = opts.perVideoMax;
    if (remaining != null) {
      maxForThisJob = maxForThisJob == null ? remaining : Math.min(maxForThisJob, remaining);
    }
    const { args } = buildCommand(job, opts, maxForThisJob);
    console.log(`[batch] ${job.kind}: ${job.videoRel}`);
    console.log(`  ${process.execPath} ${args.map(shellQuoteArg).join(' ')}`);
    const r = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    if (r.status === 0) {
      ok += 1;
      if (remaining != null && maxForThisJob != null) remaining -= maxForThisJob;
    } else {
      failed += 1;
    }
  }

  console.log(`批次完成：ok=${ok} failed=${failed} skipped=${skipped}`);
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseGpxJobs,
  parseMoffJobs,
};
