const JPEG_QUALITY = 0.92;
export const MEGABYTE = 1024 * 1024;
export const UPLOAD_SOFT_LIMIT_BYTES = 10 * MEGABYTE;
export const UPLOAD_HARD_LIMIT_BYTES = 25 * MEGABYTE;
export const FRAME_MAX_SIDE = 3000;
export const SCAN_MAX_SIDE = 8000;

export function isHeavy(file: File, limit = UPLOAD_SOFT_LIMIT_BYTES): boolean {
  return file.size > limit;
}

export function isOverHardLimit(file: File, limit = UPLOAD_HARD_LIMIT_BYTES): boolean {
  return file.size > limit;
}

export function megabytes(bytes: number): number {
  return Math.round(bytes / MEGABYTE);
}

export function jpegName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.jpg`;
}

export function fitScale(width: number, height: number, maxSide: number): number {
  const longest = Math.max(width, height);
  return longest > maxSide ? maxSide / longest : 1;
}

function canShrinkInBrowser(): boolean {
  return typeof createImageBitmap === 'function';
}

async function encodeJpeg(
  bitmap: ImageBitmap,
  width: number,
  height: number
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
}

export async function shrinkImage(
  file: File,
  maxSide: number,
  softLimit = UPLOAD_SOFT_LIMIT_BYTES
): Promise<File> {
  if (!canShrinkInBrowser()) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const scale = fitScale(bitmap.width, bitmap.height, maxSide);
    if (scale >= 1 && !isHeavy(file, softLimit)) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const blob = await encodeJpeg(bitmap, width, height);
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified
    });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}

export async function shrinkAll(
  files: File[],
  maxSide: number,
  onProgress: (done: number) => void = () => undefined,
  shrink: typeof shrinkImage = shrinkImage
): Promise<File[]> {
  const result: File[] = [];
  for (const [k, file] of files.entries()) {
    onProgress(k);
    result.push(await shrink(file, maxSide));
  }
  onProgress(files.length);
  return result;
}
