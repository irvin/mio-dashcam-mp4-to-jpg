#!/usr/bin/env node
/**
 * 批次：--video、--nmea 皆為**目錄**，依 MP4 主檔名在 NMEA 目錄尋找同名檔，逐一執行 extract.js。
 * 其餘參數會原樣轉給 extract.js（每筆作業會帶入各自的 --video、--nmea，以及選用的 --out）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const extractJs = path.join(__dirname, 'extract.js');

function printHelp() {
  console.log(`
用法:
  node batch-extract.js --video <影片目錄> --nmea <NMEA目錄> [與 extract.js 相同的選項]
  node batch-extract.js ... --dry-run

說明:
  - 掃描 <影片目錄> 內頂層的 .mp4（不分大小寫），依**主檔名**（不含副檔名）在 <NMEA目錄> 內尋找
    同名檔（副檔名可為 .nmea/.NMEA/.txt 等）。
  - 找不到對應 NMEA 時略過並警告。
  - 若指定 --out <基底目錄>，每支影片輸出至 <基底目錄>/<主檔名>/；未指定則與 extract 相同（./_out/<主檔名>/）。
  - --dry-run 只列出配對，不執行 extract。

其餘選項（--offset、--jpeg-quality、--frame-offset、--crop、校正模式等）皆轉給 extract.js。
`);
}

/** 與 extract.js parseArgs 一致，略過 --video/--nmea 與 --dry-run；--out 為批次「基底目錄」，不直接轉發 */
function collectForwardArgs(argv) {
  const parts = [];
  /** @type {string | null} */
  let outBase = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      return { help: true };
    }
    if (a === '--dry-run') continue;
    if (a === '--video' || a === '--nmea') {
      i++;
      continue;
    }
    if (a === '--out') {
      outBase = argv[++i];
      continue;
    }
    if (a === '--gps-offset') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--frame-offset') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--crop') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--jpeg-quality') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--offset') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--gga-max-delta-ms') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--make') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--model') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--artist') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--sample-start') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--sample-duration') {
      parts.push(a, argv[++i]);
      continue;
    }
    if (a === '--sample-step') {
      parts.push(a, argv[++i]);
      continue;
    }
    console.error('未知參數:', a);
    process.exit(1);
  }
  return { parts, outBase };
}

function parseBatchDirs(argv) {
  let videoDir = null;
  let nmeaDir = null;
  let dryRun = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--video') videoDir = argv[++i];
    else if (a === '--nmea') nmeaDir = argv[++i];
    else if (a === '--dry-run') dryRun = true;
  }
  return { videoDir, nmeaDir, dryRun };
}

function listMp4InDir(dir) {
  const names = fs.readdirSync(dir);
  const mp4 = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!/\.mp4$/i.test(name)) continue;
    mp4.push(full);
  }
  mp4.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return mp4;
}

/** 副檔名優先（.nmea 優於其他） */
function nmeaScore(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.nmea') return 3;
  if (ext === '.txt') return 1;
  return 2;
}

function findNmeaForStem(nmeaDir, stem) {
  const want = stem.toLowerCase();
  const candidates = [];
  const names = fs.readdirSync(nmeaDir);
  for (const name of names) {
    const full = path.join(nmeaDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const base = path.basename(name, path.extname(name));
    if (base.toLowerCase() !== want) continue;
    candidates.push(full);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ds = nmeaScore(b) - nmeaScore(a);
    if (ds !== 0) return ds;
    return path.basename(a).localeCompare(path.basename(b));
  });
  return candidates[0];
}

function main() {
  const argv = process.argv;
  const parsed = collectForwardArgs(argv);
  if (parsed && parsed.help) {
    printHelp();
    process.exit(0);
  }
  const forwardParts = parsed.parts;
  const outBase = parsed.outBase;
  const { videoDir, nmeaDir, dryRun } = parseBatchDirs(argv);

  if (!videoDir || !nmeaDir) {
    console.error('請同時提供 --video <影片目錄> 與 --nmea <NMEA目錄>');
    printHelp();
    process.exit(1);
  }

  const vResolved = path.resolve(videoDir);
  const nResolved = path.resolve(nmeaDir);

  if (!fs.existsSync(vResolved)) {
    console.error('找不到影片目錄:', vResolved);
    process.exit(1);
  }
  if (!fs.existsSync(nResolved)) {
    console.error('找不到 NMEA 目錄:', nResolved);
    process.exit(1);
  }
  if (!fs.statSync(vResolved).isDirectory()) {
    console.error('--video 須為目錄:', vResolved);
    process.exit(1);
  }
  if (!fs.statSync(nResolved).isDirectory()) {
    console.error('--nmea 須為目錄:', nResolved);
    process.exit(1);
  }

  const videos = listMp4InDir(vResolved);
  if (videos.length === 0) {
    console.error('影片目錄內沒有 .mp4:', vResolved);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[dry-run] 影片目錄: ${vResolved}`);
    console.log(`[dry-run] NMEA 目錄: ${nResolved}`);
  }

  let paired = 0;
  for (const videoPath of videos) {
    const stem = path.basename(videoPath, path.extname(videoPath));
    const nmeaPath = findNmeaForStem(nResolved, stem);
    if (!nmeaPath) {
      console.warn(`略過（無對應 NMEA）: ${path.basename(videoPath)}`);
      continue;
    }
    paired += 1;
    const args = [extractJs, '--video', videoPath, '--nmea', nmeaPath];
    if (outBase != null && String(outBase).trim() !== '') {
      args.push('--out', path.join(path.resolve(outBase), stem));
    }
    args.push(...forwardParts);
    if (dryRun) {
      console.log(`  → ${stem}  →  ${path.basename(nmeaPath)}`);
      console.log(`  ${process.execPath} ${args.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`);
      continue;
    }
    const r = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    if (r.status !== 0) {
      process.exit(r.status === null ? 1 : r.status);
    }
    if (r.error) {
      console.error(r.error);
      process.exit(1);
    }
  }

  if (paired === 0) {
    console.error(
      '沒有任何 MP4 與 NMEA 配對成功（請確認 NMEA 主檔名與 MP4 相同，且副檔名為 .nmea／.NMEA 等）'
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log('[dry-run] 結束（未執行 extract）');
  }
}

main();
