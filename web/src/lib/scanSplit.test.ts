import { describe, expect, it } from 'vitest';

import {
  defaultSplit,
  dividerBands,
  framePixelSize,
  gapFromEdge,
  maxGapFor,
  movedSplit,
  normalizeSplit,
  resizedSplit,
  splitFrames,
  type ScanSplit
} from '@/lib/scanSplit';

const full: ScanSplit = { count: 4, axis: 'x', box: { x: 0, y: 0, w: 1, h: 1 }, gap: 0 };

describe('splitFrames', () => {
  it('cuts the box into equal cells separated by the gap', () => {
    const frames = splitFrames({ ...full, box: { x: 0.1, y: 0.2, w: 0.8, h: 0.6 }, gap: 0.02 });
    expect(frames).toHaveLength(4);
    const widths = new Set(frames.map((f) => f.w.toFixed(6)));
    expect(widths.size).toBe(1);
    expect(frames.every((f) => f.y === 0.2 && f.h === 0.6)).toBe(true);
    expect(frames[1].x - (frames[0].x + frames[0].w)).toBeCloseTo(0.02);
    expect(frames[3].x + frames[3].w).toBeCloseTo(0.9);
  });

  it('stacks cells along y when the axis is vertical', () => {
    const frames = splitFrames({ ...full, count: 2, axis: 'y' });
    expect(frames.map((f) => f.y)).toEqual([0, 0.5]);
    expect(frames.every((f) => f.w === 1 && f.h === 0.5)).toBe(true);
  });

  it('cuts three equal cells that fill the box', () => {
    const frames = splitFrames({ ...full, count: 3, gap: 0.03 });
    expect(frames).toHaveLength(3);
    expect(new Set(frames.map((f) => f.w.toFixed(6))).size).toBe(1);
    expect(frames[2].x + frames[2].w).toBeCloseTo(1);
  });
});

describe('normalizeSplit', () => {
  it('keeps the box inside the scan and the gap within room', () => {
    const fixed = normalizeSplit({ ...full, box: { x: 0.5, y: -0.2, w: 0.8, h: 1.5 }, gap: 0.9 });
    expect(fixed.box.x).toBeCloseTo(0.2);
    expect([fixed.box.y, fixed.box.w, fixed.box.h]).toEqual([0, 0.8, 1]);
    expect(fixed.gap).toBeCloseTo(maxGapFor(fixed));
    expect(splitFrames(fixed)[0].w).toBeGreaterThan(0);
  });
});

describe('interaction helpers', () => {
  it('moves the whole group and clamps at the border', () => {
    const start = defaultSplit(4);
    const moved = movedSplit(start, 0.5, 0);
    expect(moved.box.x).toBeCloseTo(1 - start.box.w);
    expect(moved.box.w).toBe(start.box.w);
  });

  it('resizes from a corner keeping the opposite corner fixed', () => {
    const start = { ...full, box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } };
    const resized = resizedSplit(start, 'nw', { x: 0.3, y: 0.2 });
    expect(resized.box.x).toBeCloseTo(0.3);
    expect(resized.box.y).toBeCloseTo(0.2);
    expect(resized.box.w).toBeCloseTo(0.6);
    expect(resized.box.h).toBeCloseTo(0.7);
    const edge = resizedSplit(start, 'e', { x: 0.5, y: 0.9 });
    expect(edge.box.w).toBeCloseTo(0.4);
    expect(edge.box.x + edge.box.w).toBeCloseTo(0.5);
  });

  it('derives the gap so the dragged inner edge lands under the pointer', () => {
    const start = { ...full, gap: 0.02 };
    for (const divider of [0, 1, 2]) {
      const pointer = dividerBands(start)[divider].to + 0.01;
      const next = gapFromEdge(start, divider, 'start', pointer);
      expect(dividerBands(next)[divider].to).toBeCloseTo(pointer);
      const endPointer = dividerBands(start)[divider].from - 0.01;
      const shrunk = gapFromEdge(start, divider, 'end', endPointer);
      expect(dividerBands(shrunk)[divider].from).toBeCloseTo(endPointer);
    }
  });

  it('works for two cells where the divider centre never moves', () => {
    const start: ScanSplit = { ...full, count: 2 };
    const next = gapFromEdge(start, 0, 'start', 0.55);
    expect(dividerBands(next)[0]).toEqual({
      from: expect.closeTo(0.45, 5),
      to: expect.closeTo(0.55, 5)
    });
  });

  it('reports the pixel size of one frame', () => {
    expect(framePixelSize({ ...full, gap: 0 }, { width: 4000, height: 1000 })).toEqual({
      width: 1000,
      height: 1000
    });
  });
});
