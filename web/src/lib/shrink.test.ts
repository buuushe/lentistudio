import { describe, expect, it, vi } from 'vitest';

import {
  fitScale,
  isHeavy,
  isOverHardLimit,
  jpegName,
  megabytes,
  shrinkAll,
  shrinkImage,
  UPLOAD_HARD_LIMIT_BYTES,
  UPLOAD_SOFT_LIMIT_BYTES
} from '@/lib/shrink';

function sized(name: string, bytes: number, type = 'image/jpeg'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('shrink helpers', () => {
  it('classifies files by the soft and hard limits', () => {
    expect(isHeavy(sized('a.jpg', UPLOAD_SOFT_LIMIT_BYTES))).toBe(false);
    expect(isHeavy(sized('a.jpg', UPLOAD_SOFT_LIMIT_BYTES + 1))).toBe(true);
    expect(isOverHardLimit(sized('a.tif', UPLOAD_HARD_LIMIT_BYTES + 1))).toBe(true);
    expect(megabytes(UPLOAD_HARD_LIMIT_BYTES)).toBe(25);
  });

  it('renames to jpg and keeps the base name', () => {
    expect(jpegName('Mariam Romatalieva-2.JPG')).toBe('Mariam Romatalieva-2.jpg');
    expect(jpegName('scan.001.tif')).toBe('scan.001.jpg');
    expect(jpegName('noext')).toBe('noext.jpg');
  });

  it('scales only images longer than the limit', () => {
    expect(fitScale(6000, 4000, 3000)).toBe(0.5);
    expect(fitScale(2000, 1000, 3000)).toBe(1);
    expect(fitScale(1000, 9000, 3000)).toBeCloseTo(1 / 3);
  });
});

describe('shrinkImage', () => {
  it('returns the file untouched when the browser cannot decode images', async () => {
    const file = sized('a.tif', 50);
    expect(await shrinkImage(file, 3000)).toBe(file);
  });

  it('shrinkAll reports progress and applies the shrink to every file', async () => {
    const files = [sized('a.jpg', 10), sized('b.jpg', 20)];
    const shrink = vi.fn(async (file: File) => sized(jpegName(file.name), 1));
    const seen: number[] = [];
    const result = await shrinkAll(files, 3000, (done) => seen.push(done), shrink);
    expect(seen).toEqual([0, 1, 2]);
    expect(result.map((f) => f.size)).toEqual([1, 1]);
    expect(shrink).toHaveBeenCalledWith(files[1], 3000);
  });
});
