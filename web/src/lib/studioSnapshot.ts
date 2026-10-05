import type { BatchState, FrameMeta, RenderResponse, ScanMeta } from '@/api/types';
import type { Adjust } from '@/lib/adjust';
import type { CropFraction, Point } from '@/lib/geometry';
import type { ScanMode, ScanSplit, SplitScope } from '@/lib/scanSplit';
import type { LoopMode, SetLoopMode } from '@/lib/sequence';

export const SNAPSHOT_VERSION = 1;
const LOCAL_SNAPSHOT_KEY = 'lenti.studio.v1';

export interface SetSnapshot {
  frames: number[];
  adjust: Adjust;
  grouped: boolean;
  balanced?: boolean;
  hidden?: boolean;
  loop?: string;
  patternText?: string;
  cycles?: number;
  anchor?: Point | null;
  customCrop?: CropFraction | null;
}

export interface PointMetaSnapshot {
  source: 'manual' | 'auto' | 'center';
  score?: number;
}

export interface SettingsSnapshot {
  mode?: LoopMode;
  patternText?: string;
  setMode: SetLoopMode;
  cyclesPerSet?: number;
  sharedFocus: boolean;
  loops?: number | null;
  composition?: string;
  transitionFrames?: number;
  parallaxZoom?: number;
  fps: number;
  duration: number;
  preset: string;

  maxWidth: number | null;
  output?: string;
}

export interface StudioSnapshot {
  version: typeof SNAPSHOT_VERSION;
  sessionId: string | null;
  frames: FrameMeta[];
  sets: SetSnapshot[];
  activeSet: number;
  points: Record<number, Point>;
  pointMeta: Record<number, PointMetaSnapshot>;
  lastManual: number | null;
  anchor: Point | null;
  customCrop?: CropFraction | null;
  perFrameAdjust: Record<number, Adjust>;
  settings: SettingsSnapshot;
  autoMatch: boolean;
  renders: RenderResponse[];
  currentRenderName: string | null;
  batch?: BatchState | null;
  scanMode?: ScanMode;
  setSize?: number;
  scans?: ScanMeta[];
  split?: ScanSplit | null;
  splitScope?: SplitScope;
  scanSplits?: ScanSplit[];
  cutting?: boolean;
}

function isStudioSnapshot(value: unknown): value is StudioSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StudioSnapshot>;
  return (
    candidate.version === SNAPSHOT_VERSION &&
    Array.isArray(candidate.frames) &&
    Array.isArray(candidate.sets) &&
    typeof candidate.settings === 'object'
  );
}

export function loadLocalSnapshot(): StudioSnapshot | null {
  try {
    const raw = localStorage.getItem(LOCAL_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStudioSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLocalSnapshot(snapshot: StudioSnapshot): void {
  try {
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    return;
  }
}

export function clearLocalSnapshot(): void {
  try {
    localStorage.removeItem(LOCAL_SNAPSHOT_KEY);
  } catch {
    return;
  }
}
