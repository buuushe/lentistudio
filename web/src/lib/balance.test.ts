import { describe, expect, it } from 'vitest';

import { balanceAdjustments, unevenPositions } from '@/lib/balance';

describe('balanceAdjustments', () => {
  it('lifts a darker frame towards the others and leaves matching frames alone', () => {
    const tones = [
      { mean: 120, std: 50 },
      { mean: 121, std: 51 },
      { mean: 95, std: 50 },
      { mean: 120, std: 49 }
    ];
    const adjusts = balanceAdjustments(tones, 1);
    expect(adjusts[0]).toEqual({ brightness: 0, contrast: 0, sharpen: 1 });
    expect(adjusts[2].brightness).toBeGreaterThan(15);
    expect(adjusts[2].contrast).toBe(0);
    expect(unevenPositions(adjusts)).toEqual([2]);
  });

  it('reduces contrast of a frame with a wider spread and ignores tiny differences', () => {
    const tones = [
      { mean: 128, std: 40 },
      { mean: 128, std: 40 },
      { mean: 128, std: 60 },
      { mean: 129, std: 41 }
    ];
    const adjusts = balanceAdjustments(tones);
    expect(adjusts[2].contrast).toBeLessThan(-25);
    expect(adjusts[3]).toEqual({ brightness: 0, contrast: 0, sharpen: 0 });
    expect(unevenPositions(adjusts)).toEqual([2]);
  });
});
