import { describe, expect, it } from 'vitest';

import {
  baseSetMode,
  buildSequence,
  compositePass,
  dwellCycles,
  loopedSeriesPattern,
  passVisits,
  type SetLoop,
  buildSeriesSequence,
  compositeSequence,
  edgeDwell,
  formatPattern,
  leftDwell,
  loopPattern,
  MAX_CYCLES_PER_SET,
  MAX_LOOPS,
  MAX_PARALLAX_ZOOM,
  mosaicGrid,
  parallaxScale,
  parsePattern,
  seriesPattern,
  setDwellPattern,
  setPattern,
  withTransitions
} from '@/lib/sequence';

describe('loopPattern', () => {
  it('matches the server patterns for four frames', () => {
    expect(loopPattern(4, 'pingpong')).toEqual([0, 1, 2, 3, 2, 1]);
    expect(loopPattern(4, 'pingpong_hold')).toEqual([0, 0, 1, 2, 3, 3, 2, 1]);
    expect(loopPattern(4, 'forward')).toEqual([0, 1, 2, 3]);
    expect(loopPattern(4, 'backward')).toEqual([3, 2, 1, 0]);
    expect(loopPattern(4, 'ends')).toEqual([0, 3]);
    expect(loopPattern(4, 'middle')).toEqual([1, 2]);
    expect(loopPattern(4, 'custom', [0, 1, 3, 1])).toEqual([0, 1, 3, 1]);
  });

  it('falls back to ping-pong for an empty custom pattern', () => {
    expect(loopPattern(4, 'custom', null)).toEqual([0, 1, 2, 3, 2, 1]);
  });
});

describe('buildSequence', () => {
  it('repeats whole patterns to fill the duration', () => {
    expect(buildSequence(4, 'pingpong', 6, 1)).toEqual([0, 1, 2, 3, 2, 1]);
    expect(buildSequence(4, 'forward', 8, 1)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    const seq = buildSequence(4, 'pingpong', 10, 6);
    expect(seq.length % 6).toBe(0);
    expect(seq.length).toBeLessThanOrEqual(60);
  });
});

describe('series', () => {
  it('orders sets in turn or as ping-pong, one set collapsing to itself', () => {
    expect(setPattern(1, 'pingpong')).toEqual([0]);
    expect(setPattern(2, 'pingpong')).toEqual([0, 1]);
    expect(setPattern(3, 'pingpong')).toEqual([0, 1, 2, 1]);
    expect(setPattern(3, 'forward')).toEqual([0, 1, 2]);
  });

  it('dwells longer on the edge sets in the eased modes', () => {
    expect([0, 1, 2, 3, 4].map((k) => edgeDwell(k, 5, 4))).toEqual([4, 3, 1, 3, 4]);
    expect([0, 1, 2].map((k) => edgeDwell(k, 3, 3))).toEqual([3, 1, 3]);
    expect([0, 1].map((k) => edgeDwell(k, 2, 3))).toEqual([3, 3]);
    expect(setDwellPattern(3, 'pingpong_ease', 3)).toEqual([0, 0, 0, 1, 2, 2, 2, 1]);
    expect(setDwellPattern(3, 'forward_ease', 2)).toEqual([0, 0, 1, 2, 2]);
    expect(setDwellPattern(3, 'forward_ease', 1)).toEqual([0, 1, 2]);
    expect(setDwellPattern(3, 'pingpong', 2)).toEqual([0, 0, 1, 1, 2, 2, 1, 1]);
    expect([0, 1, 2, 3].map((k) => leftDwell(k, 4, 4))).toEqual([4, 3, 2, 1]);
    expect(setDwellPattern(4, 'swing', 4)).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 2, 2, 1, 1, 1]);
    expect(setDwellPattern(2, 'swing', 3)).toEqual([0, 0, 0, 1]);
  });

  it('runs the frame loop through all sets as one strip in sweep mode', () => {
    const strip = { framesPerSet: 4, setMode: 'sweep' as const, cyclesPerSet: 3 };
    expect(seriesPattern({ ...strip, setCount: 3, mode: 'pingpong' })).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
    ]);
    expect(seriesPattern({ ...strip, setCount: 3, mode: 'ends' })).toEqual([0, 11]);
    expect(seriesPattern({ ...strip, setCount: 2, mode: 'custom', custom: [0, 3] })).toEqual(
      seriesPattern({ ...strip, setCount: 2, mode: 'pingpong' })
    );

    expect(
      seriesPattern({
        setCount: 3,
        framesPerSet: 4,
        mode: 'ends',
        setMode: 'forward_ease',
        cyclesPerSet: 2
      })
    ).toEqual([0, 3, 0, 3, 4, 7, 8, 11, 8, 11]);
  });

  it('maps the frame loop of every set onto flat positions', () => {
    const shape = { framesPerSet: 4, mode: 'ends' as const, setMode: 'forward' as const };
    expect(seriesPattern({ ...shape, setCount: 2, cyclesPerSet: 1 })).toEqual([0, 3, 4, 7]);
    expect(seriesPattern({ ...shape, setCount: 3, cyclesPerSet: 1, setMode: 'pingpong' })).toEqual([
      0, 3, 4, 7, 8, 11, 7, 4
    ]);
    expect(seriesPattern({ ...shape, setCount: 2, cyclesPerSet: 2 })).toEqual([
      0, 3, 0, 3, 4, 7, 4, 7
    ]);
    expect(
      seriesPattern({ ...shape, setCount: 1, cyclesPerSet: 99, mode: 'pingpong' })
    ).toHaveLength(6 * MAX_CYCLES_PER_SET);
  });

  it('equals the plain sequence for a single set', () => {
    const shape = {
      setCount: 1,
      framesPerSet: 4,
      mode: 'pingpong' as const,
      setMode: 'pingpong' as const,
      cyclesPerSet: 1
    };
    expect(buildSeriesSequence(shape, 10, 6)).toEqual(buildSequence(4, 'pingpong', 10, 6));
    expect(buildSeriesSequence({ ...shape, setCount: 3 }, 10, 6)).toHaveLength(48);
    expect(buildSeriesSequence(shape, 10, 6, 2)).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1]);
    expect(buildSeriesSequence(shape, 10, 60, 1)).toHaveLength(6);
    expect(buildSeriesSequence(shape, 10, 1, 99)).toHaveLength(6 * MAX_LOOPS);
  });
});

describe('parsePattern', () => {
  it('accepts dashes, commas and spaces', () => {
    expect(parsePattern('1-2-3-4-4-3-2-1', 4)).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
    expect(parsePattern('1, 4 2', 4)).toEqual([0, 3, 1]);
  });

  it('rejects out-of-range, repeated-only and short patterns', () => {
    expect(parsePattern('1-5', 4)).toBeNull();
    expect(parsePattern('3-3', 4)).toBeNull();
    expect(parsePattern('2', 4)).toBeNull();
    expect(parsePattern('', 4)).toBeNull();
  });

  it('round-trips through formatPattern', () => {
    expect(formatPattern(parsePattern('1-4-1-2-3', 4)!)).toBe('1-4-1-2-3');
  });
});

describe('compositions', () => {
  const shape = {
    setCount: 2,
    framesPerSet: 4,
    mode: 'forward' as const,
    setMode: 'forward' as const,
    cyclesPerSet: 1
  };

  it('inserts blends only across set boundaries, including the loop seam', () => {
    const items = withTransitions([0, 1, 2, 3, 4, 5, 6, 7], 4, 2);
    expect(items).toHaveLength(12);
    expect(items[4]).toEqual({ a: 3, b: 4, t: 1 / 3 });
    expect(items[5]).toEqual({ a: 3, b: 4, t: 2 / 3 });
    expect(items[11]).toEqual({ a: 7, b: 0, t: 2 / 3 });
    expect(withTransitions([0, 1], 4, 3)).toEqual([
      { a: 0, b: null, t: 0 },
      { a: 1, b: null, t: 0 }
    ]);
  });

  it('builds a synchronised sequence over positions and a crossfade over frames', () => {
    const sync = compositeSequence(shape, 10, 1, {
      composition: 'mosaic',
      transitionFrames: 2,
      loops: 1
    });
    expect(sync).toEqual([0, 1, 2, 3].map((a) => ({ a, b: null, t: 0 })));
    const faded = compositeSequence(shape, 10, 1, {
      composition: 'crossfade',
      transitionFrames: 1,
      loops: 1
    });
    expect(faded).toHaveLength(10);
    const plain = compositeSequence(shape, 10, 1, {
      composition: 'single',
      transitionFrames: 5,
      loops: 1
    });
    expect(plain.map((item) => item.a)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('scales frames about the focus point with the lens position', () => {
    expect(parallaxScale(0, 4, 0.1)).toBe(1);
    expect(parallaxScale(3, 4, 0.1)).toBeCloseTo(1.1);
    expect(parallaxScale(1, 4, 0)).toBe(1);
    expect(parallaxScale(3, 4, 5)).toBeCloseTo(1 + MAX_PARALLAX_ZOOM);
    expect(mosaicGrid(3, false)).toEqual([2, 2]);
    expect(mosaicGrid(5, false)).toEqual([3, 2]);
    expect(mosaicGrid(3, true)).toEqual([3, 1]);
  });
});

describe('loops per set', () => {
  const loops: SetLoop[] = [
    { mode: 'ends', custom: null, cycles: 2 },
    { mode: 'custom', custom: [1, 2], cycles: 1 },
    { mode: 'forward', custom: null, cycles: 1 }
  ];

  it('plays each set with its own loop and repeats, like the render service', () => {
    expect(loopedSeriesPattern(4, 'forward', loops)).toEqual([0, 3, 0, 3, 5, 6, 8, 9, 10, 11]);
    expect(loopedSeriesPattern(4, 'pingpong', [loops[0], loops[1], loops[0]])).toEqual([
      0, 3, 0, 3, 5, 6, 8, 11, 8, 11, 6, 5
    ]);
    expect(loopedSeriesPattern(4, 'sweep', loops.slice(0, 2))).toEqual(loopPattern(8, 'ends'));
  });

  it('turns the old eased modes into repeat presets with the same result', () => {
    expect(dwellCycles('swing', 4)).toEqual([3, 2, 2, 1]);
    expect(dwellCycles('edges', 3)).toEqual([3, 1, 3]);
    expect(dwellCycles('even', 2)).toEqual([1, 1]);
    const swing = dwellCycles('swing', 4).map((cycles) => ({
      mode: 'pingpong' as const,
      custom: null,
      cycles
    }));
    expect(loopedSeriesPattern(4, baseSetMode('swing'), swing)).toEqual(
      seriesPattern({
        setCount: 4,
        framesPerSet: 4,
        mode: 'pingpong',
        setMode: 'swing',
        cyclesPerSet: 3
      })
    );
  });

  it('splits one pass into cells per set for the timeline', () => {
    const shape = {
      setCount: 2,
      framesPerSet: 4,
      mode: 'pingpong' as const,
      setMode: 'forward' as const,
      cyclesPerSet: 1,
      loops: loops.slice(0, 2)
    };
    const pass = compositePass(shape, 'single', 0);
    expect(passVisits(pass, 4, 2, 'forward', false)).toEqual([
      [{ cells: [0, 1, 2, 3], returning: false }],
      [{ cells: [4, 5], returning: false }]
    ]);
    const synced = compositePass(shape, 'mosaic', 0);
    expect(synced.map((item) => item.a)).toEqual([0, 3]);
    expect(passVisits(synced, 4, 2, 'forward', true)).toEqual([
      [{ cells: [0, 1], returning: false }],
      [{ cells: [0, 1], returning: false }]
    ]);
  });

  it('marks the way back of a set ping-pong and plays it in reverse', () => {
    const forward = (cycles: number): SetLoop => ({ mode: 'forward', custom: null, cycles });
    const shape = {
      setCount: 3,
      framesPerSet: 4,
      mode: 'forward' as const,
      setMode: 'pingpong' as const,
      cyclesPerSet: 1,
      loops: [forward(1), forward(1), forward(1)]
    };
    const pass = compositePass(shape, 'single', 0);
    expect(pass.map((item) => item.a)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 7, 6, 5, 4]);
    const visits = passVisits(pass, 4, 3, 'pingpong', false);
    expect(visits[1]).toEqual([
      { cells: [4, 5, 6, 7], returning: false },
      { cells: [12, 13, 14, 15], returning: true }
    ]);
    expect(visits[2]).toEqual([{ cells: [8, 9, 10, 11], returning: false }]);
  });
});

describe('set sizes other than four', () => {
  it('keeps the middle loop symmetric like the render service', () => {
    expect(loopPattern(2, 'middle')).toEqual([0, 1]);
    expect(loopPattern(3, 'middle')).toEqual([0, 2]);
    expect(loopPattern(4, 'middle')).toEqual([1, 2]);
    expect(loopPattern(5, 'middle')).toEqual([1, 3]);
    expect(loopPattern(5, 'pingpong')).toEqual([0, 1, 2, 3, 4, 3, 2, 1]);
    expect(parsePattern('1-5', 5)).toEqual([0, 4]);
    expect(parsePattern('1-5', 4)).toBeNull();
  });
});
