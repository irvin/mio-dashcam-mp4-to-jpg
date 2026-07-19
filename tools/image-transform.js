const fs = require('fs');

function loadSharp() {
  try {
    return require('sharp');
  } catch (e) {
    throw new Error('需要安裝 sharp（請在專案目錄執行 npm install）');
  }
}

/** MJPEG -q:v（1～31）對應 sharp JPEG quality（1～100）。 */
function ffmpegQvToSharpQuality(qv) {
  const q = Math.min(31, Math.max(1, Number(qv) || 1));
  return Math.min(100, Math.max(1, Math.round(100 - ((q - 1) / 30) * 99)));
}

async function replaceWithTempFile(inputPath, suffix, operation) {
  const tmpPath = `${inputPath}.${suffix}.tmp.jpg`;
  try {
    await operation(tmpPath);
    fs.copyFileSync(tmpPath, inputPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      // 暫存檔不存在時不需處理。
    }
  }
}

/** 一次完成旋轉與裁切，避免同一張 JPEG 被重新編碼兩次。 */
async function transformJpeg({ input, output = input, rotateDeg = 0, crop = null, jpegQuality = 1 }) {
  const hasRotation = Number.isFinite(rotateDeg) && rotateDeg !== 0;
  const hasCrop =
    crop &&
    Number.isFinite(crop.width) &&
    Number.isFinite(crop.height) &&
    crop.width >= 1 &&
    crop.height >= 1;
  if (!hasRotation && !hasCrop) {
    if (output !== input) fs.copyFileSync(input, output);
    return;
  }

  const sharp = loadSharp();
  const sharpQ = ffmpegQvToSharpQuality(jpegQuality);
  const tempOutput = output === input ? `${input}.transform.tmp.jpg` : output;
  try {
    let pipeline = sharp(input);
    if (hasRotation) {
      pipeline = pipeline.rotate(rotateDeg, {
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      });
    }
    if (hasCrop) {
      pipeline.extract({
        left: Math.max(0, Math.floor(Number(crop.left) || 0)),
        top: Math.max(0, Math.floor(Number(crop.top) || 0)),
        width: crop.width,
        height: crop.height,
      });
    }
    await pipeline
      .withMetadata({ orientation: 1 })
      .jpeg({ quality: sharpQ, mozjpeg: true })
      .toFile(tempOutput);
    if (tempOutput !== output) fs.copyFileSync(tempOutput, output);
  } finally {
    if (tempOutput !== output) {
      try {
        fs.unlinkSync(tempOutput);
      } catch (_) {
        // 暫存檔不存在時不需處理。
      }
    }
  }
}

/** 順時針旋轉 JPEG；旋轉後畫布會自動擴張並以黑色補邊。 */
async function rotateJpegIfNeeded(jpegPath, rotateDeg, jpegQuality) {
  if (!Number.isFinite(rotateDeg) || rotateDeg === 0) return;
  const sharp = loadSharp();
  const sharpQ = ffmpegQvToSharpQuality(jpegQuality);
  await replaceWithTempFile(jpegPath, 'rotate', (tmpPath) =>
    sharp(jpegPath)
      .rotate(rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .jpeg({ quality: sharpQ, mozjpeg: true })
      .toFile(tmpPath)
  );
}

/** 自指定起點裁切 JPEG；超出圖面時縮小裁切範圍並提出警告。 */
async function cropTopLeftIfNeeded(jpegPath, crop, jpegQuality) {
  if (!crop || !Number.isFinite(crop.width) || !Number.isFinite(crop.height)) return;
  if (crop.width < 1 || crop.height < 1) return;
  const sharp = loadSharp();
  const sharpQ = ffmpegQvToSharpQuality(jpegQuality);
  const meta = await sharp(jpegPath).metadata();
  const iw = meta.width;
  const ih = meta.height;
  if (!iw || !ih) throw new Error('無法讀取圖片尺寸');

  const left = Math.max(0, Math.floor(Number(crop.left) || 0));
  const top = Math.max(0, Math.floor(Number(crop.top) || 0));
  if (left >= iw || top >= ih) {
    throw new Error(`crop-origin ${left}x${top} 超出圖面 ${iw}x${ih}: ${jpegPath}`);
  }
  let width = crop.width;
  let height = crop.height;
  const maxW = iw - left;
  const maxH = ih - top;
  if (width > maxW || height > maxH) {
    console.warn(
      `crop ${width}x${height}+${left}+${top} 大於圖面 ${iw}x${ih}，改裁 ${Math.min(width, maxW)}x${Math.min(height, maxH)}：${jpegPath}`
    );
    width = Math.min(width, maxW);
    height = Math.min(height, maxH);
  }

  await replaceWithTempFile(jpegPath, 'crop', (tmpPath) =>
    sharp(jpegPath)
      .extract({ left, top, width, height })
      .jpeg({ quality: sharpQ, mozjpeg: true })
      .toFile(tmpPath)
  );
}

module.exports = {
  cropTopLeftIfNeeded,
  ffmpegQvToSharpQuality,
  rotateJpegIfNeeded,
  transformJpeg,
};
