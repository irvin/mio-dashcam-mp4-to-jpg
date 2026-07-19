const assert = require('assert');
const { describe, it } = require('node:test');

const extract = require('./extract');

describe('extract helper exports', () => {
  it('keeps legacy image transform helpers loadable', () => {
    assert.strictEqual(typeof extract.cropTopLeftIfNeeded, 'function');
    assert.strictEqual(typeof extract.rotateJpegIfNeeded, 'function');
    assert.strictEqual(typeof extract.transformJpeg, 'function');
  });
});
