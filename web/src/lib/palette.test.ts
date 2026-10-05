import { describe, expect, it } from 'vitest';

import {
  groupSimilar,
  meanSignature,
  orderContrast,
  orderSimilar,
  signatureDistance
} from '@/lib/palette';

const warm = [80, 150, 160];
const warmer = [82, 152, 158];
const cool = [60, 110, 90];
const cooler = [58, 108, 88];

describe('palette ordering', () => {
  it('averages signatures and measures distance', () => {
    expect(
      meanSignature([
        [0, 2],
        [4, 6]
      ])
    ).toEqual([2, 4]);
    expect(signatureDistance([0, 0], [3, 4])).toBe(5);
    expect(meanSignature([])).toEqual([]);
  });

  it('puts similar palettes next to each other', () => {
    const order = orderSimilar([warm, cool, warmer, cooler]);
    const pairs = order.slice(1).map((k, i) => [order[i], k]);
    expect(pairs).toContainEqual(expect.arrayContaining([0, 2]));
    expect(pairs).toContainEqual(expect.arrayContaining([1, 3]));
    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4);
  });

  it('alternates palettes so that neighbours differ', () => {
    const order = orderContrast([warm, warmer, cool, cooler]);
    const groupOf = (k: number) => (k < 2 ? 'warm' : 'cool');
    for (let i = 1; i < order.length; i++) {
      expect(groupOf(order[i])).not.toBe(groupOf(order[i - 1]));
    }
    expect(orderContrast([warm])).toEqual([0]);
    expect(orderSimilar([])).toEqual([]);
  });
});

describe('groupSimilar', () => {
  it('collects the nearest frames into groups and keeps library order inside a group', () => {
    const sceneA = [1, 0, 0];
    const sceneB = [0, 1, 0];
    const features = [sceneA, sceneB, sceneA, sceneB, sceneA, sceneB, sceneA, sceneB];
    expect(groupSimilar(features, 4)).toEqual([
      [0, 2, 4, 6],
      [1, 3, 5, 7]
    ]);
  });

  it('leaves frames that do not fill a group unassigned', () => {
    const features = Array.from({ length: 9 }, (_, k) => [k]);
    expect(groupSimilar(features, 4)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7]
    ]);
  });
});
