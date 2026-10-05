import type { FrameBuffer } from '@/lib/frameBuffers';
import type { Layout } from '@/lib/geometry';
import {
  isSyncComposition,
  mosaicGrid,
  parallaxScale,
  type Composite,
  type Composition
} from '@/lib/sequence';

const PREVIEW_MAX_SIDE = 900;

interface PreviewColors {
  accent: string;
  placeholderBackground: string;
  placeholderText: string;
}

interface CompositeStyle {
  composition: Composition;
  framesPerSet: number;
  parallaxZoom: number;
}

type Rect = [number, number, number, number];

export function previewCanvasSize(layout: Layout): [number, number] {
  const [, , bw, bh] = layout.alignment.crop;
  const k = Math.min(1, PREVIEW_MAX_SIDE / Math.max(bw, bh));
  return [Math.max(2, Math.round(bw * k)), Math.max(2, Math.round(bh * k))];
}

function paintCropMask(ctx: CanvasRenderingContext2D, rect: Rect, W: number, H: number): void {
  const [rx, ry, rw, rh] = rect;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, W, ry);
  ctx.fillRect(0, ry + rh, W, H - ry - rh);
  ctx.fillRect(0, ry, rx, rh);
  ctx.fillRect(rx + rw, ry, W - rx - rw, rh);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(rx + (rw * i) / 3, ry);
    ctx.lineTo(rx + (rw * i) / 3, ry + rh);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx, ry + (rh * i) / 3);
    ctx.lineTo(rx + rw, ry + (rh * i) / 3);
    ctx.stroke();
  }
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
  paintCropHandles(ctx, rect, W);
  ctx.restore();
}

function paintFocusMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 11, y);
  ctx.lineTo(x + 11, y);
  ctx.moveTo(x, y - 11);
  ctx.lineTo(x, y + 11);
  ctx.stroke();
  ctx.restore();
}

export const HANDLE_FRACTION = 1 / 28;

function paintCropHandles(ctx: CanvasRenderingContext2D, rect: Rect, W: number): void {
  const [rx, ry, rw, rh] = rect;
  const length = Math.max(12, W * HANDLE_FRACTION);
  const weight = Math.max(3, W / 250);
  const corners: [number, number, number, number][] = [
    [rx, ry, 1, 1],
    [rx + rw, ry, -1, 1],
    [rx, ry + rh, 1, -1],
    [rx + rw, ry + rh, -1, -1]
  ];
  ctx.save();
  ctx.lineCap = 'butt';
  for (const [stroke, extra] of [
    ['rgba(0,0,0,0.55)', 2],
    ['#fff', 0]
  ] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = weight + extra;
    for (const [x, y, dx, dy] of corners) {
      const ox = x + (dx * weight) / 2;
      const oy = y + (dy * weight) / 2;
      ctx.beginPath();
      ctx.moveTo(ox, oy + dy * length);
      ctx.lineTo(ox, oy);
      ctx.lineTo(ox + dx * length, oy);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function canvasCrop(layout: Layout, W: number, H: number): Rect {
  const [bx, by, bw, bh] = layout.alignment.crop;
  const [cx, cy, cw, ch] = layout.crop;
  return [((cx - bx) * W) / bw, ((cy - by) * H) / bh, (cw * W) / bw, (ch * H) / bh];
}

function drawAligned(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  buffer: FrameBuffer,
  position: number,
  style: CompositeStyle
): void {
  const { alignment } = layout;
  const [bx, by, bw, bh] = alignment.crop;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const offset = alignment.offsets[position];
  const ws = buffer.workScale;
  const scale = parallaxScale(
    position % style.framesPerSet,
    style.framesPerSet,
    style.parallaxZoom
  );
  const focus = alignment.targets[position] ?? alignment.target;
  ctx.save();
  if (scale !== 1) {
    const fx = ((focus.x - bx) * W) / bw;
    const fy = ((focus.y - by) * H) / bh;
    ctx.translate(fx, fy);
    ctx.scale(scale, scale);
    ctx.translate(-fx, -fy);
  }
  ctx.drawImage(
    buffer.work,
    (bx - offset.x) * ws,
    (by - offset.y) * ws,
    bw * ws,
    bh * ws,
    0,
    0,
    W,
    H
  );
  ctx.restore();
}

function drawCovering(
  ctx: CanvasRenderingContext2D,
  cell: Rect,
  source: Rect,
  draw: () => void
): void {
  const [cx, cy, cw, ch] = cell;
  const [sx, sy, sw, sh] = source;
  const k = Math.max(cw / sw, ch / sh);
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx, cy, cw, ch);
  ctx.clip();
  ctx.translate(cx + cw / 2, cy + ch / 2);
  ctx.scale(k, k);
  ctx.translate(-(sx + sw / 2), -(sy + sh / 2));
  draw();
  ctx.restore();
}

type BufferLookup = (position: number) => FrameBuffer | undefined;

function paintSynchronised(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  buffers: BufferLookup,
  position: number,
  style: CompositeStyle,
  crop: Rect
): void {
  const setCount = Math.floor(layout.ordered.length / style.framesPerSet);
  const frameAt = (set: number) => set * style.framesPerSet + position;
  const [rx, ry, rw, rh] = crop;
  if (style.composition === 'double') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    for (let set = 0; set < setCount; set++) {
      const buffer = buffers(frameAt(set));
      if (!buffer) continue;
      ctx.globalAlpha = 1 / (set + 1);
      drawAligned(ctx, layout, buffer, frameAt(set), style);
    }
    ctx.restore();
    return;
  }
  if (style.composition === 'split') {
    for (let set = 0; set < setCount; set++) {
      const buffer = buffers(frameAt(set));
      if (!buffer) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx + (rw * set) / setCount, ry, rw / setCount, rh);
      ctx.clip();
      drawAligned(ctx, layout, buffer, frameAt(set), style);
      ctx.restore();
    }
    return;
  }
  const [cols, rows] = mosaicGrid(setCount, style.composition === 'triptych');
  const cellW = rw / cols;
  const cellH = rh / rows;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(rx, ry, rw, rh);
  ctx.restore();
  for (let set = 0; set < setCount; set++) {
    const buffer = buffers(frameAt(set));
    if (!buffer) continue;
    const cell: Rect = [
      rx + (set % cols) * cellW,
      ry + Math.floor(set / cols) * cellH,
      cellW,
      cellH
    ];
    drawCovering(ctx, cell, crop, () => drawAligned(ctx, layout, buffer, frameAt(set), style));
  }
}

export function paintComposite(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  buffers: BufferLookup,
  item: Composite,
  style: CompositeStyle,
  colors: PreviewColors,
  guides = true
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const crop = canvasCrop(layout, W, H);
  ctx.save();
  ctx.globalAlpha = 1;
  if (isSyncComposition(style.composition)) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    paintSynchronised(ctx, layout, buffers, item.a, style, crop);
  } else {
    const first = buffers(item.a);
    if (first) drawAligned(ctx, layout, first, item.a, style);
    const second = item.b === null ? undefined : buffers(item.b);
    if (second && item.b !== null) {
      ctx.globalAlpha = item.t;
      drawAligned(ctx, layout, second, item.b, style);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  if (guides) paintCompositeGuides(ctx, layout, item, style, colors);
}

export function paintCompositeGuides(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  item: Composite,
  style: CompositeStyle,
  colors: PreviewColors
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const [bx, by, bw, bh] = layout.alignment.crop;
  const crop = canvasCrop(layout, W, H);
  const cropped = crop[2] !== W || crop[3] !== H;
  if (cropped) paintCropMask(ctx, crop, W, H);
  if (isSyncComposition(style.composition)) return;
  const focus = layout.alignment.targets[item.a] ?? layout.alignment.target;
  paintFocusMarker(ctx, ((focus.x - bx) * W) / bw, ((focus.y - by) * H) / bh, colors.accent);
}

export function paintPlaceholder(
  ctx: CanvasRenderingContext2D,
  text: string,
  colors: PreviewColors
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.fillStyle = colors.placeholderBackground;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = colors.placeholderText;
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2);
}
