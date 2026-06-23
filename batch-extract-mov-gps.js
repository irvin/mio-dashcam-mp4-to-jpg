#!/usr/bin/env node
/**
 * 批次處理 MOV/MP4 內嵌 GPS：掃描影片目錄頂層檔案，逐一呼叫 extract-mov-gps.js。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const extractMovGpsJs = path.join(__dirname, 'extract-mov-gps.js');

function printHelp() {
  console.log(`
用法:
  node batch-extract-mov-gps.js --video <影片目錄> [與 extract-mov-gps.js 相同的選項]
  node batch-extract-mov-gps.js ... --dry-run

說明:
  - 掃描 <影片目錄> 頂層 .mov/.mp4（不分大小寫）。
  - 每支影片會先在輸出資料夾寫出 <影片主檔名>.gpx，再依 GPS 點位抽 JPEG。
  - 若指定 --out <基底目錄>，每支影片輸出至 <基底目錄>/<主檔名>/。
  - 未指定 --out 時，單檔腳本會使用 ./_out/<主檔名>/。
  - --dry-run 只列出將執行的指令。
`);
}

function collectForwardArgs(argv) {
  const parts = [];
  let outBase = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--dry-run') continue;
    if (a === '--video') {
      i++;
      continue;
    }
    if (a === '--out') {
      outBase = argv[++i];
      continue;
    }
    if (a === '--gpx-only') {
      parts.push(a);
      continue;
    }
    if (
      a === '--point-step' ||
      a === '--max-points' ||
      a === '--start-sec' ||
      a === '--gps-offset' ||
      a === '--frame-offset' ||
      a === '--crop' ||
      a === '--offset' ||
      a === '--jpeg-quality' ||
      a === '--write-parallel' ||
      a === '--make' ||
      a === '--model' ||
      a === '--artist'
    ) {
      parts.push(a, argv[++i]);
      continue;
    }
    console.error('未知參數:', a);
    process.exit(1);
  }
  return { parts, outBase };
}

function parseBatchArgs(argv) {
  let videoDir = null;
  let dryRun = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--video') videoDir = argv[++i];
    else if (a === '--dry-run') dryRun = true;
  }
  return { videoDir, dryRun };
}

function listVideosInDir(dir) {
  const videos = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!/\.(mov|mp4)$/i.test(name)) continue;
    videos.push(full);
  }
  videos.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return videos;
}

function quoteArg(s) {
  return /\s/.test(s) ? JSON.stringify(s) : s;
}

function main() {
  const parsed = collectForwardArgs(process.argv);
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  const { videoDir, dryRun } = parseBatchArgs(process.argv);
  if (!videoDir) {
    console.error('請提供 --video <影片目錄>');
    printHelp();
    process.exit(1);
  }

  const vResolved = path.resolve(videoDir);
  if (!fs.existsSync(vResolved)) {
    console.error('找不到影片目錄:', vResolved);
    process.exit(1);
  }
  if (!fs.statSync(vResolved).isDirectory()) {
    console.error('--video 須為目錄:', vResolved);
    process.exit(1);
  }

  const videos = listVideosInDir(vResolved);
  if (videos.length === 0) {
    console.error('影片目錄內沒有 .mov/.mp4:', vResolved);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[dry-run] 影片目錄: ${vResolved}`);
    console.log(`[dry-run] 影片數: ${videos.length}`);
  }

  let okCount = 0;
  let failCount = 0;
  for (const videoPath of videos) {
    const stem = path.basename(videoPath, path.extname(videoPath));
    const args = [extractMovGpsJs, '--video', videoPath];
    if (parsed.outBase != null && String(parsed.outBase).trim() !== '') {
      args.push('--out', path.join(path.resolve(parsed.outBase), stem));
    }
    args.push(...parsed.parts);

    if (dryRun) {
      console.log(`  ${process.execPath} ${args.map(quoteArg).join(' ')}`);
      continue;
    }

    console.log(`[batch-mov] 開始: ${stem}`);
    const r = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    if (r.error) {
      failCount += 1;
      console.error(`[batch-mov] 失敗: ${stem}（spawn error）`, r.error);
      continue;
    }
    if (r.status !== 0) {
      failCount += 1;
      console.error(`[batch-mov] 失敗: ${stem}（exit=${r.status === null ? 1 : r.status}）`);
      continue;
    }
    okCount += 1;
    console.log(`[batch-mov] 完成: ${stem}`);
  }

  if (dryRun) {
    console.log('[dry-run] 結束（未執行 extract-mov-gps）');
    return;
  }

  console.log(`[batch-mov] 摘要：成功 ${okCount}、失敗 ${failCount}`);
  if (failCount > 0) process.exit(1);
}

main();
