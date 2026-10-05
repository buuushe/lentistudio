import type { CropFraction } from '@/lib/geometry';

export type ScanMode = 1 | 2 | 3 | 4;
export type SplitCount = 2 | 3 | 4;
export type SplitAxis = 'x' | 'y';
export type BoxHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type EdgeSide = 'end' | 'start';
export type SplitScope = 'shared' | 'each';

export const SCAN_MODES: ScanMode[] = [1, 2, 3, 4];
const MIN_CELL_FRACTION = 0.02;
const MIN_BOX_FRACTION = 0.05;
const MAX_GAP_FRACTION = 0.2;

export interface ScanSplit {
  count: SplitCount;
  axis: SplitAxis;
  box: CropFraction;
  gap: number;
}

export interface ScanGeometry {
  axis: SplitAxis;
  box: CropFraction;
  gap: number;
}

export function cloneSplit(split: ScanSplit | null): ScanSplit | null {
  return split ? { ...split, box: { ...split.box } } : null;
}

export function scanGeometry(split: ScanSplit): ScanGeometry {
  return { axis: split.axis, box: { ...split.box }, gap: split.gap };
}

export function isSplitCount(value: number): value is SplitCount {
  return value === 2 || value === 3 || value === 4;
}

export function defaultSplit(count: SplitCount, axis: SplitAxis = 'x'): ScanSplit {
  return { count, axis, box: { x: 0.02, y: 0.04, w: 0.96, h: 0.92 }, gap: 0.01 };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

function alongOf(split: ScanSplit): number {
  return split.axis === 'x' ? split.box.w : split.box.h;
}

export function maxGapFor(split: ScanSplit): number {
  const along = alongOf(split);
  const room = (along - MIN_CELL_FRACTION * split.count) / (split.count - 1);
  return clamp(Math.min(room, MAX_GAP_FRACTION), 0, MAX_GAP_FRACTION);
}

export function normalizeSplit(split: ScanSplit): ScanSplit {
  const w = clamp(split.box.w, MIN_BOX_FRACTION, 1);
  const h = clamp(split.box.h, MIN_BOX_FRACTION, 1);
  const box = { x: clamp(split.box.x, 0, 1 - w), y: clamp(split.box.y, 0, 1 - h), w, h };
  const normalized = { ...split, box };
  return { ...normalized, gap: clamp(split.gap, 0, maxGapFor(normalized)) };
}

function cellSize(split: ScanSplit): number {
  return (alongOf(split) - split.gap * (split.count - 1)) / split.count;
}

export function splitFrames(split: ScanSplit): CropFraction[] {
  const cell = cellSize(split);
  const step = cell + split.gap;
  return Array.from({ length: split.count }, (_, k) =>
    split.axis === 'x'
      ? { x: split.box.x + k * step, y: split.box.y, w: cell, h: split.box.h }
      : { x: split.box.x, y: split.box.y + k * step, w: split.box.w, h: cell }
  );
}

export function movedSplit(split: ScanSplit, dx: number, dy: number): ScanSplit {
  return normalizeSplit({
    ...split,
    box: { ...split.box, x: split.box.x + dx, y: split.box.y + dy }
  });
}

export function resizedSplit(
  split: ScanSplit,
  handle: BoxHandle,
  pointer: { x: number; y: number }
): ScanSplit {
  const { x, y, w, h } = split.box;
  const px = clamp(pointer.x, 0, 1);
  const py = clamp(pointer.y, 0, 1);
  let left = x;
  let right = x + w;
  let top = y;
  let bottom = y + h;
  if (handle.includes('w')) left = Math.min(px, right - MIN_BOX_FRACTION);
  if (handle.includes('e')) right = Math.max(px, left + MIN_BOX_FRACTION);
  if (handle.includes('n')) top = Math.min(py, bottom - MIN_BOX_FRACTION);
  if (handle.includes('s')) bottom = Math.max(py, top + MIN_BOX_FRACTION);
  return normalizeSplit({
    ...split,
    box: { x: left, y: top, w: right - left, h: bottom - top }
  });
}

export function gapFromEdge(
  split: ScanSplit,
  divider: number,
  side: EdgeSide,
  pointerAlong: number
): ScanSplit {
  const start = split.axis === 'x' ? split.box.x : split.box.y;
  const along = alongOf(split);
  const n = split.count;
  const k = divider;
  const offset = clamp(pointerAlong, 0, 1) - start - ((k + 1) * along) / n;
  const factor = side === 'end' ? k - ((k + 1) * (n - 1)) / n : (k + 1) / n;
  return normalizeSplit({ ...split, gap: offset / factor });
}

export function dividerBands(split: ScanSplit): { from: number; to: number }[] {
  const frames = splitFrames(split);
  return frames.slice(0, -1).map((frame, k) => {
    const next = frames[k + 1];
    return split.axis === 'x'
      ? { from: frame.x + frame.w, to: next.x }
      : { from: frame.y + frame.h, to: next.y };
  });
}

export function framePixelSize(
  split: ScanSplit,
  scan: { width: number; height: number }
): { width: number; height: number } {
  const [first] = splitFrames(split);
  return { width: Math.floor(first.w * scan.width), height: Math.floor(first.h * scan.height) };
}
