import { describe, expect, it } from 'vitest';

import {
  anchorFromCropCenter,
  computeAlignment,
  computeLayout,
  cropFromFraction,
  fractionFromCrop,
  normalizeFraction,
  fitAspect,
  focusTargets,
  shiftedAnchor,
  type FrameSize,
  type Point,
  type Size
} from '@/lib/geometry';

const W = 400;
const H = 300;
const BASE: Point = { x: 200, y: 150 };
const SHIFTS: [number, number][] = [
  [-30, 4],
  [-10, -3],
  [12, 5],
  [28, -6]
];

const sizes: Size[] = SHIFTS.map(() => [W, H]);
const points: Point[] = SHIFTS.map(([dx, dy]) => ({ x: BASE.x + dx, y: BASE.y + dy }));
const frames: FrameSize[] = SHIFTS.map((_, index) => ({ index, width: W, height: H }));

describe('computeAlignment', () => {
  it('keeps the focus point fixed and yields even dimensions', () => {
    const alignment = computeAlignment(sizes, points);
    expect(alignment).not.toBeNull();
    const { offsets, crop, target } = alignment!;
    expect(crop[2] % 2).toBe(0);
    expect(crop[3] % 2).toBe(0);
    offsets.forEach((offset, i) => {
      expect(points[i].x + offset.x).toBeCloseTo(target.x, 6);
      expect(points[i].y + offset.y).toBeCloseTo(target.y, 6);
    });
    const spread = Math.max(...SHIFTS.map((s) => s[0])) - Math.min(...SHIFTS.map((s) => s[0]));
    expect(crop[2]).toBeLessThanOrEqual(W - spread);
  });

  it('returns null when frames do not overlap', () => {
    const farPoints: Point[] = [
      { x: 0, y: 0 },
      { x: 399, y: 299 },
      { x: 0, y: 299 },
      { x: 399, y: 0 }
    ];
    expect(computeAlignment(sizes, farPoints)).toBeNull();
  });
});

describe('fitAspect', () => {
  const crop = [10, 20, 300, 200] as const;

  it.each([
    [0, 0],
    [1000, 1000],
    [160, 120]
  ])('stays inside the common area for anchor (%i, %i)', (ax, ay) => {
    const rect = fitAspect(crop, 4 / 5, { x: ax, y: ay });
    expect(rect).not.toBeNull();
    const [x, y, w, h] = rect!;
    expect(x).toBeGreaterThanOrEqual(10);
    expect(y).toBeGreaterThanOrEqual(20);
    expect(x + w).toBeLessThanOrEqual(310);
    expect(y + h).toBeLessThanOrEqual(220);
    expect(Math.abs(w / h - 0.8)).toBeLessThan(0.02);
  });

  it('returns the crop untouched without an aspect', () => {
    expect(fitAspect(crop, null)).toBe(crop);
  });
});

describe('computeLayout', () => {
  it('produces the exact preset output and a crop centred on the focus point', () => {
    const layout = computeLayout(frames, points, {
      preset: 'ig_portrait',
      maxWidth: null,
      anchor: null
    });
    expect(layout).not.toBeNull();
    expect(layout!.out).toEqual([1080, 1350]);
    expect(layout!.hasPreset).toBe(true);
    const [cx, cy, cw, ch] = layout!.crop;
    expect(Math.abs(cw / ch - 1080 / 1350)).toBeLessThan(0.02);
    const anchor = anchorFromCropCenter(layout!.alignment.crop, layout!.crop);
    expect(anchor.x).toBeGreaterThan(0);
    expect(anchor.x).toBeLessThan(1);
    expect(cx).toBeGreaterThanOrEqual(layout!.alignment.crop[0]);
    expect(cy).toBeGreaterThanOrEqual(layout!.alignment.crop[1]);
  });

  it('scales the free output down to maxWidth with even sizes', () => {
    const layout = computeLayout(frames, points, { preset: 'free', maxWidth: 100, anchor: null });
    expect(layout!.hasPreset).toBe(false);
    expect(layout!.out[0]).toBe(100);
    expect(layout!.out[1] % 2).toBe(0);
  });

  it('moves the crop when the anchor shifts and reports the new anchor', () => {
    const settings = { preset: 'ig_square' as const, maxWidth: null, anchor: null };
    const base = computeLayout(frames, points, settings)!;
    const shifted = computeLayout(frames, points, {
      ...settings,
      anchor: shiftedAnchor(base, 20, 0)
    })!;
    expect(shifted.crop[0]).toBeGreaterThan(base.crop[0]);
    expect(shifted.crop[1]).toBe(base.crop[1]);
  });

  it('returns null until every frame has a point', () => {
    expect(
      computeLayout(frames, [points[0], undefined, points[2], points[3]], {
        preset: 'free',
        maxWidth: null,
        anchor: null
      })
    ).toBeNull();
  });
});

describe('focus grouping', () => {
  const sizes: Size[] = Array.from({ length: 8 }, () => [400, 300] as const);
  const first = [
    { x: 170, y: 154 },
    { x: 190, y: 147 },
    { x: 212, y: 155 },
    { x: 228, y: 144 }
  ];
  const second = first.map((p) => ({ x: p.x + 100, y: p.y }));

  it('shares one target across sets by default', () => {
    const shared = computeAlignment(sizes, [...first, ...second], { framesPerSet: 4 })!;
    expect(shared.targets.every((t) => t.x === shared.target.x)).toBe(true);
    expect(shared.offsets[4].x - shared.offsets[0].x).toBeCloseTo(-100);
  });

  it('keeps the framing between sets when the focus is not shared', () => {
    const separate = computeAlignment(sizes, [...first, ...second], {
      framesPerSet: 4,
      sharedFocus: false
    })!;
    expect(separate.targets[4].x - separate.targets[0].x).toBeCloseTo(100);
    for (let k = 0; k < 4; k++) {
      expect(separate.offsets[k]).toEqual(separate.offsets[k + 4]);
    }
    expect(separate.target.x).toBeCloseTo((separate.targets[0].x + separate.targets[4].x) / 2);
    expect(focusTargets(first, { framesPerSet: 3, sharedFocus: false })).toHaveLength(4);
    expect(new Set(focusTargets(first, { framesPerSet: 3, sharedFocus: false })).size).toBe(1);
  });
});

describe('custom crop fractions', () => {
  it('maps fractions to an even rectangle inside the area and back', () => {
    const area = [10, 20, 401, 301] as const;
    expect(cropFromFraction(area, { x: 0, y: 0, w: 1, h: 1 })).toEqual([10, 20, 400, 300]);
    const crop = cropFromFraction(area, { x: 0.5, y: 0.5, w: 0.25, h: 0.25 });
    expect(crop[2]).toBe(100);
    expect(crop[0] + crop[2]).toBeLessThanOrEqual(411);
    const back = fractionFromCrop(area, crop);
    expect(back.w).toBeCloseTo(100 / 401, 5);
    expect(normalizeFraction({ x: 0.9, y: -1, w: 0.5, h: 3 })).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1
    });
  });
});
