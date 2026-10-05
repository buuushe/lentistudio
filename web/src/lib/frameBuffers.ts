import { applyAdjust, isIdentityAdjust, type Adjust } from '@/lib/adjust';

const WORK_MAX_WIDTH = 1400;

export interface FrameBuffer {
  index: number;
  image: HTMLImageElement;
  work: HTMLCanvasElement;
  workScale: number;
  version: number;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`image failed to load: ${url}`));
    image.src = url;
  });
}

export function createFrameBuffer(index: number, image: HTMLImageElement): FrameBuffer {
  const workScale = Math.min(1, WORK_MAX_WIDTH / image.naturalWidth);
  const work = document.createElement('canvas');
  work.width = Math.round(image.naturalWidth * workScale);
  work.height = Math.round(image.naturalHeight * workScale);
  const buffer: FrameBuffer = { index, image, work, workScale, version: 0 };
  rebuildWork(buffer, { brightness: 0, contrast: 0, sharpen: 0 });
  return buffer;
}

export function rebuildWork(buffer: FrameBuffer, adjust: Adjust): void {
  const ctx = buffer.work.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(buffer.image, 0, 0, buffer.work.width, buffer.work.height);
  if (!isIdentityAdjust(adjust)) {
    const pixels = ctx.getImageData(0, 0, buffer.work.width, buffer.work.height);
    ctx.putImageData(applyAdjust(pixels, adjust), 0, 0);
  }
  buffer.version += 1;
}

export class FrameBufferRegistry {
  private readonly buffers = new Map<number, FrameBuffer>();

  get(index: number): FrameBuffer | undefined {
    return this.buffers.get(index);
  }

  has(index: number): boolean {
    return this.buffers.has(index);
  }

  set(buffer: FrameBuffer): void {
    this.buffers.set(buffer.index, buffer);
  }

  delete(index: number): void {
    this.buffers.delete(index);
  }

  clear(): void {
    this.buffers.clear();
  }

  indices(): number[] {
    return [...this.buffers.keys()];
  }
}
