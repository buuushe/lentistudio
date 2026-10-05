export interface Adjust {
  brightness: number;
  contrast: number;
  sharpen: number;
}

export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export const SHARPEN_STRENGTH = 0.25;
export const SHARPEN_MAX = 3;
export const ADJUST_RANGE = 100;
export const BRIGHTNESS_SCALE = 1.27;

export const defaultAdjust = (): Adjust => ({ brightness: 0, contrast: 0, sharpen: 0 });

export const isIdentityAdjust = (a: Adjust): boolean =>
  a.brightness === 0 && a.contrast === 0 && a.sharpen === 0;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export function layerAdjust(base: Adjust, over: Adjust): Adjust {
  const overFactor = 1 + over.contrast / 100;
  const factor = (1 + base.contrast / 100) * overFactor;
  return {
    brightness: clamp(base.brightness * overFactor + over.brightness, -ADJUST_RANGE, ADJUST_RANGE),
    contrast: clamp((factor - 1) * 100, -ADJUST_RANGE, ADJUST_RANGE),
    sharpen: over.sharpen
  };
}

export function buildToneLut(adj: Adjust): Uint8ClampedArray {
  const k = 1 + clamp(adj.contrast, -ADJUST_RANGE, ADJUST_RANGE) / 100;
  const b = clamp(adj.brightness, -ADJUST_RANGE, ADJUST_RANGE) * BRIGHTNESS_SCALE;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = (i - 128) * k + 128 + b;
  return lut;
}

function applyTone(data: Uint8ClampedArray, adj: Adjust): void {
  if (adj.brightness === 0 && adj.contrast === 0) return;
  const lut = buildToneLut(adj);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
}

function sharpenPass(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number): void {
  const s = SHARPEN_STRENGTH;
  const c = 1 + 4 * s;
  for (let y = 0; y < h; y++) {
    const rowUp = Math.max(0, y - 1) * w;
    const rowDown = Math.min(h - 1, y + 1) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const left = Math.max(0, x - 1);
      const right = Math.min(w - 1, x + 1);
      const o = (row + x) * 4;
      const u = (rowUp + x) * 4;
      const d = (rowDown + x) * 4;
      const l = (row + left) * 4;
      const r = (row + right) * 4;
      dst[o] = c * src[o] - s * (src[u] + src[d] + src[l] + src[r]);
      dst[o + 1] = c * src[o + 1] - s * (src[u + 1] + src[d + 1] + src[l + 1] + src[r + 1]);
      dst[o + 2] = c * src[o + 2] - s * (src[u + 2] + src[d + 2] + src[l + 2] + src[r + 2]);
      dst[o + 3] = 255;
    }
  }
}

export function applyAdjust<T extends PixelBuffer>(image: T, adj: Adjust): T {
  const { data, width, height } = image;
  applyTone(data, adj);
  const passes = clamp(Math.trunc(adj.sharpen), 0, SHARPEN_MAX);
  if (passes === 0) return image;
  let src = data;
  let dst = new Uint8ClampedArray(data.length);
  for (let pass = 0; pass < passes; pass++) {
    sharpenPass(src, dst, width, height);
    [src, dst] = [dst, src];
  }
  if (src !== data) data.set(src);
  return image;
}
