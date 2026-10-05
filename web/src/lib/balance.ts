import { type Adjust, ADJUST_RANGE, BRIGHTNESS_SCALE, isIdentityAdjust } from '@/lib/adjust';

export interface Tone {
  mean: number;
  std: number;
}

const BALANCE_MIN_BRIGHTNESS = 3;
const BALANCE_MIN_CONTRAST = 5;
const MIN_CONTRAST_FACTOR = 0.5;
const MAX_CONTRAST_FACTOR = 2;
const MID_GRAY = 128;

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export function balanceAdjustments(tones: Tone[], sharpen = 0): Adjust[] {
  if (tones.length < 2) return tones.map(() => ({ brightness: 0, contrast: 0, sharpen }));
  const targetMean = median(tones.map((tone) => tone.mean));
  const targetStd = median(tones.map((tone) => tone.std));
  return tones.map((tone) => {
    const factor =
      tone.std > 0 ? clamp(targetStd / tone.std, MIN_CONTRAST_FACTOR, MAX_CONTRAST_FACTOR) : 1;
    const contrast = clamp(Math.round((factor - 1) * 100), -ADJUST_RANGE, ADJUST_RANGE);
    const shiftedMean = (tone.mean - MID_GRAY) * (1 + contrast / 100) + MID_GRAY;
    const brightness = clamp(
      Math.round((targetMean - shiftedMean) / BRIGHTNESS_SCALE),
      -ADJUST_RANGE,
      ADJUST_RANGE
    );
    const negligible =
      Math.abs(brightness) < BALANCE_MIN_BRIGHTNESS && Math.abs(contrast) < BALANCE_MIN_CONTRAST;
    return negligible ? { brightness: 0, contrast: 0, sharpen } : { brightness, contrast, sharpen };
  });
}

export function unevenPositions(adjusts: Adjust[]): number[] {
  return adjusts
    .map((adjust, position) => ({ adjust, position }))
    .filter(({ adjust }) => !isIdentityAdjust({ ...adjust, sharpen: 0 }))
    .map(({ position }) => position);
}
