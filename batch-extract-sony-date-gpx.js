#!/usr/bin/env node
/**
 * Batch extract Sony Action Cam videos already organized by date folders.
 *
 * Each date folder is expected to contain:
 *   - one or more *.MP4 files
 *   - a gpx/ subfolder with GPX files copied for that date
 *
 * For every video in folders with GPX files, this script extracts a fixed
 * interval JPEG sequence using the video QuickTime CreateDate as UTC start
 * time. GPS/no-GPS is decided per video:
 *   - if the video time range overlaps the date GPX range, every JPEG gets
 *     the nearest GPS point
 *   - otherwise every JPEG is time-only with GPS left blank
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { buildGpx, parseGpxPoints } = require('./extract-sony-gps');

const extractJs = path.join(__dirname, 'extract-sony-gps.js');

function printHelp() {
  console.log(`
用法:
  node batch-extract-sony-date-gpx.js --sony-root <行車紀錄 - SONY> [選項]

選項:
  --sony-root <目錄>       SONY 影片根目錄
  --only-date <YYYY-MM-DD> 只處理指定日期；可重複
  --only-video <檔名>      只處理指定影片檔名或完整路徑；可重複
  --interval-sec <N>       每 N 秒抽一張（預設 1）
  --match-slop-sec <N>     判斷影片與 GPX 時間交集時的容許秒差（預設 0）
  --jpeg-quality <N>       ffmpeg MJPEG -q:v（預設 3）
  --offset <±HH:MM>        DateTimeOriginal 時區（預設 +08:00）
  --make <字串>            EXIF Make（預設 SONY）
  --model <字串>           EXIF Model
  --write-parallel <N>     EXIF 寫入平行數（預設 4）
  --out-suffix <字串>      每支影片輸出子目錄後綴（預設 _jpg_1s）
  --log-file <檔案>        完整抽圖 log（預設 ./sony-date-gpx-extract.log）
  --overwrite              若輸出子目錄已有 jpg，仍重新處理
  --stop-on-error          單支影片失敗時停止；預設記錄錯誤後繼續
  --dry-run                只列出工作，不輸出 JPEG
`);
}

function parseArgs(argv) {
  const opts = {
    sonyRoot: null,
    onlyDates: new Set(),
    onlyVideos: new Set(),
    intervalSec: 1,
    matchSlopSec: 0,
    jpegQuality: 3,
    offset: '+08:00',
    make: 'SONY',
    model: null,
    writeParallel: 4,
    outSuffix: '_jpg_1s',
    logFile: path.resolve('sony-date-gpx-extract.log'),
    overwrite: false,
    stopOnError: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--sony-root') opts.sonyRoot = argv[++i];
    else if (a === '--only-date') opts.onlyDates.add(argv[++i]);
    else if (a === '--only-video') opts.onlyVideos.add(argv[++i]);
    else if (a === '--interval-sec') opts.intervalSec = positiveInt(argv[++i], opts.intervalSec);
    else if (a === '--match-slop-sec') opts.matchSlopSec = nonNegativeNumber(argv[++i], opts.matchSlopSec);
    else if (a === '--jpeg-quality') opts.jpegQuality = positiveInt(argv[++i], opts.jpegQuality);
    else if (a === '--offset') opts.offset = argv[++i];
    else if (a === '--make') opts.make = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--write-parallel') opts.writeParallel = positiveInt(argv[++i], opts.writeParallel);
    else if (a === '--out-suffix') opts.outSuffix = argv[++i];
    else if (a === '--log-file') opts.logFile = argv[++i];
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--stop-on-error') opts.stopOnError = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else {
      console.error('未知參數:', a);
      process.exit(1);
    }
  }
  return opts;
}

function positiveInt(raw, fallback) {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseQuickTimeCreateDate(raw) {
  const m = String(raw ?? '').match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    parseInt(m[6], 10)
  );
}

function listDateDirs(sonyRoot, opts) {
  return fs
    .readdirSync(sonyRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => opts.onlyDates.size === 0 || opts.onlyDates.has(name))
    .sort();
}

function listVideos(dateDir, opts) {
  return fs
    .readdirSync(dateDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.mp4$/i.test(e.name))
    .map((e) => path.join(dateDir, e.name))
    .filter((file) => {
      if (opts.onlyVideos.size === 0) return true;
      return opts.onlyVideos.has(file) || opts.onlyVideos.has(path.basename(file));
    })
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function listGpx(dateDir) {
  const gpxDir = path.join(dateDir, 'gpx');
  if (!fs.existsSync(gpxDir)) return [];
  return fs
    .readdirSync(gpxDir)
    .filter((name) => /\.gpx$/i.test(name))
    .map((name) => path.join(gpxDir, name))
    .sort();
}

function mergedGpxForDate(dateName, gpxFiles) {
  const points = [];
  for (const file of gpxFiles) {
    points.push(...parseGpxPoints(file));
  }
  points.sort((a, b) => a.utcMs - b.utcMs);

  const deduped = [];
  let lastKey = null;
  for (const p of points) {
    const key = `${p.utcMs}:${p.latDec}:${p.lonDec}`;
    if (key === lastKey) continue;
    deduped.push(p);
    lastKey = key;
  }

  const tmpDir = path.join(os.tmpdir(), 'sony-date-gpx-merged');
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, `${dateName}.gpx`);
  fs.writeFileSync(out, buildGpx(deduped, `merged ${dateName}`));
  return {
    path: out,
    points: deduped.length,
    firstUtcMs: deduped.length ? deduped[0].utcMs : null,
    lastUtcMs: deduped.length ? deduped[deduped.length - 1].utcMs : null,
  };
}

function parseDurationSeconds(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw ?? '').trim();
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const seconds = s.match(/^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/i);
  if (seconds) return Number(seconds[1]);
  const m = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  return h * 3600 + min * 60 + sec;
}

function readVideoMeta(videos) {
  if (videos.length === 0) return new Map();
  const args = ['-json', '-CreateDate', '-Duration', ...videos];
  const r = spawnSync('exiftool', args, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`exiftool failed: ${r.stderr || r.stdout}`);
  }
  const rows = JSON.parse(r.stdout);
  const out = new Map();
  for (const row of rows) {
    out.set(row.SourceFile, {
      raw: row.CreateDate,
      utcMs: parseQuickTimeCreateDate(row.CreateDate),
      durationSec: parseDurationSeconds(row.Duration),
    });
  }
  return out;
}

function hasExistingJpegs(outDir) {
  if (!fs.existsSync(outDir)) return false;
  return fs.readdirSync(outDir).some((name) => /\.jpe?g$/i.test(name));
}

function buildExtractArgs(video, outDir, mergedGpx, createUtcMs, gpsMode, opts) {
  const gpsMaxDeltaSec = gpsMode === 'matched' ? 315360000 : 0;
  const args = [
    extractJs,
    '--video',
    video,
    '--gpx',
    mergedGpx,
    '--video-start',
    new Date(createUtcMs).toISOString(),
    '--out',
    outDir,
    '--full-interval-sec',
    String(opts.intervalSec),
    '--gps-max-delta-sec',
    String(gpsMaxDeltaSec),
    '--jpeg-quality',
    String(opts.jpegQuality),
    '--offset',
    opts.offset,
    '--make',
    opts.make,
    '--write-parallel',
    String(opts.writeParallel),
  ];
  if (opts.model) args.push('--model', opts.model);
  return args;
}

function lastMatchingLine(text, re) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (re.test(lines[i])) return lines[i];
  }
  return lines.at(-1) || '';
}

function videoOverlapsGpx(videoStartUtcMs, durationSec, gpxFirstUtcMs, gpxLastUtcMs, slopSec) {
  if (!Number.isFinite(videoStartUtcMs)) return false;
  const slopMs = Math.max(0, slopSec || 0) * 1000;
  const videoEndUtcMs = videoStartUtcMs + Math.max(0, Number.isFinite(durationSec) ? durationSec : 0) * 1000;
  return videoStartUtcMs <= gpxLastUtcMs + slopMs && videoEndUtcMs >= gpxFirstUtcMs - slopMs;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (!opts.sonyRoot) {
    console.error('請提供 --sony-root');
    printHelp();
    process.exit(1);
  }
  if (!fs.existsSync(opts.sonyRoot)) {
    console.error('找不到 SONY 根目錄:', opts.sonyRoot);
    process.exit(1);
  }

  const dateDirs = listDateDirs(opts.sonyRoot, opts);
  const jobs = [];
  let skippedNoGpx = 0;
  let skippedNoCreateDate = 0;
  let skippedExisting = 0;

  for (const dateName of dateDirs) {
    const dateDir = path.join(opts.sonyRoot, dateName);
    const videos = listVideos(dateDir, opts);
    if (videos.length === 0) continue;
    const gpxFiles = listGpx(dateDir);
    if (gpxFiles.length === 0) {
      skippedNoGpx += videos.length;
      continue;
    }
    const merged = mergedGpxForDate(dateName, gpxFiles);
    const videoMeta = readVideoMeta(videos);
    for (const video of videos) {
      const create = videoMeta.get(video);
      if (!create || create.utcMs == null) {
        skippedNoCreateDate++;
        console.log(`skip-no-create-date\t${video}`);
        continue;
      }
      const stem = path.basename(video, path.extname(video));
      const outDir = path.join(path.dirname(video), `${stem}${opts.outSuffix}`);
      if (!opts.overwrite && hasExistingJpegs(outDir)) {
        skippedExisting++;
        console.log(`skip-existing\t${outDir}`);
        continue;
      }
      jobs.push({
        dateName,
        video,
        outDir,
        gpxPath: merged.path,
        gpxPoints: merged.points,
        createRaw: create.raw,
        createUtcMs: create.utcMs,
        durationSec: create.durationSec,
        gpsMode: videoOverlapsGpx(
          create.utcMs,
          create.durationSec,
          merged.firstUtcMs,
          merged.lastUtcMs,
          opts.matchSlopSec
        )
          ? 'matched'
          : 'unmatched',
      });
    }
  }

  console.log(
    `summary\tjobs=${jobs.length}\tskipped_no_gpx=${skippedNoGpx}\tskipped_no_create_date=${skippedNoCreateDate}\tskipped_existing=${skippedExisting}`
  );

  if (opts.dryRun) {
    for (const job of jobs) {
      console.log(
        `dry-run\t${job.gpsMode}\t${job.dateName}\t${path.basename(job.video)}\tstart=${new Date(job.createUtcMs).toISOString()}\tduration=${job.durationSec ?? ''}\tgpx_points=${job.gpxPoints}\tout=${job.outDir}`
      );
    }
    return;
  }

  fs.writeFileSync(
    opts.logFile,
    `sony-date-gpx batch start ${new Date().toISOString()}\n` +
      `jobs=${jobs.length} interval=${opts.intervalSec}s matchSlop=${opts.matchSlopSec}s\n\n`
  );

  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    done++;
    console.log(
      `\n[${done}/${jobs.length}] ${job.gpsMode} ${job.dateName}/${path.basename(job.video)} start=${new Date(job.createUtcMs).toISOString()}`
    );
    const args = buildExtractArgs(job.video, job.outDir, job.gpxPath, job.createUtcMs, job.gpsMode, opts);
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
    fs.appendFileSync(
      opts.logFile,
      `\n===== [${done}/${jobs.length}] ${job.video} =====\n` +
        (r.stdout || '') +
        (r.stderr || '')
    );
    if (r.status !== 0) {
      failed++;
      console.error(`ERROR\textract failed (${r.status}): ${job.video}`);
      const tail = lastMatchingLine(`${r.stdout || ''}\n${r.stderr || ''}`, /./);
      if (tail) console.error(`ERROR-tail\t${tail}`);
      if (opts.stopOnError) {
        throw new Error(`extract failed (${r.status}): ${job.video}`);
      }
    } else {
      const summary = lastMatchingLine(r.stdout, /^完成：/);
      console.log(`done\t${path.basename(job.video)}\t${summary}`);
    }
  }
  console.log(`batch-complete\tjobs=${jobs.length}\tfailed=${failed}`);
  console.log(`log\t${opts.logFile}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
