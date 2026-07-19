const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const sharp = require('sharp');

const { transformJpeg } = require('./image-transform');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-transform-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('transformJpeg', () => {
  it('does not re-encode an in-place no-op transform', async () => {
    const dir = makeTempDir();
    const input = path.join(dir, 'input.jpg');
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#785028' },
    }).jpeg({ quality: 90 }).toFile(input);
    const before = fs.readFileSync(input);

    await transformJpeg({ input });

    assert.deepStrictEqual(fs.readFileSync(input), before);
  });

  it('clamps a crop that extends beyond the transformed canvas', async () => {
    const dir = makeTempDir();
    const input = path.join(dir, 'input.jpg');
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#785028' },
    }).jpeg({ quality: 90 }).toFile(input);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
      await transformJpeg({
        input,
        crop: { left: 50, top: 40, width: 30, height: 20 },
      });
    } finally {
      console.warn = originalWarn;
    }

    const meta = await sharp(input).metadata();
    assert.deepStrictEqual({ width: meta.width, height: meta.height }, { width: 14, height: 8 });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /改裁 14x8/);
  });
});
