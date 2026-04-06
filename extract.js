#!/usr/bin/env node
/**
 * 依 NMEA 從 MP4 擷取 JPEG，並寫入 EXIF GPS（整數 fps：取該曆秒**第一**幀；非整數 fps：floor(t×fps)）。
 * --gps-offset：同一擷取幀，GPS 改用軌跡上前／後第 N 筆 RMC（整數索引位移）。
 * --frame-offset：在算出的 frame_index 上加減整數幀（再 clamp ≥0）。
 * --crop：擷取後以 sharp 自左上角 (0,0) 裁出寬×高（一般／校正皆可用；校正時在疊字前裁切）。
 * XMP 未另寫入；見 PLAN §4.3 與 README。
 * 截圖：以 frame index 用 ffmpeg select 一次解碼（見 PLAN §3.1）。
 * 需 PATH 中有 ffmpeg、ffprobe。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { exiftool } = require('exiftool-vendored');

const PKG = 'mio-dashcam-convert/extract.js';

/** 疊字／校正用座標小數位數 */
const OVERLAY_GEO_DECIMALS = 8;

/**
 * 未指定 `--out` 時：`_out/<MP4 主檔名>/`（主檔名＝不含副檔名，例如 FILE260403-103546F）。
 */
function defaultOutDirFromVideo(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') return null;
  const base = path.basename(videoPath, path.extname(videoPath));
  if (!base) return null;
  return path.join('_out', base);
}

function printHelp() {
  console.log(`
用法:
  node extract.js --video <檔.mp4> --nmea <檔.nmea> [選項]
  未指定 --out 時，輸出至 ./_out/<MP4主檔名>/

選項:
  --out <目錄>           輸出目錄（省略則 ./_out/<MP4主檔名>/）
  --fps <n>              影片幀率（預設 15，0 則用 ffprobe）
  --gps-offset <N>       整數；GPS 用「錨點 RMC 索引 ±N」（預設 0）。例：-1＝更早一筆 RMC
  --frame-offset <N|-N>  整數；在算出的 frame_index 上加 N 幀（預設 0）。正數寫 5，負數寫 -3。例：5 則 f15→f20
  --crop <w>x<h>        擷取後自左上角 (0,0) 裁出寬 w、高 h（預設不裁）。例：--crop 2560x1355；超出圖面則裁至圖內並警告
  --offset <±HH:MM>      當地時區（DateTimeOriginal 用），預設 +09:00
  --jpeg-quality <n>     MJPEG -q:v（1 最佳畫質，預設 1）
  --gga-max-delta-ms <n> 與 GGA 合併最大時間差（預設 1000），超過則海拔／HDOP 略過
  --make <字串>          EXIF Make（選填）
  --model <字串>         EXIF Model（選填）
  --artist <字串>        EXIF Artist（選填）
  --sample-start <秒>    校正：只取 t_base≥此秒之 RMC（預設 0）
  --sample-duration <N>  校正：有設定時最多輸出 **N** 筆（整數≥1）；依 --sample-step 掃 RMC 索引，自 t_base≥--sample-start 起算。**未設定**且命令列有 --sample-step → 全片 RMC。**須 --nmea**（另疊字；EXIF 與一般模式相同）
  --sample-step <N>      校正：RMC **索引**間隔（整數 ≥1，預設 1）。例：N=2 → 第 0,2,4… 筆（1-based 即 1,3,5…）。**全片**時**須**出現在命令列
  --help                 顯示此說明

範例:
  node extract.js --video ./FILE260403-103546F.mp4 --nmea ./FILE260403-103546F.NMEA --offset +09:00 --gps-offset -1
  node extract.js --video ./FILE260403-103546F.mp4 --nmea ./FILE260403-103546F.NMEA --out ./_out/FILE260403-103546F/calibrate --sample-duration 5 --sample-step 1 --offset +09:00 --frame-offset 7 --crop 2560x1355 --make Mio --model "MiVu 868W"
  node extract.js --video ./FILE260403-103546F.mp4 --nmea ./FILE260403-103546F.NMEA --out ./_out/FILE260403-103546F/sparse --sample-step 2 --offset +09:00
`);
}

function parseArgs(argv) {
  const opts = {
    video: null,
    nmea: null,
    outDir: null,
    fps: 15,
    gpsOffset: 0,
    frameOffset: 0,
    /** @type {{ width: number; height: number } | null} */
    crop: null,
    jpegQuality: 1,
    tzOffsetStr: '+09:00',
    ggaMaxDeltaMs: 1000,
    make: null,
    model: null,
    artist: null,
    sampleStart: 0,
    sampleDuration: null,
    sampleStep: 1,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a === '--video') opts.video = argv[++i];
    else if (a === '--nmea') opts.nmea = argv[++i];
    else if (a === '--out') opts.outDir = argv[++i];
    else if (a === '--fps') opts.fps = parseFloat(argv[++i]);
    else if (a === '--gps-offset') {
      const v = parseInt(argv[++i], 10);
      opts.gpsOffset = Number.isNaN(v) ? 0 : v;
    }
    else if (a === '--frame-offset') {
      const raw = String(argv[++i] ?? '').trim();
      const v = parseInt(raw, 10);
      opts.frameOffset = Number.isNaN(v) ? 0 : v;
    }
    else if (a === '--crop') {
      const raw = String(argv[++i] ?? '').trim();
      const m = raw.match(/^(\d+)\s*[xX]\s*(\d+)$/);
      if (!m) {
        console.error('--crop 須為 <寬>x<高> 正整數，例如 2560x1355');
        process.exit(1);
      }
      const cw = parseInt(m[1], 10);
      const ch = parseInt(m[2], 10);
      if (cw < 1 || ch < 1) {
        console.error('--crop 寬高須為正整數');
        process.exit(1);
      }
      opts.crop = { width: cw, height: ch };
    }
    else if (a === '--jpeg-quality') opts.jpegQuality = parseInt(argv[++i], 10);
    else if (a === '--offset') opts.tzOffsetStr = argv[++i];
    else if (a === '--gga-max-delta-ms') opts.ggaMaxDeltaMs = parseInt(argv[++i], 10);
    else if (a === '--make') opts.make = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--artist') opts.artist = argv[++i];
    else if (a === '--sample-start') opts.sampleStart = parseFloat(argv[++i]);
    else if (a === '--sample-duration') opts.sampleDuration = parseFloat(argv[++i]);
    else if (a === '--sample-step') {
      const v = parseInt(argv[++i], 10);
      opts.sampleStep = Number.isNaN(v) ? 1 : Math.max(1, v);
    }
    else {
      console.error('未知參數:', a);
      process.exit(1);
    }
  }
  return opts;
}

/** 解析 +09:00 / -05:30 → 相對 UTC 的分鐘數 */
function parseTzOffsetToMinutes(offsetStr) {
  const m = String(offsetStr).trim().match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (!m) return 9 * 60;
  const sign = m[1] === '-' ? -1 : 1;
  const h = parseInt(m[2], 10);
  const min = parseInt(m[3], 10);
  return sign * (h * 60 + min);
}

/**
 * 影片時間 t（秒）→ 擷取幀 index（CFR）。
 * **整數 fps**（如 15）：令 s=⌊t⌋，取該曆秒**第一**幀，即 `s*fps`。
 * **非整數 fps**：維持 `⌊t*fps⌋`（與舊版一致，避免每秒幀數非整數時定義曖昧）。
 */
function frameIndexFromVideoTime(t, fps) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return 0;
  if (!Number.isFinite(t)) return 0;
  const fInt = Math.round(f);
  if (Math.abs(f - fInt) < 1e-6 && fInt >= 1) {
    const s = Math.floor(t + 1e-9);
    const idx = s * fInt;
    return idx < 0 ? 0 : idx;
  }
  const legacy = Math.floor(t * f + 1e-9);
  return legacy < 0 ? 0 : legacy;
}

/**
 * 在 `frameIndexFromVideoTime` 結果上套用 `--frame-offset`（整數），再 clamp 至 ≥0。
 */
function applyFrameOffset(frameIndex, frameOffset) {
  let idx = frameIndex;
  if (frameOffset != null && Number.isFinite(frameOffset) && frameOffset !== 0) {
    idx += frameOffset;
  }
  if (idx < 0) idx = 0;
  return idx;
}

function stripChecksum(line) {
  const star = line.indexOf('*');
  return star >= 0 ? line.slice(0, star) : line;
}

function nmeaLatToDecimal(raw, hemi) {
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return null;
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let dec = deg + min / 60;
  if (hemi === 'S') dec = -dec;
  return dec;
}

function nmeaLonToDecimal(raw, hemi) {
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return null;
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let dec = deg + min / 60;
  if (hemi === 'W') dec = -dec;
  return dec;
}

function parseNmeaDateParts(ddmmyy) {
  const s = String(ddmmyy).padStart(6, '0');
  const d = parseInt(s.slice(0, 2), 10);
  const mo = parseInt(s.slice(2, 4), 10);
  const y = 2000 + parseInt(s.slice(4, 6), 10);
  return { y, mo, d };
}

function parseNmeaTimeParts(timeStr) {
  const [whole, frac = '0'] = String(timeStr).trim().split('.');
  const w = whole.padStart(6, '0');
  const h = parseInt(w.slice(0, 2), 10);
  const mi = parseInt(w.slice(2, 4), 10);
  const secInt = parseInt(w.slice(4, 6), 10);
  const s = secInt + parseFloat(`0.${frac}`);
  return { h, m: mi, s };
}

function utcMsFromNmeaDateTime(dateStr, timeStr) {
  const { y, mo, d } = parseNmeaDateParts(dateStr);
  const { h, m, s } = parseNmeaTimeParts(timeStr);
  return Date.UTC(y, mo - 1, d, h, m, s);
}

function parseNmeaFile(text) {
  const rmcList = [];
  const ggaList = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const L = line.trim();
    if (!L.startsWith('$')) continue;
    const body = stripChecksum(L);
    const parts = body.split(',');
    const id = parts[0];
    if (id.endsWith('RMC')) {
      const time = parts[1];
      const status = parts[2];
      const lat = parts[3];
      const ns = parts[4];
      const lon = parts[5];
      const ew = parts[6];
      const speedKnots = parts[7];
      const course = parts[8];
      const date = parts[9];
      if (status !== 'A' || !date || !time) continue;
      const utcMs = utcMsFromNmeaDateTime(date, time);
      const latDec = nmeaLatToDecimal(lat, ns);
      const lonDec = nmeaLonToDecimal(lon, ew);
      if (latDec == null || lonDec == null) continue;
      rmcList.push({
        utcMs,
        time,
        date,
        latDec,
        lonDec,
        speedKnots: parseFloat(speedKnots) || 0,
        course: parseFloat(course) || 0,
      });
    } else if (id.endsWith('GGA')) {
      const time = parts[1];
      const lat = parts[2];
      const ns = parts[3];
      const lon = parts[4];
      const ew = parts[5];
      const fixQ = parts[6];
      const numSats = parts[7];
      const hdop = parts[8];
      const alt = parts[9];
      if (!time) continue;
      ggaList.push({
        time,
        latDec: lat ? nmeaLatToDecimal(lat, ns) : null,
        lonDec: lon ? nmeaLonToDecimal(lon, ew) : null,
        fixQuality: fixQ,
        numSats: parseInt(numSats, 10) || 0,
        hdop: parseFloat(hdop),
        altitudeM: parseFloat(alt),
      });
    }
  }
  return { rmcList, ggaList };
}

/** NMEA 時間字串 → 當日秒數（可含小數秒） */
function nmeaTimeToSecOfDay(timeStr) {
  const { h, m, s } = parseNmeaTimeParts(timeStr);
  return h * 3600 + m * 60 + s;
}

/**
 * GGA 依檔案順序建立單調 UTC；遇時間「回捲」（跨 UTC 午夜）則日序 +1。
 * 基準曆日取自第一筆 RMC 的 ddmmyy（與 RMC 錨點一致）。
 */
function attachGgaUtcMsMonotonic(ggaList, refRmc) {
  const { y, mo, d } = parseNmeaDateParts(refRmc.date);
  let dayOffset = 0;
  let prevSec = null;
  return ggaList.map((g) => {
    const { h, m, s } = parseNmeaTimeParts(g.time);
    const secOfDay = nmeaTimeToSecOfDay(g.time);
    if (prevSec !== null && secOfDay + 1e-6 < prevSec) {
      dayOffset += 1;
    }
    prevSec = secOfDay;
    const utcMs = Date.UTC(y, mo - 1, d + dayOffset, h, m, s);
    return { ...g, utcMs };
  });
}

function nearestGga(rmcMs, ggaWithUtc) {
  let best = null;
  let bestAbs = Infinity;
  for (const g of ggaWithUtc) {
    if (g.utcMs == null) continue;
    const diff = Math.abs(g.utcMs - rmcMs);
    if (diff < bestAbs) {
      bestAbs = diff;
      best = g;
    }
  }
  return { gga: best, deltaMs: bestAbs };
}

function ffprobeVideoMeta(videoPath) {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_frames,r_frame_rate,avg_frame_rate,duration',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      videoPath,
    ],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) {
    throw new Error(`ffprobe 失敗: ${r.stderr || r.stdout}`);
  }
  const j = JSON.parse(r.stdout);
  const st = j.streams && j.streams[0];
  const fmtDur = j.format && parseFloat(j.format.duration);
  const nbFrames = st && st.nb_frames != null ? parseInt(st.nb_frames, 10) : null;
  const streamDur = st && st.duration != null ? parseFloat(st.duration) : null;
  const duration = streamDur || fmtDur;
  let fps = 15;
  if (st && st.r_frame_rate && st.r_frame_rate.includes('/')) {
    const [a, b] = st.r_frame_rate.split('/').map(Number);
    if (b) fps = a / b;
  }
  return { duration, nbFrames, fps };
}

/** 當地牆上時間 + SubSec（3 位毫秒字串） */
function utcMsToLocalExif(utcMs, offsetMinutes) {
  const localMs = utcMs + offsetMinutes * 60 * 1000;
  const d = new Date(localMs);
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  const ms = d.getUTCMilliseconds();
  const dateTime = `${y}:${pad(mo)}:${pad(day)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
  const subSec = String(ms).padStart(3, '0');
  return { dateTime, subSec };
}

function formatOffsetExif(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 疊字用：單行 UTC（毫秒） */
function formatUtcOverlayLine(utcMs) {
  const d = new Date(utcMs);
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `UTC ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${ms}`;
}

/** 疊字用：單行本地牆上時間 + 偏移 */
function formatLocalOverlayLine(utcMs, offsetMinutes) {
  const { dateTime } = utcMsToLocalExif(utcMs, offsetMinutes);
  const off = formatOffsetExif(offsetMinutes);
  return `本地 ${dateTime} (${off})`;
}

function nearestRmcIndexByUtcMs(rmcList, utcMsTarget) {
  let bestI = 0;
  let bestAbs = Infinity;
  for (let i = 0; i < rmcList.length; i++) {
    const diff = Math.abs(rmcList[i].utcMs - utcMsTarget);
    if (diff < bestAbs) {
      bestAbs = diff;
      bestI = i;
    }
  }
  return bestI;
}

function nearestRmcByUtcMs(rmcList, utcMsTarget) {
  return rmcList[nearestRmcIndexByUtcMs(rmcList, utcMsTarget)];
}

/**
 * 校正模式左下角：時間 + WGS84（與機台疊字對照）。
 * utcMs：與 **rmcForGps** 一致之 UTC（NMEA 曆元）。
 * rmcForGps：本張圖寫入／顯示之 $xxRMC（可為 --gps-offset 後之筆）。
 */
function buildCalibrationOverlayLines(j, utcMs, offsetMinutes, rmcForGps) {
  const tShow = j.t;
  const lines = [
    `t=${tShow.toFixed(3)}s  f=${String(j.frameIndex).padStart(5, '0')}`,
    formatUtcOverlayLine(utcMs),
    formatLocalOverlayLine(utcMs, offsetMinutes),
  ];
  const latStr = rmcForGps.latDec.toFixed(OVERLAY_GEO_DECIMALS);
  const lonStr = rmcForGps.lonDec.toFixed(OVERLAY_GEO_DECIMALS);
  lines.push(`WGS84 lat ${latStr}`);
  lines.push(`lon ${lonStr}`);
  return lines;
}

function formatGpsDateStamp(utcMs) {
  const d = new Date(utcMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())}`;
}

function formatGpsTimeStamp(utcMs) {
  const d = new Date(utcMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function formatIsoFilenameUtc(utcMs) {
  const d = new Date(utcMs);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}Z`
  );
}

function knotsToKmh(kn) {
  return kn * 1.852;
}

/** 由單一 metadata 物件產生 ExifTool 寫入欄位（單一真相來源） */
function buildExifTags(meta) {
  const {
    latDec,
    lonDec,
    altM,
    utcMs,
    hdop,
    speedKmh,
    course,
    offsetMinutes,
    make,
    model,
    artist,
  } = meta;

  const { dateTime: localDt, subSec } = utcMsToLocalExif(utcMs, offsetMinutes);
  const offStr = formatOffsetExif(offsetMinutes);

  const tags = {
    GPSLatitude: Math.abs(latDec),
    GPSLongitude: Math.abs(lonDec),
    GPSLatitudeRef: latDec >= 0 ? 'N' : 'S',
    GPSLongitudeRef: lonDec >= 0 ? 'E' : 'W',
    GPSMapDatum: 'WGS-84',
    GPSDateStamp: formatGpsDateStamp(utcMs),
    GPSTimeStamp: formatGpsTimeStamp(utcMs),
    DateTimeOriginal: localDt,
    CreateDate: localDt,
    OffsetTimeOriginal: offStr,
    OffsetTimeDigitized: offStr,
    SubSecTimeOriginal: subSec,
    SubSecTimeDigitized: subSec,
    Software: PKG,
    GPSTrack: course,
    GPSTrackRef: 'T',
    GPSImgDirection: course,
    GPSImgDirectionRef: 'T',
  };

  if (Number.isFinite(altM)) {
    tags.GPSAltitude = Math.abs(altM);
    tags.GPSAltitudeRef = altM >= 0 ? 0 : 1;
  }
  if (Number.isFinite(hdop)) {
    tags.GPSDOP = hdop;
  }
  if (Number.isFinite(speedKmh)) {
    tags.GPSSpeed = String(Math.round(speedKmh * 1000) / 1000);
    tags.GPSSpeedRef = 'K';
  }
  if (make) tags.Make = make;
  if (model) tags.Model = model;
  if (artist) tags.Artist = artist;

  return tags;
}

/** 單次 select 串接過長時 ffmpeg 會解析／記憶體失敗，故分批 */
const FFMPEG_SELECT_CHUNK = 25;

/**
 * 以 frame index 合併 select，解碼輸出序列圖（PLAN §3.1）。
 * jobs 須依 frameIndex 遞增排序；多批時會再命名成連續 _seq_00001.jpg …
 */
function runFfmpegExtractBatch(videoPath, frameIndices, outPattern, qv) {
  const q = Math.min(31, Math.max(1, Number(qv) || 1));
  if (frameIndices.length === 0) return;

  const dir = path.dirname(outPattern);
  const bn = path.basename(outPattern);
  const ext = path.extname(bn);
  const withoutExt = bn.slice(0, -ext.length);
  const basePrefix = withoutExt.replace('%05d', '');

  let outSeq = 1;
  for (let c = 0; c < frameIndices.length; c += FFMPEG_SELECT_CHUNK) {
    const chunk = frameIndices.slice(c, c + FFMPEG_SELECT_CHUNK);
    const partPattern = path.join(dir, `${basePrefix}part${c}_%05d${ext}`);
    const selectExpr = chunk.map((n) => `eq(n\\,${n})`).join('+');
    const vf = `select=${selectExpr}`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      videoPath,
      '-vf',
      vf,
      '-vsync',
      '0',
      '-f',
      'image2',
      '-q:v',
      String(q),
      partPattern,
    ];
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`ffmpeg 失敗: ${r.stderr || r.stdout}`);
    }
    for (let i = 0; i < chunk.length; i++) {
      const from = path.join(
        dir,
        `${basePrefix}part${c}_${String(i + 1).padStart(5, '0')}${ext}`
      );
      const to = path.join(
        dir,
        `${basePrefix}${String(outSeq).padStart(5, '0')}${ext}`
      );
      fs.renameSync(from, to);
      outSeq++;
    }
  }
}

/** MJPEG -q:v（1～31）對應 sharp JPEG quality（1～100） */
function ffmpegQvToSharpQuality(qv) {
  const q = Math.min(31, Math.max(1, Number(qv) || 1));
  return Math.min(100, Math.max(1, Math.round(100 - ((q - 1) / 30) * 99)));
}

/**
 * 自 JPEG 左上角 (0,0) 裁出 crop.width × crop.height；未指定 crop 則不處理。需 sharp。
 * 若請求範圍大於圖面，則裁至圖內並警告。校正模式應在疊字**之前**呼叫。
 */
async function cropTopLeftIfNeeded(jpegPath, crop, jpegQuality) {
  if (!crop || !Number.isFinite(crop.width) || !Number.isFinite(crop.height)) {
    return;
  }
  if (crop.width < 1 || crop.height < 1) return;
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    throw new Error('需要安裝 sharp（請在專案目錄執行 npm install）');
  }
  const sharpQ = ffmpegQvToSharpQuality(jpegQuality);
  const meta = await sharp(jpegPath).metadata();
  const iw = meta.width;
  const ih = meta.height;
  if (!iw || !ih) {
    throw new Error('無法讀取圖片尺寸');
  }
  let ew = crop.width;
  let eh = crop.height;
  if (ew > iw || eh > ih) {
    console.warn(
      `crop ${ew}x${eh} 大於圖面 ${iw}x${ih}，改裁 ${Math.min(ew, iw)}x${Math.min(eh, ih)}：${jpegPath}`
    );
    ew = Math.min(ew, iw);
    eh = Math.min(eh, ih);
  }
  const tmpPath = `${jpegPath}.crop.tmp.jpg`;
  await sharp(jpegPath)
    .extract({ left: 0, top: 0, width: ew, height: eh })
    .jpeg({ quality: sharpQ, mozjpeg: true })
    .toFile(tmpPath);
  try {
    fs.copyFileSync(tmpPath, jpegPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore */
    }
  }
}

function escapeXmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 依字元數粗估 sans-serif 數字／英文寬度（px） */
function approxTextWidthPx(charCount, fontSize) {
  return Math.ceil(charCount * fontSize * 0.52);
}

/**
 * 左下角多行文字疊字（底色僅包住文字區塊）。
 * lines 由上而下排列。
 */
async function overlayMultiLineTextOnJpeg(jpegPath, lines, jpegQuality) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    throw new Error('需要安裝 sharp（請在專案目錄執行 npm install）');
  }
  if (!lines || lines.length === 0) return;
  const sharpQ = ffmpegQvToSharpQuality(jpegQuality);
  const meta = await sharp(jpegPath).metadata();
  const w = meta.width;
  const h = meta.height;
  if (!w || !h) {
    throw new Error('無法讀取圖片尺寸');
  }
  const pad = Math.max(10, Math.round(Math.min(w, h) * 0.012));
  const fontSize = Math.max(16, Math.round(Math.min(w, h) * 0.02));
  const textPadX = 8;
  const textPadY = 6;
  const lineHeight = Math.round(fontSize * 1.22);
  const innerW = Math.max(
    ...lines.map((line) => approxTextWidthPx(line.length, fontSize))
  );
  const boxW = Math.min(w - 2 * pad, innerW + textPadX * 2);
  const boxH = lineHeight * lines.length + textPadY * 2;
  const boxLeft = pad;
  const boxTop = h - pad - boxH;
  const xText = boxLeft + textPadX;
  const textNodes = lines
    .map((line, i) => {
      const yy = boxTop + textPadY + fontSize + i * lineHeight;
      return `<text x="${xText}" y="${yy}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${fontSize}" fill="#ffffff">${escapeXmlText(line)}</text>`;
    })
    .join('');
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect x="${boxLeft}" y="${boxTop}" width="${boxW}" height="${boxH}" fill="rgba(0,0,0,0.78)" rx="4"/>
      ${textNodes}
    </svg>`
  );

  const tmpPath = `${jpegPath}.overlay.tmp.jpg`;
  await sharp(jpegPath)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: sharpQ, mozjpeg: true })
    .toFile(tmpPath);

  try {
    fs.copyFileSync(tmpPath, jpegPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore */
    }
  }
}

async function writeGpsExif(jpegPath, meta) {
  const tags = buildExifTags(meta);
  await exiftool.write(jpegPath, tags, ['-overwrite_original']);
}

/** 與一般模式相同之 EXIF GPS（含 GGA 合併規則）；疊字後呼叫以免被 sharp 洗掉。 */
async function writeGpsExifForJob(
  jpegPath,
  j,
  opts,
  offsetMinutes,
  ggaUtc,
  ggaMax
) {
  const { gga, deltaMs } = nearestGga(j.rmc.utcMs, ggaUtc);
  const ggaOk = gga && deltaMs <= ggaMax;
  const payload = {
    latDec: j.rmc.latDec,
    lonDec: j.rmc.lonDec,
    utcMs: j.rmc.utcMs,
    course: j.rmc.course,
    speedKmh: knotsToKmh(j.rmc.speedKnots),
    altM:
      ggaOk && gga && Number.isFinite(gga.altitudeM) ? gga.altitudeM : undefined,
    hdop: ggaOk && gga && Number.isFinite(gga.hdop) ? gga.hdop : undefined,
    offsetMinutes,
    make: opts.make,
    model: opts.model,
    artist: opts.artist,
  };
  await writeGpsExif(jpegPath, payload);
}

/**
 * PLAN §2.3：校正——依 **RMC 索引** 間隔抽樣（`i += sampleStep`）；錨點索引 `i` 決定 `t_base` 與擷取幀。
 * 有 `--sample-duration` 時最多輸出 **N** 筆（先略過 `t_base < sample-start`，再依序收錄成功之 job）；否則全片。
 * **另**疊印 t、UTC、本地、WGS84（須 --nmea）。
 */
async function runCalibrationSample(opts, fps, maxFrame) {
  const pointStep =
    opts.sampleStep != null &&
    Number.isFinite(opts.sampleStep) &&
    opts.sampleStep > 0
      ? Math.max(1, Math.floor(opts.sampleStep))
      : 1;
  const startSec = Math.max(0, opts.sampleStart || 0);

  const nmeaText = fs.readFileSync(opts.nmea, 'utf8');
  const { rmcList, ggaList } = parseNmeaFile(nmeaText);
  if (rmcList.length === 0) {
    console.error('校正模式：NMEA 中沒有有效的 $xxRMC（狀態 A）');
    process.exit(1);
  }
  const utc0 = rmcList[0].utcMs;

  const isWindow =
    opts.sampleDuration != null &&
    Number.isFinite(opts.sampleDuration) &&
    opts.sampleDuration > 0;
  const maxPoints = isWindow
    ? Math.max(1, Math.floor(opts.sampleDuration))
    : Infinity;

  const ggaUtc = attachGgaUtcMsMonotonic(ggaList, rmcList[0]);
  const ggaMax = Number.isFinite(opts.ggaMaxDeltaMs)
    ? opts.ggaMaxDeltaMs
    : 1000;

  const offsetMinutes = parseTzOffsetToMinutes(opts.tzOffsetStr);

  const usedFrames = new Set();
  const jobs = [];
  const go = opts.gpsOffset;
  for (let i = 0; i < rmcList.length; i += pointStep) {
    const tBase = (rmcList[i].utcMs - utc0) / 1000;
    if (tBase + 1e-9 < startSec) continue;

    const gi = i + go;
    if (gi < 0 || gi >= rmcList.length) {
      console.warn(
        `略過 RMC 索引 ${i}：gps-offset 後索引 ${gi} 超出 0…${rmcList.length - 1}`
      );
      continue;
    }
    const rmcGps = rmcList[gi];

    let frameIndex = frameIndexFromVideoTime(tBase, fps);
    if (frameIndex < 0) frameIndex = 0;
    frameIndex = applyFrameOffset(frameIndex, opts.frameOffset);
    if (frameIndex > maxFrame) continue;
    if (usedFrames.has(frameIndex)) continue;
    usedFrames.add(frameIndex);
    jobs.push({ frameIndex, t: tBase, rmc: rmcGps });
    if (isWindow && jobs.length >= maxPoints) break;
  }
  jobs.sort((a, b) => a.frameIndex - b.frameIndex);

  if (jobs.length === 0) {
    console.error(
      '校正模式：無有效幀（請檢查 --sample-start／--sample-duration／--sample-step／--frame-offset 或影片長度）'
    );
    process.exit(1);
  }

  const tmpPrefix = '_cal_';
  const tmpPattern = path.join(opts.outDir, `${tmpPrefix}%05d.jpg`);

  const indices = jobs.map((j) => j.frameIndex);
  runFfmpegExtractBatch(opts.video, indices, tmpPattern, opts.jpegQuality);

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const seqPath = path.join(opts.outDir, `${tmpPrefix}${String(i + 1).padStart(5, '0')}.jpg`);
    if (!fs.existsSync(seqPath)) {
      throw new Error(`預期輸出不存在: ${seqPath}`);
    }
    const finalName = `calibrate_f${String(j.frameIndex).padStart(5, '0')}_t${j.t.toFixed(3)}s.jpg`;
    const finalPath = path.join(opts.outDir, finalName);
    fs.renameSync(seqPath, finalPath);

    await cropTopLeftIfNeeded(finalPath, opts.crop, opts.jpegQuality);

    const lines = buildCalibrationOverlayLines(
      j,
      j.rmc.utcMs,
      offsetMinutes,
      j.rmc
    );
    await overlayMultiLineTextOnJpeg(finalPath, lines, opts.jpegQuality);

    await writeGpsExifForJob(
      finalPath,
      j,
      opts,
      offsetMinutes,
      ggaUtc,
      ggaMax
    );

    console.log(finalName);
  }

  const modeLabel = isWindow ? `前 ${maxPoints} 筆` : '全片';
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const j of jobs) {
    if (j.t < tMin) tMin = j.t;
    if (j.t > tMax) tMax = j.t;
  }
  const foNote =
    opts.frameOffset != null && opts.frameOffset !== 0
      ? `，frame-offset=${opts.frameOffset}`
      : '';
  const cropNote =
    opts.crop != null
      ? `，crop=${opts.crop.width}x${opts.crop.height}`
      : '';
  console.log(
    `完成（校正·${modeLabel}）：${jobs.length} 張（fps=${fps}，RMC 索引間隔=${pointStep}，t≈${tMin.toFixed(3)}…${tMax.toFixed(3)}s${foNote}${cropNote}）（已疊印；已寫 EXIF GPS）`
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
  if (!opts.outDir) {
    opts.outDir = defaultOutDirFromVideo(opts.video);
  }
  if (!opts.outDir) {
    console.error('無法決定輸出目錄（請指定 --out）');
    printHelp();
    process.exit(1);
  }

  const windowCal =
    opts.sampleDuration != null &&
    Number.isFinite(opts.sampleDuration) &&
    opts.sampleDuration > 0;
  const fullCalByStep =
    process.argv.includes('--sample-step') && !windowCal;
  const sampleMode = windowCal || fullCalByStep;

  if (!opts.nmea) {
    console.error(
      sampleMode
        ? '請提供 --nmea（校正模式必須搭配 NMEA）'
        : '請提供 --nmea'
    );
    printHelp();
    process.exit(1);
  }
  if (!fs.existsSync(opts.video)) {
    console.error('找不到影片:', opts.video);
    process.exit(1);
  }
  if (opts.nmea && !fs.existsSync(opts.nmea)) {
    console.error('找不到 NMEA:', opts.nmea);
    process.exit(1);
  }

  if (sampleMode) {
    const probe = ffprobeVideoMeta(opts.video);
    let fps = opts.fps > 0 ? opts.fps : probe.fps;
    const maxFrame =
      probe.nbFrames != null && probe.nbFrames > 0
        ? probe.nbFrames - 1
        : Math.max(0, Math.floor((probe.duration || 0) * fps) - 1);
    fs.mkdirSync(opts.outDir, { recursive: true });
    await runCalibrationSample(opts, fps, maxFrame);
    await exiftool.end();
    process.exit(0);
  }

  const offsetMinutes = parseTzOffsetToMinutes(opts.tzOffsetStr);
  const ggaMax = Number.isFinite(opts.ggaMaxDeltaMs) ? opts.ggaMaxDeltaMs : 1000;

  const nmeaText = fs.readFileSync(opts.nmea, 'utf8');
  const { rmcList, ggaList } = parseNmeaFile(nmeaText);
  if (rmcList.length === 0) {
    console.error('NMEA 中沒有有效的 $xxRMC（狀態 A）');
    process.exit(1);
  }

  const utc0 = rmcList[0].utcMs;
  const ggaUtc = attachGgaUtcMsMonotonic(ggaList, rmcList[0]);

  const probe = ffprobeVideoMeta(opts.video);
  let fps = opts.fps > 0 ? opts.fps : probe.fps;
  const maxFrame =
    probe.nbFrames != null && probe.nbFrames > 0
      ? probe.nbFrames - 1
      : Math.max(0, Math.floor((probe.duration || 0) * fps) - 1);

  fs.mkdirSync(opts.outDir, { recursive: true });

  const usedFrames = new Set();
  const jobs = [];

  const go = opts.gpsOffset;
  for (let i = 0; i < rmcList.length; i++) {
    const rmc = rmcList[i];
    const tBase = (rmc.utcMs - utc0) / 1000;

    const gi = i + go;
    if (gi < 0 || gi >= rmcList.length) {
      console.warn(
        `略過 RMC #${i}：gps-offset 後索引 ${gi} 超出 0…${rmcList.length - 1}`
      );
      continue;
    }
    const rmcGps = rmcList[gi];

    let frameIndex = frameIndexFromVideoTime(tBase, fps);
    if (frameIndex < 0) frameIndex = 0;
    frameIndex = applyFrameOffset(frameIndex, opts.frameOffset);
    if (frameIndex > maxFrame) {
      console.warn(
        `略過 RMC #${i}：frame_index ${frameIndex} 超過上限 ${maxFrame}（t=${tBase.toFixed(3)}s）`
      );
      continue;
    }
    if (usedFrames.has(frameIndex)) {
      console.warn(`略過重複 frame_index ${frameIndex}（RMC #${i}）`);
      continue;
    }
    usedFrames.add(frameIndex);

    const { gga, deltaMs } = nearestGga(rmcGps.utcMs, ggaUtc);
    const ggaOk = gga && deltaMs <= ggaMax;

    jobs.push({
      frameIndex,
      t: tBase,
      rmc: rmcGps,
      gga: ggaOk ? gga : null,
      deltaMs,
      ggaSkipped: gga && !ggaOk,
    });
  }

  jobs.sort((a, b) => a.frameIndex - b.frameIndex);

  const tmpPrefix = '_seq_';
  const tmpPattern = path.join(opts.outDir, `${tmpPrefix}%05d.jpg`);

  if (jobs.length === 0) {
    console.log('無可輸出項目。');
    process.exit(0);
  }

  const indices = jobs.map((j) => j.frameIndex);
  runFfmpegExtractBatch(opts.video, indices, tmpPattern, opts.jpegQuality);

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const seqPath = path.join(opts.outDir, `${tmpPrefix}${String(i + 1).padStart(5, '0')}.jpg`);
    if (!fs.existsSync(seqPath)) {
      throw new Error(`預期輸出不存在: ${seqPath}`);
    }
    const iso = formatIsoFilenameUtc(j.rmc.utcMs);
    const finalName = `${iso}_f${String(j.frameIndex).padStart(5, '0')}.jpg`;
    const finalPath = path.join(opts.outDir, finalName);
    fs.renameSync(seqPath, finalPath);

    await cropTopLeftIfNeeded(finalPath, opts.crop, opts.jpegQuality);

    const payload = {
      latDec: j.rmc.latDec,
      lonDec: j.rmc.lonDec,
      utcMs: j.rmc.utcMs,
      course: j.rmc.course,
      speedKmh: knotsToKmh(j.rmc.speedKnots),
      altM:
        j.gga && Number.isFinite(j.gga.altitudeM) ? j.gga.altitudeM : undefined,
      hdop: j.gga && Number.isFinite(j.gga.hdop) ? j.gga.hdop : undefined,
      offsetMinutes,
      make: opts.make,
      model: opts.model,
      artist: opts.artist,
    };

    await writeGpsExif(finalPath, payload);

    const ggaNote = j.ggaSkipped ? `GGA略過(Δ${j.deltaMs}ms)` : `GGAΔ=${j.deltaMs}ms`;
    console.log(`${finalName}  frame=${j.frameIndex}  ${ggaNote}`);
  }

  await exiftool.end();
  const foNote =
    opts.frameOffset != null && opts.frameOffset !== 0
      ? `，frame-offset=${opts.frameOffset}`
      : '';
  const cropNote =
    opts.crop != null ? `，crop=${opts.crop.width}x${opts.crop.height}` : '';
  console.log(
    `完成：${jobs.length} 張（fps=${fps}，maxFrame=${maxFrame}，tz=${opts.tzOffsetStr}，gps-offset=${opts.gpsOffset}${foNote}${cropNote}）`
  );
}

main().catch((err) => {
  console.error(err);
  exiftool.end().catch(() => {});
  process.exit(1);
});
