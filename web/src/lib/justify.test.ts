import { describe, expect, it } from 'vitest';

import { justifyRows, targetRowHeight } from '@/lib/justify';

const item = (id: string, ratio: number) => ({ id, ratio });

describe('justifyRows', () => {
  it('fills every full row to the container width', () => {
    const rows = justifyRows(
      [item('a', 0.8), item('b', 1), item('c', 1.78), item('d', 0.8), item('e', 0.56)],
      1000,
      300,
      4
    );
    expect(rows.length).toBeGreaterThan(1);
    rows.slice(0, -1).forEach((row) => {
      const width =
        row.cells.reduce((sum, cell) => sum + cell.width, 0) + 4 * (row.cells.length - 1);
      expect(width).toBe(1000);
      expect(row.height).toBeLessThanOrEqual(300);
    });
  });

  it('never stretches the last row above the target height', () => {
    const rows = justifyRows([item('a', 0.8)], 1000, 300, 4);
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBe(300);
    expect(rows[0].cells[0].width).toBe(240);
  });

  it('keeps extreme ratios within bounds and survives garbage', () => {
    const rows = justifyRows([item('a', 0), item('b', 40), item('c', Number.NaN)], 1000, 300, 0);
    const widths = rows.flatMap((row) => row.cells.map((cell) => cell.width));
    expect(widths.every((w) => w > 0)).toBe(true);
  });

  it('returns nothing for an empty container', () => {
    expect(justifyRows([item('a', 1)], 0, 300, 4)).toEqual([]);
  });

  it('scales the row height with the viewport within limits', () => {
    expect(targetRowHeight(400)).toBe(200);
    expect(targetRowHeight(1500)).toBe(300);
    expect(targetRowHeight(4000)).toBe(360);
  });
});
