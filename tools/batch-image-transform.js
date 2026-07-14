#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { exiftool } = require('exiftool-vendored');
const {
  inspectJpegTransformLimits,
  suggestLosslessCrops,
  transformJpeg,
} = require('./image-transform');

function usage() {
  console.log(`用法:
  node tools/batch-image-transform.js --input-dir <目錄> --output-dir <目錄> [選項]

選項:
  --input-dir <目錄>       輸入 JPG 目錄（必填）
  --output-dir <目錄>      輸出 JPG 目錄（必填）
  --rotate-deg <度數>      順時針旋轉，預設 0
  --crop-origin <x>x<y>   裁切起點，預設 0x0
  --crop <寬>x<高>        裁切尺寸（必填）
  --concurrency <N>        平行處理數，預設 4
  --jpeg-quality <N>       JPEG quality 1-100，預設 95
  --recursive              遞迴處理輸入目錄
  --overwrite              覆寫既有輸出
  --suggest-fast-crop      抽查輸入 JPEG，提出 MCU 對齊裁切建議
  --sample-count <N>       建議模式抽查張數，預設 10
  --help                   顯示說明

範例:
  node tools/batch-image-transform.js \\
    --input-dir ./geocoded --output-dir ./cut \\
    --rotate-deg 1 --crop-origin 128x15 --crop 1780x920`);
}

function value(argv, index, option) {
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
    throw new Error(`${option} 需要值`);
  }
  return argv[index + 1];
}

function positiveNumber(raw, option) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${option} 必須是正數`);
  return n;
}

function parsePair(raw, option) {
  const m = String(raw).match(/^(\d+)x(\d+)$/i);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) {
    throw new Error(`${option} 格式應為 <數字>x<數字>`);
  }
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseArgs(argv) {
  const opts = {
    inputDir: null,
    outputDir: null,
    rotateDeg: 0,
    cropOrigin: { left: 0, top: 0 },
    crop: null,
    concurrency: 4,
    jpegQuality: 95,
    recursive: false,
    overwrite: false,
    suggestFastCrop: false,
    sampleCount: 10,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--input-dir') {
      opts.inputDir = value(argv, i++, arg);
    } else if (arg === '--output-dir') {
      opts.outputDir = value(argv, i++, arg);
    } else if (arg === '--rotate-deg') {
      opts.rotateDeg = Number(value(argv, i++, arg));
      if (!Number.isFinite(opts.rotateDeg)) throw new Error(`${arg} 必須是數字`);
    } else if (arg === '--crop-origin') {
      const p = parsePair(value(argv, i++, arg), arg);
      opts.cropOrigin = { left: p.width, top: p.height };
    } else if (arg === '--crop') {
      opts.crop = parsePair(value(argv, i++, arg), arg);
    } else if (arg === '--concurrency') {
      opts.concurrency = Math.floor(positiveNumber(value(argv, i++, arg), arg));
    } else if (arg === '--jpeg-quality') {
      opts.jpegQuality = Math.floor(positiveNumber(value(argv, i++, arg), arg));
      if (opts.jpegQuality > 100) throw new Error(`${arg} 必須介於 1 到 100`);
    } else if (arg === '--recursive') {
      opts.recursive = true;
    } else if (arg === '--overwrite') {
      opts.overwrite = true;
    } else if (arg === '--suggest-fast-crop') {
      opts.suggestFastCrop = true;
    } else if (arg === '--sample-count') {
      opts.sampleCount = Math.floor(positiveNumber(value(argv, i++, arg), arg));
    } else {
      throw new Error(`未知參數：${arg}`);
    }
  }

  if (opts.help) return opts;
  if (!opts.inputDir || !opts.crop || (!opts.outputDir && !opts.suggestFastCrop)) {
    throw new Error('--input-dir、--crop 都是必填；執行轉檔時另需 --output-dir');
  }
  return opts;
}

function listJpegs(dir, recursive, relative = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory() && recursive) files.push(...listJpegs(full, true, rel));
    else if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) files.push({ full, rel });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function transformOne(input, output, opts) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (!opts.overwrite && fs.existsSync(output)) return 'skipped';

  const crop = opts.crop;
  await transformJpeg({
    input,
    output,
    rotateDeg: opts.rotateDeg,
    crop: { left: opts.cropOrigin.left, top: opts.cropOrigin.top, width: crop.width, height: crop.height },
    jpegQuality: opts.jpegQuality,
  });

  await exiftool.write(
    output,
    { Orientation: 1, ExifImageWidth: crop.width, ExifImageHeight: crop.height },
    ['-overwrite_original']
  );
  return 'written';
}

async function runPool(jobs, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= jobs.length) return;
      await worker(jobs[index], index);
    }
  });
  await Promise.all(workers);
}

function selectSamples(files, count) {
  const sampleSize = Math.min(files.length, count);
  if (sampleSize <= 1) return files.slice(0, sampleSize);
  const indexes = new Set();
  for (let i = 0; i < sampleSize; i++) {
    indexes.add(Math.round((i * (files.length - 1)) / (sampleSize - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((index) => files[index]);
}

async function suggestFastCrop(files, crop, sampleCount) {
  if (files.length === 0) throw new Error('輸入目錄沒有 JPG');
  const samples = selectSamples(files, sampleCount);
  const inspected = [];
  for (const file of samples) inspected.push(await inspectJpegTransformLimits(file.full));
  const first = inspected[0];
  const inconsistent = inspected.some((item) =>
    item.width !== first.width ||
    item.height !== first.height ||
    item.chromaSubsampling !== first.chromaSubsampling
  );
  const suggestions = suggestLosslessCrops(first, crop);
  console.log(`files: ${files.length}`);
  console.log(`sampled: ${samples.length}`);
  console.log(`source: ${first.width}x${first.height}`);
  console.log(`subsampling: ${first.chromaSubsampling}`);
  console.log(`MCU: ${first.mcu.width}x${first.mcu.height}`);
  console.log(`requested: ${crop.left}x${crop.top} + ${crop.width}x${crop.height}`);
  console.log(`inward: ${suggestions.inward.left}x${suggestions.inward.top} + ${suggestions.inward.width}x${suggestions.inward.height}`);
  console.log(`outward: ${suggestions.outward.left}x${suggestions.outward.top} + ${suggestions.outward.width}x${suggestions.outward.height}`);
  if (inconsistent) {
    console.warn('警告：輸入 JPEG 的尺寸或 chroma subsampling 不一致，以上建議只代表第一張。');
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return usage();
  if (!fs.statSync(opts.inputDir).isDirectory()) throw new Error(`找不到輸入目錄：${opts.inputDir}`);

  const files = listJpegs(opts.inputDir, opts.recursive);
  if (opts.suggestFastCrop) {
    await suggestFastCrop(files, {
      left: opts.cropOrigin.left,
      top: opts.cropOrigin.top,
      width: opts.crop.width,
      height: opts.crop.height,
    }, opts.sampleCount);
    return;
  }
  const jobs = files.map(({ full, rel }) => ({ input: full, output: path.join(opts.outputDir, rel) }));
  fs.mkdirSync(opts.outputDir, { recursive: true });
  let written = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  console.log(`開始：${jobs.length} 張，concurrency=${opts.concurrency}`);
  await runPool(jobs, opts.concurrency, async (job, index) => {
    try {
      const status = await transformOne(job.input, job.output, opts);
      if (status === 'skipped') skipped++;
      else written++;
      const done = written + skipped + failed;
      if (done === 1 || done % 100 === 0 || done === jobs.length) {
        console.log(`進度：${done}/${jobs.length}`);
      }
    } catch (error) {
      failed++;
      failures.push({ file: job.input, error: error.message });
      console.error(`失敗：${job.input}：${error.message}`);
    }
  });

  await exiftool.end();
  console.log(`完成：written=${written} skipped=${skipped} failed=${failed}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error.message);
  await exiftool.end().catch(() => {});
  process.exitCode = 1;
});
