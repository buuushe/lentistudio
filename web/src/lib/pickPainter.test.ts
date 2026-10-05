import { describe, expect, it } from 'vitest';

import { clampToFrame, LOUPE_SIZE, loupePosition, pointerToImage } from '@/lib/pickPainter';

describe('pointerToImage', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 } as DOMRect;

  it('maps client coordinates to image pixels', () => {
    expect(pointerToImage({ clientX: 200, clientY: 100 }, rect, 800, 400)).toEqual({
      x: 400,
      y: 200
    });
  });

  it('clamps outside the frame', () => {
    expect(pointerToImage({ clientX: 0, clientY: 0 }, rect, 800, 400)).toEqual({ x: 0, y: 0 });
    expect(pointerToImage({ clientX: 999, clientY: 999 }, rect, 800, 400)).toEqual({
      x: 799,
      y: 399
    });
    expect(clampToFrame({ x: -5, y: 1000 }, 10, 10)).toEqual({ x: 0, y: 9 });
  });
});

describe('loupePosition', () => {
  it('keeps the loupe inside the host', () => {
    const host = { width: 400, height: 300 };
    expect(loupePosition({ x: 50, y: 200 }, host)).toEqual({
      left: 74,
      top: 200 - LOUPE_SIZE - 24
    });
    expect(loupePosition({ x: 390, y: 200 }, host).left).toBe(390 - LOUPE_SIZE - 24);
    expect(loupePosition({ x: 50, y: 10 }, host).top).toBe(34);
  });
});

describe('regionAround', () => {
  it('returns the whole frame without a point or zoom and clamps a zoomed region inside', async () => {
    const { regionAround } = await import('@/lib/pickPainter');
    expect(regionAround(undefined, 600, 400, 2.5)).toEqual({ sx: 0, sy: 0, sw: 600, sh: 400 });
    expect(regionAround({ x: 300, y: 200 }, 600, 400, 2)).toEqual({
      sx: 150,
      sy: 100,
      sw: 300,
      sh: 200
    });
    expect(regionAround({ x: 10, y: 390 }, 600, 400, 2)).toEqual({
      sx: 0,
      sy: 200,
      sw: 300,
      sh: 200
    });
    expect(regionAround({ x: 200, y: 450 }, 400, 600, 2, true)).toEqual({
      sx: 100,
      sy: 350,
      sw: 200,
      sh: 200
    });
  });
});
