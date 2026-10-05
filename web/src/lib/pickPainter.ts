import type { FrameBuffer } from '@/lib/frameBuffers';
import type { Point } from '@/lib/geometry';

export const LOUPE_SIZE = 160;
const LOUPE_ZOOM = 3;
const LOUPE_OFFSET = 24;

interface PickColors {
  manual: string;
  auto: string;
  ring: string;
}

function paintMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  ring: string,
  width: number
): void {
  const radius = Math.max(8, width / 60);
  const gap = radius * 1.8;
  const line = Math.max(1, width / 900);
  const { width: w, height: h } = ctx.canvas;
  ctx.save();
  ctx.lineCap = 'round';
  for (const [stroke, weight] of [
    [ring, line * 3],
    [color, line]
  ] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = weight;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, y - gap);
    ctx.moveTo(x, y + gap);
    ctx.lineTo(x, h);
    ctx.moveTo(0, y);
    ctx.lineTo(x - gap, y);
    ctx.moveTo(x + gap, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, line * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

interface Region {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function regionAround(
  point: Point | undefined,
  width: number,
  height: number,
  zoom: number,
  square = false
): Region {
  if (!point || zoom <= 1) return { sx: 0, sy: 0, sw: width, sh: height };
  const side = Math.round(Math.min(width, height) / zoom);
  const sw = square ? side : Math.round(width / zoom);
  const sh = square ? side : Math.round(height / zoom);
  const sx = Math.min(Math.max(Math.round(point.x - sw / 2), 0), width - sw);
  const sy = Math.min(Math.max(Math.round(point.y - sh / 2), 0), height - sh);
  return { sx, sy, sw, sh };
}

export function paintFrame(
  ctx: CanvasRenderingContext2D,
  buffer: FrameBuffer,
  point: Point | undefined,
  isAuto: boolean,
  colors: PickColors,
  zoom = 1,
  square = false
): void {
  const canvas = ctx.canvas;
  const scaled = point
    ? { x: point.x * buffer.workScale, y: point.y * buffer.workScale }
    : undefined;
  const region = regionAround(scaled, buffer.work.width, buffer.work.height, zoom, square);
  if (canvas.width !== region.sw || canvas.height !== region.sh) {
    canvas.width = region.sw;
    canvas.height = region.sh;
  }
  ctx.drawImage(
    buffer.work,
    region.sx,
    region.sy,
    region.sw,
    region.sh,
    0,
    0,
    region.sw,
    region.sh
  );
  if (!scaled) return;
  paintMarker(
    ctx,
    scaled.x - region.sx,
    scaled.y - region.sy,
    isAuto ? colors.auto : colors.manual,
    colors.ring,
    buffer.work.width
  );
}

export function paintLoupe(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  point: Point,
  color: string,
  screenScale = 1
): void {
  const src = LOUPE_SIZE / (LOUPE_ZOOM * Math.max(screenScale, 1e-6));
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  ctx.drawImage(
    image,
    point.x - src / 2,
    point.y - src / 2,
    src,
    src,
    0,
    0,
    LOUPE_SIZE,
    LOUPE_SIZE
  );
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LOUPE_SIZE / 2, 0);
  ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
  ctx.moveTo(0, LOUPE_SIZE / 2);
  ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
  ctx.stroke();
}

export function loupePosition(
  pointer: { x: number; y: number },
  host: { width: number; height: number }
): { left: number; top: number } {
  let left = pointer.x + LOUPE_OFFSET;
  let top = pointer.y - LOUPE_SIZE - LOUPE_OFFSET;
  if (left + LOUPE_SIZE > host.width) left = pointer.x - LOUPE_SIZE - LOUPE_OFFSET;
  if (top < 0) top = pointer.y + LOUPE_OFFSET;
  return { left, top };
}

export function clampToFrame(point: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(point.x, 0), width - 1),
    y: Math.min(Math.max(point.y, 0), height - 1)
  };
}

export function pointerToImage(
  event: { clientX: number; clientY: number },
  rect: DOMRect,
  width: number,
  height: number
): Point {
  const x = ((event.clientX - rect.left) / rect.width) * width;
  const y = ((event.clientY - rect.top) / rect.height) * height;
  return clampToFrame({ x, y }, width, height);
}

export function themeColor(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
