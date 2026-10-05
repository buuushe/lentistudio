import { describe, expect, it } from 'vitest';

import {
  applyAdjust,
  buildToneLut,
  defaultAdjust,
  isIdentityAdjust,
  layerAdjust,
  SHARPEN_STRENGTH,
  type PixelBuffer
} from '@/lib/adjust';

function solid(width: number, height: number, value: number): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

function withEdge(width: number, height: number): PixelBuffer {
  const image = solid(width, height, 40);
  for (let y = 0; y < height; y++) {
    for (let x = Math.floor(width / 2); x < width; x++) {
      const o = (y * width + x) * 4;
      image.data[o] = image.data[o + 1] = image.data[o + 2] = 200;
    }
  }
  return image;
}

const mean = (image: PixelBuffer): number => {
  let sum = 0;
  for (let i = 0; i < image.data.length; i += 4) sum += image.data[i];
  return sum / (image.data.length / 4);
};

const edgeEnergy = (image: PixelBuffer): number => {
  let sum = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 1; x < image.width; x++) {
      const o = (y * image.width + x) * 4;
      sum += Math.abs(image.data[o] - image.data[o - 4]);
    }
  }
  return sum;
};

describe('applyAdjust', () => {
  it('leaves the image untouched for the identity adjust', () => {
    const image = withEdge(16, 8);
    const before = Uint8ClampedArray.from(image.data);
    expect(isIdentityAdjust(defaultAdjust())).toBe(true);
    applyAdjust(image, defaultAdjust());
    expect(image.data).toEqual(before);
  });

  it('brightness raises the mean, contrast pushes values away from mid grey', () => {
    const bright = applyAdjust(solid(8, 8, 100), { brightness: 50, contrast: 0, sharpen: 0 });
    expect(mean(bright)).toBeGreaterThan(100);
    const dark = applyAdjust(solid(8, 8, 100), { brightness: 0, contrast: 50, sharpen: 0 });
    expect(mean(dark)).toBeLessThan(100);
    const light = applyAdjust(solid(8, 8, 160), { brightness: 0, contrast: 50, sharpen: 0 });
    expect(mean(light)).toBeGreaterThan(160);
  });

  it('matches the server formula for the tone LUT', () => {
    const lut = buildToneLut({ brightness: 10, contrast: 20, sharpen: 0 });
    expect(lut[128]).toBe(Math.round(128 + 12.7));
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });

  it('sharpen increases edge energy, keeps flat areas flat and is bounded', () => {
    const flat = applyAdjust(solid(8, 8, 90), { brightness: 0, contrast: 0, sharpen: 3 });
    expect(mean(flat)).toBe(90);
    const original = withEdge(16, 8);
    const sharpened = applyAdjust(withEdge(16, 8), { brightness: 0, contrast: 0, sharpen: 1 });
    expect(edgeEnergy(sharpened)).toBeGreaterThan(edgeEnergy(original));
    const extreme = applyAdjust(withEdge(16, 8), { brightness: 0, contrast: 0, sharpen: 99 });
    const capped = applyAdjust(withEdge(16, 8), { brightness: 0, contrast: 0, sharpen: 3 });
    expect(extreme.data).toEqual(capped.data);
    expect(1 + 4 * SHARPEN_STRENGTH - 4 * SHARPEN_STRENGTH).toBe(1);
  });
});

describe('layerAdjust', () => {
  it('gives the same tone curve as applying the balance and then the shared adjust', () => {
    const base = { brightness: 10, contrast: 20, sharpen: 0 };
    const over = { brightness: -5, contrast: 30, sharpen: 1 };
    const layered = buildToneLut(layerAdjust(base, over));
    const baseLut = buildToneLut(base);
    const overLut = buildToneLut(over);
    [40, 128, 170].forEach((value) => {
      expect(Math.abs(layered[value] - overLut[baseLut[value]])).toBeLessThanOrEqual(1);
    });
    expect(layerAdjust(base, over).sharpen).toBe(1);
  });

  it('keeps the balance untouched under a neutral shared adjust', () => {
    const base = { brightness: 17, contrast: -12, sharpen: 2 };
    expect(layerAdjust(base, { ...defaultAdjust(), sharpen: 2 })).toEqual(base);
  });
});
