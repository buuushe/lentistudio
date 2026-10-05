export const LOOP_MODES = [
  'pingpong',
  'pingpong_hold',
  'forward',
  'backward',
  'ends',
  'middle',
  'custom'
] as const;

export type LoopMode = (typeof LOOP_MODES)[number];

export const SET_MODES = [
  'forward',
  'pingpong',
  'forward_ease',
  'pingpong_ease',
  'swing',
  'sweep'
] as const;

export type SetLoopMode = (typeof SET_MODES)[number];

export const SWEEP_SET_MODE: SetLoopMode = 'sweep';

type DwellRule = (setIndex: number, setCount: number, maxCycles: number) => number;

export const MAX_CYCLES_PER_SET = 4;
export const MAX_LOOPS = 4;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const descendingInner = (n: number): number[] =>
  Array.from({ length: Math.max(0, n - 2) }, (_, i) => n - 2 - i);

function middlePair(n: number): number[] {
  if (n < 4) return [0, n - 1];
  const half = Math.floor(n / 2);
  return n % 2 ? [half - 1, half + 1] : [half - 1, half];
}

const builders: Record<Exclude<LoopMode, 'custom'>, (n: number) => number[]> = {
  pingpong: (n) => [...range(n), ...descendingInner(n)],
  pingpong_hold: (n) => [0, ...range(n), n - 1, ...descendingInner(n)],
  forward: (n) => range(n),
  backward: (n) => range(n).reverse(),
  ends: (n) => [0, n - 1],
  middle: (n) => middlePair(n)
};

export function parsePattern(text: string, frameCount: number): number[] | null {
  const numbers = text
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((value) => parseInt(value, 10) - 1);
  if (numbers.length < 2) return null;
  if (numbers.some((value) => value < 0 || value >= frameCount)) return null;
  if (new Set(numbers).size < 2) return null;
  return numbers;
}

export function formatPattern(pattern: number[]): string {
  return pattern.map((position) => position + 1).join('-');
}

export function loopPattern(
  frameCount: number,
  mode: LoopMode,
  custom?: number[] | null
): number[] {
  if (mode === 'custom') {
    return custom && custom.length ? custom : builders.pingpong(frameCount);
  }
  return builders[mode](frameCount);
}

const setBuilders: Record<SetLoopMode, (n: number) => number[]> = {
  forward: (n) => range(n),
  pingpong: (n) => [...range(n), ...descendingInner(n)],
  forward_ease: (n) => range(n),
  pingpong_ease: (n) => [...range(n), ...descendingInner(n)],
  swing: (n) => [...range(n), ...descendingInner(n)],
  sweep: (n) => range(n)
};

export function setPattern(setCount: number, mode: SetLoopMode): number[] {
  return setBuilders[mode](Math.max(1, setCount));
}

export function edgeDwell(setIndex: number, setCount: number, maxCycles: number): number {
  if (setCount < 2) return maxCycles;
  const edgeDistance = Math.min(setIndex, setCount - 1 - setIndex) / (setCount - 1);
  const weight = 0.5 + 0.5 * Math.cos(2 * Math.PI * edgeDistance);
  return 1 + Math.floor((maxCycles - 1) * weight + 0.5 + 1e-9);
}

export function leftDwell(setIndex: number, setCount: number, maxCycles: number): number {
  if (setCount < 2) return maxCycles;
  const weight = 1 - setIndex / (setCount - 1);
  return 1 + Math.floor((maxCycles - 1) * weight + 0.5 + 1e-9);
}

const SET_DWELL: Partial<Record<SetLoopMode, DwellRule>> = {
  forward_ease: edgeDwell,
  pingpong_ease: edgeDwell,
  swing: leftDwell
};

export function setDwellPattern(
  setCount: number,
  mode: SetLoopMode,
  cyclesPerSet: number
): number[] {
  const cycles = Math.min(MAX_CYCLES_PER_SET, Math.max(1, Math.round(cyclesPerSet)));
  const dwell = SET_DWELL[mode] ?? (() => cycles);
  return setPattern(setCount, mode).flatMap((setIndex) =>
    Array.from({ length: dwell(setIndex, Math.max(1, setCount), cycles) }, () => setIndex)
  );
}

export const TIMELINE_SET_MODES = [
  'forward',
  'pingpong',
  'sweep'
] as const satisfies readonly SetLoopMode[];

export interface SetLoop {
  mode: LoopMode;
  custom: number[] | null;
  cycles: number;
}

interface SeriesShape {
  setCount: number;
  framesPerSet: number;
  mode: LoopMode;
  custom?: number[] | null;
  setMode: SetLoopMode;
  cyclesPerSet: number;
  loops?: SetLoop[];
}

export function clampCycles(cycles: number): number {
  return Math.min(MAX_CYCLES_PER_SET, Math.max(1, Math.round(cycles)));
}

export function loopedSeriesPattern(
  framesPerSet: number,
  setMode: SetLoopMode,
  loops: SetLoop[]
): number[] {
  if (setMode === SWEEP_SET_MODE) {
    const first = loops[0];
    const stripMode = !first || first.mode === 'custom' ? 'pingpong' : first.mode;
    return loopPattern(loops.length * framesPerSet, stripMode);
  }
  const framePatterns = loops.map((loop) => loopPattern(framesPerSet, loop.mode, loop.custom));
  return setPattern(loops.length, setMode).flatMap((setIndex, visit) => {
    const returning = isReturnVisit(setMode, visit, loops.length);
    const frames = returning ? framePatterns[setIndex].slice().reverse() : framePatterns[setIndex];
    return Array.from({ length: clampCycles(loops[setIndex].cycles) }, () =>
      frames.map((frame) => setIndex * framesPerSet + frame)
    ).flat();
  });
}

const BOUNCING_SET_MODES: ReadonlySet<SetLoopMode> = new Set([
  'pingpong',
  'pingpong_ease',
  'swing'
]);

function isReturnVisit(setMode: SetLoopMode, visit: number, setCount: number): boolean {
  return BOUNCING_SET_MODES.has(setMode) && visit >= setCount;
}

export function seriesPattern(shape: SeriesShape): number[] {
  if (shape.loops) return loopedSeriesPattern(shape.framesPerSet, shape.setMode, shape.loops);
  if (shape.setMode === SWEEP_SET_MODE) {
    const stripMode = shape.mode === 'custom' ? 'pingpong' : shape.mode;
    return loopPattern(shape.setCount * shape.framesPerSet, stripMode);
  }
  const cycles = legacySetCycles(shape.setMode, shape.setCount, shape.cyclesPerSet);
  const loops = cycles.map((setCycles) => ({
    mode: shape.mode,
    custom: shape.custom ?? null,
    cycles: setCycles
  }));
  return loopedSeriesPattern(shape.framesPerSet, shape.setMode, loops);
}

export const DWELL_PRESETS = ['even', 'edges', 'swing'] as const;
export type DwellPreset = (typeof DWELL_PRESETS)[number];
const PRESET_MAX_CYCLES = 3;

export function dwellCycles(preset: DwellPreset, setCount: number): number[] {
  return Array.from({ length: setCount }, (_, setIndex) => {
    if (preset === 'edges') return edgeDwell(setIndex, setCount, PRESET_MAX_CYCLES);
    if (preset === 'swing') return leftDwell(setIndex, setCount, PRESET_MAX_CYCLES);
    return 1;
  });
}

export function legacySetCycles(
  mode: SetLoopMode,
  setCount: number,
  cyclesPerSet: number
): number[] {
  const cycles = clampCycles(cyclesPerSet);
  const dwell = SET_DWELL[mode];
  return Array.from({ length: setCount }, (_, setIndex) =>
    dwell ? dwell(setIndex, setCount, cycles) : cycles
  );
}

export function baseSetMode(mode: SetLoopMode): SetLoopMode {
  if (mode === 'forward_ease') return 'forward';
  if (mode === 'pingpong_ease' || mode === 'swing') return 'pingpong';
  return mode;
}

function repeatToFill<T>(
  pattern: T[],
  fps: number,
  duration: number,
  loops: number | null = null
): T[] {
  const total = Math.max(pattern.length, Math.round(fps * duration));
  const repeats =
    loops === null
      ? Math.max(1, Math.floor(total / pattern.length))
      : Math.min(MAX_LOOPS, Math.max(1, Math.round(loops)));
  return Array.from({ length: repeats }, () => pattern).flat();
}

export function buildSequence(
  frameCount: number,
  mode: LoopMode,
  fps: number,
  duration: number,
  custom?: number[] | null
): number[] {
  return repeatToFill(loopPattern(frameCount, mode, custom), fps, duration);
}

export function buildSeriesSequence(
  shape: SeriesShape,
  fps: number,
  duration: number,
  loops: number | null = null
): number[] {
  return repeatToFill(seriesPattern(shape), fps, duration, loops);
}

export const COMPOSITIONS = [
  'single',
  'crossfade',
  'double',
  'split',
  'mosaic',
  'triptych'
] as const;

export type Composition = (typeof COMPOSITIONS)[number];

const SYNC_COMPOSITIONS: ReadonlySet<Composition> = new Set([
  'double',
  'split',
  'mosaic',
  'triptych'
]);

export const MAX_TRANSITION_FRAMES = 8;
export const MAX_PARALLAX_ZOOM = 0.2;

export function isSyncComposition(composition: Composition): boolean {
  return SYNC_COMPOSITIONS.has(composition);
}

export interface Composite {
  a: number;
  b: number | null;
  t: number;
}

export function withTransitions(
  pattern: number[],
  framesPerSet: number,
  transitionFrames: number
): Composite[] {
  const steps = Math.min(MAX_TRANSITION_FRAMES, Math.max(0, Math.round(transitionFrames)));
  return pattern.flatMap((frame, k) => {
    const following = pattern[(k + 1) % pattern.length];
    const items: Composite[] = [{ a: frame, b: null, t: 0 }];
    if (steps && Math.floor(frame / framesPerSet) !== Math.floor(following / framesPerSet)) {
      for (let step = 1; step <= steps; step++) {
        items.push({ a: frame, b: following, t: step / (steps + 1) });
      }
    }
    return items;
  });
}

interface CompositionOptions {
  composition: Composition;
  transitionFrames: number;
  loops: number | null;
}

export function compositePass(
  shape: SeriesShape,
  composition: Composition,
  transitionFrames: number
): Composite[] {
  if (isSyncComposition(composition)) {
    const first = shape.loops?.[0];
    const pattern = first
      ? loopPattern(shape.framesPerSet, first.mode, first.custom)
      : loopPattern(shape.framesPerSet, shape.mode, shape.custom);
    return pattern.map((position) => ({ a: position, b: null, t: 0 }));
  }
  const transitions = composition === 'crossfade' ? transitionFrames : 0;
  return withTransitions(seriesPattern(shape), shape.framesPerSet, transitions);
}

export function compositeSequence(
  shape: SeriesShape,
  fps: number,
  duration: number,
  options: CompositionOptions
): Composite[] {
  const pass = compositePass(shape, options.composition, options.transitionFrames);
  return repeatToFill(pass, fps, duration, options.loops);
}

interface ClipVisit {
  cells: number[];
  returning: boolean;
}

export function passVisits(
  pass: Composite[],
  framesPerSet: number,
  setCount: number,
  setMode: SetLoopMode,
  synced: boolean
): ClipVisit[][] {
  const visits: ClipVisit[][] = Array.from({ length: setCount }, () => []);
  if (synced) {
    const all = pass.map((_, k) => k);
    visits.forEach((own) => own.push({ cells: all, returning: false }));
    return visits;
  }
  let currentSet = -1;
  let visitCount = -1;
  pass.forEach((item, k) => {
    const setIndex = Math.floor(item.a / framesPerSet);
    if (setIndex !== currentSet) {
      currentSet = setIndex;
      visitCount += 1;
      visits[setIndex]?.push({
        cells: [],
        returning: isReturnVisit(setMode, visitCount, setCount)
      });
    }
    visits[setIndex]?.at(-1)?.cells.push(k);
  });
  return visits;
}

export function parallaxScale(position: number, framesPerSet: number, zoom: number): number {
  const clamped = Math.min(MAX_PARALLAX_ZOOM, Math.max(0, zoom));
  if (framesPerSet < 2 || clamped === 0) return 1;
  return 1 + (clamped * position) / (framesPerSet - 1);
}

export function mosaicGrid(setCount: number, singleRow: boolean): [number, number] {
  if (singleRow) return [setCount, 1];
  const cols = Math.ceil(Math.sqrt(setCount));
  return [cols, Math.ceil(setCount / cols)];
}
