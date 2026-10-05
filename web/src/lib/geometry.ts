export interface Point {
  x: number;
  y: number;
}

export type Size = readonly [width: number, height: number];
export type Rect = readonly [x: number, y: number, width: number, height: number];

export const SET_SIZES = [2, 3, 4, 5] as const;
export type SetSize = (typeof SET_SIZES)[number];
export const DEFAULT_SET_SIZE: SetSize = 4;

export function isSetSize(value: unknown): value is SetSize {
  return typeof value === 'number' && (SET_SIZES as readonly number[]).includes(value);
}

export const PRESETS = {
  free: null,
  ig_portrait: [1080, 1350],
  ig_square: [1080, 1080],
  ig_story: [1080, 1920],
  ig_landscape: [1080, 566],
  custom: null
} as const satisfies Record<string, Size | null>;

export interface CropFraction {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_CROP_FRACTION = 0.05;

const clamp01 = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function normalizeFraction(fraction: CropFraction): CropFraction {
  const w = clamp01(fraction.w, MIN_CROP_FRACTION, 1);
  const h = clamp01(fraction.h, MIN_CROP_FRACTION, 1);
  return { x: clamp01(fraction.x, 0, 1 - w), y: clamp01(fraction.y, 0, 1 - h), w, h };
}

export function cropFromFraction(area: Rect, fraction: CropFraction): Rect {
  const [bx, by, bw, bh] = area;
  const nw = Math.min(
    evenFloor(bw),
    Math.max(2, evenFloor(Math.round(bw * Math.max(fraction.w, MIN_CROP_FRACTION))))
  );
  const nh = Math.min(
    evenFloor(bh),
    Math.max(2, evenFloor(Math.round(bh * Math.max(fraction.h, MIN_CROP_FRACTION))))
  );
  const nx = Math.min(Math.max(Math.round(bx + bw * fraction.x), bx), bx + bw - nw);
  const ny = Math.min(Math.max(Math.round(by + bh * fraction.y), by), by + bh - nh);
  return [nx, ny, nw, nh];
}

export function fractionFromCrop(area: Rect, crop: Rect): CropFraction {
  const [bx, by, bw, bh] = area;
  const [cx, cy, cw, ch] = crop;
  return normalizeFraction({ x: (cx - bx) / bw, y: (cy - by) / bh, w: cw / bw, h: ch / bh });
}

export type Preset = keyof typeof PRESETS;

function presetSize(preset: Preset): Size | null {
  return PRESETS[preset];
}

function evenFloor(value: number): number {
  return value % 2 === 0 ? value : value - 1;
}

export interface Alignment {
  offsets: Point[];
  crop: Rect;
  target: Point;
  targets: Point[];
}

interface FocusGrouping {
  framesPerSet?: number;
  sharedFocus?: boolean;
}

function meanPoint(points: Point[]): Point {
  const n = points.length;
  return points.reduce<Point>((acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n }), {
    x: 0,
    y: 0
  });
}

export function focusTargets(points: Point[], grouping: FocusGrouping = {}): Point[] {
  const size = grouping.framesPerSet ?? 0;
  const separate = grouping.sharedFocus === false && size > 0 && points.length % size === 0;
  if (!separate) {
    const shared = meanPoint(points);
    return points.map(() => shared);
  }
  return points.map((_, index) => {
    const start = Math.floor(index / size) * size;
    return meanPoint(points.slice(start, start + size));
  });
}

export function computeAlignment(
  sizes: Size[],
  points: Point[],
  grouping: FocusGrouping = {}
): Alignment | null {
  const n = points.length;
  if (n < 2 || sizes.length !== n) return null;
  const targets = focusTargets(points, grouping);
  const distinct = targets.filter(
    (t, index) => targets.findIndex((other) => other.x === t.x && other.y === t.y) === index
  );
  const target = meanPoint(distinct);
  const offsets = points.map((p, index) => ({
    x: targets[index].x - p.x,
    y: targets[index].y - p.y
  }));
  let x0 = -Infinity;
  let y0 = -Infinity;
  let x1 = Infinity;
  let y1 = Infinity;
  offsets.forEach((offset, i) => {
    x0 = Math.max(x0, Math.ceil(offset.x));
    y0 = Math.max(y0, Math.ceil(offset.y));
    x1 = Math.min(x1, Math.floor(offset.x + sizes[i][0]));
    y1 = Math.min(y1, Math.floor(offset.y + sizes[i][1]));
  });
  const width = evenFloor(Math.trunc(x1 - x0));
  const height = evenFloor(Math.trunc(y1 - y0));
  if (width < 2 || height < 2) return null;
  return { offsets, crop: [x0, y0, width, height], target, targets };
}

export function fitAspect(crop: Rect, aspect: number | null, anchor?: Point | null): Rect | null {
  const [cx, cy, cw, ch] = crop;
  if (aspect == null) return crop;
  let nw: number;
  let nh: number;
  if (cw / ch > aspect) {
    nh = ch;
    nw = evenFloor(Math.trunc(ch * aspect));
  } else {
    nw = cw;
    nh = evenFloor(Math.trunc(cw / aspect));
  }
  if (nw < 2 || nh < 2) return null;
  const ax = anchor ? anchor.x : cx + cw / 2;
  const ay = anchor ? anchor.y : cy + ch / 2;
  const nx = Math.min(Math.max(Math.round(ax - nw / 2), cx), cx + cw - nw);
  const ny = Math.min(Math.max(Math.round(ay - nh / 2), cy), cy + ch - nh);
  return [nx, ny, nw, nh];
}

export interface FrameSize {
  index: number;
  width: number;
  height: number;
}

interface LayoutSettings extends FocusGrouping {
  preset: Preset;
  maxWidth: number | null;
  anchor: Point | null;
  customCrop?: CropFraction | null;
}

export interface Layout {
  ordered: FrameSize[];
  alignment: Alignment;
  crop: Rect;
  out: Size;
  hasPreset: boolean;
}

function anchorToAbsolute(commonArea: Rect, anchor: Point): Point {
  const [bx, by, bw, bh] = commonArea;
  return { x: bx + bw * anchor.x, y: by + bh * anchor.y };
}

export function anchorFromCropCenter(commonArea: Rect, crop: Rect): Point {
  const [bx, by, bw, bh] = commonArea;
  const [cx, cy, cw, ch] = crop;
  return { x: (cx + cw / 2 - bx) / bw, y: (cy + ch / 2 - by) / bh };
}

export function shiftedAnchor(layout: Layout, dx: number, dy: number): Point {
  const [bx, by, bw, bh] = layout.alignment.crop;
  const [cx, cy, cw, ch] = layout.crop;
  return { x: (cx + cw / 2 + dx - bx) / bw, y: (cy + ch / 2 + dy - by) / bh };
}

function outputForFree(crop: Rect, maxWidth: number | null): Size {
  const [, , cw, ch] = crop;
  if (maxWidth && cw > maxWidth) {
    const k = maxWidth / cw;
    return [evenFloor(Math.max(2, Math.round(cw * k))), evenFloor(Math.max(2, Math.round(ch * k)))];
  }
  return [cw, ch];
}

export function computeLayout(
  ordered: FrameSize[],
  points: (Point | undefined)[],
  settings: LayoutSettings
): Layout | null {
  if (ordered.length < 2 || points.length !== ordered.length || points.some((p) => !p)) {
    return null;
  }

  const alignment = computeAlignment(
    ordered.map((f) => [f.width, f.height] as const),
    points as Point[],
    { framesPerSet: settings.framesPerSet, sharedFocus: settings.sharedFocus }
  );

  if (!alignment) return null;
  if (settings.preset === 'custom') {
    const crop = settings.customCrop
      ? cropFromFraction(alignment.crop, settings.customCrop)
      : alignment.crop;
    return {
      ordered,
      alignment,
      crop,
      out: outputForFree(crop, settings.maxWidth),
      hasPreset: true
    };
  }
  const target = presetSize(settings.preset);
  if (!target) {
    return {
      ordered,
      alignment,
      crop: alignment.crop,
      out: outputForFree(alignment.crop, settings.maxWidth),
      hasPreset: false
    };
  }
  const anchor = settings.anchor
    ? anchorToAbsolute(alignment.crop, settings.anchor)
    : alignment.target;
  const crop = fitAspect(alignment.crop, target[0] / target[1], anchor);
  if (!crop) return null;
  return { ordered, alignment, crop, out: target, hasPreset: true };
}
