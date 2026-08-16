import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

const imageUrl = new URL('../og-image.png', import.meta.url);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parsePng(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), PNG_SIGNATURE, 'social image must be a PNG');

  let offset = 8;
  let ihdr = null;
  let sawPalette = false;
  let sawEnd = false;
  const idat = [];

  while (offset < buffer.length) {
    assert.ok(offset + 12 <= buffer.length, 'PNG chunk header is truncated');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    assert.ok(next <= buffer.length, `PNG ${type} chunk is truncated`);

    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') ihdr = data;
    if (type === 'PLTE') sawPalette = true;
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') {
      sawEnd = true;
      offset = next;
      break;
    }
    offset = next;
  }

  assert.ok(ihdr, 'PNG must contain IHDR');
  assert.equal(ihdr.length, 13, 'IHDR must be 13 bytes');
  assert.ok(idat.length > 0, 'PNG must contain IDAT');
  assert.equal(sawEnd, true, 'PNG must contain IEND');
  assert.equal(offset, buffer.length, 'PNG must not contain bytes after IEND');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filter = ihdr[11];
  const interlace = ihdr[12];

  assert.equal(width, 1200);
  assert.equal(height, 630);
  assert.equal(bitDepth, 8, 'social image must use 8-bit samples');
  assert.ok([2, 3, 6].includes(colorType), `unsupported social image color type: ${colorType}`);
  assert.equal(compression, 0);
  assert.equal(filter, 0);
  assert.equal(interlace, 0, 'social image must be non-interlaced so the validator can inspect every scanline');
  if (colorType === 3) assert.equal(sawPalette, true, 'indexed PNG must include a palette');

  const bytesPerPixel = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (stride + 1) * height, 'PNG scanline data has an unexpected length');

  const pixelBytes = Buffer.allocUnsafe(stride * height);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = row * (stride + 1);
    const filterType = raw[sourceStart];
    assert.ok(filterType <= 4, `invalid PNG row filter: ${filterType}`);
    raw.copy(pixelBytes, row * stride, sourceStart + 1, sourceStart + 1 + stride);
  }

  const frequencies = new Uint32Array(256);
  for (const value of pixelBytes) frequencies[value] += 1;
  let distinctValues = 0;
  let dominantCount = 0;
  for (const count of frequencies) {
    if (count > 0) distinctValues += 1;
    dominantCount = Math.max(dominantCount, count);
  }

  assert.ok(distinctValues >= 16, `social image is suspiciously flat: only ${distinctValues} encoded pixel values`);
  assert.ok(dominantCount / pixelBytes.length < 0.95, 'social image is suspiciously close to a single flat value');
}

test('social sharing image is structurally decodable and visibly non-trivial', async () => {
  parsePng(await readFile(imageUrl));
});
