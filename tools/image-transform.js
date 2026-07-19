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

function rotatedDimensions(width, height, rotateDeg) {
  const normalized = ((rotateDeg % 360) + 360) % 360;
  const near = (value) => Math.abs(normalized - value) < 1e-10;
  if (near(0) || near(180)) return { width, height };
  if (near(90) || near(270)) return { width: height, height: width };
  const radians = normalized * Math.PI / 180;
  return {
    width: Math.ceil(Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians)) - 1e-10),
    height: Math.ceil(Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians)) - 1e-10),
  };
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
      const meta = await sharp(input).metadata();
      if (!meta.width || !meta.height) throw new Error('無法讀取圖片尺寸');
      const canvas = hasRotation
        ? rotatedDimensions(meta.width, meta.height, rotateDeg)
        : { width: meta.width, height: meta.height };
      const left = Math.max(0, Math.floor(Number(crop.left) || 0));
      const top = Math.max(0, Math.floor(Number(crop.top) || 0));
      if (left >= canvas.width || top >= canvas.height) {
        throw new Error(`crop-origin ${left}x${top} 超出圖面 ${canvas.width}x${canvas.height}: ${input}`);
      }
      const width = Math.min(Math.floor(crop.width), canvas.width - left);
      const height = Math.min(Math.floor(crop.height), canvas.height - top);
      if (width !== crop.width || height !== crop.height) {
        console.warn(
          `crop ${crop.width}x${crop.height}+${left}+${top} 大於圖面 ${canvas.width}x${canvas.height}，改裁 ${width}x${height}：${input}`
        );
      }
      pipeline.extract({
        left,
        top,
        width,
        height,
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
  rotatedDimensions,
  transformJpeg,
};
