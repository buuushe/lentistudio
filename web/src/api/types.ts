import type { Adjust } from '@/lib/adjust';
import type { CropFraction, Point, Preset } from '@/lib/geometry';
import type { ScanGeometry, SplitAxis, SplitCount } from '@/lib/scanSplit';
import type { Composition, LoopMode, SetLoopMode } from '@/lib/sequence';

export interface FrameMeta {
  index: number;
  name: string;
  width: number;
  height: number;
  url: string;
  thumb_url: string;
}

export interface UploadResponse {
  session_id: string;
  frames: FrameMeta[];
  total: number;
}

export interface ScanMeta {
  index: number;
  name: string;
  width: number;
  height: number;
  url: string;
  thumb_url: string;
}

export interface ScansResponse {
  session_id: string;
  scans: ScanMeta[];
  total: number;
}

export interface SplitRequest {
  session_id: string;
  count: SplitCount;
  axis: SplitAxis;
  box: CropFraction;
  gap: number;
  scans?: ScanGeometry[];
}

export interface MatchRequest {
  session_id: string;
  ref_index: number;
  point: Point | null;
  targets: number[];
}

export interface MatchResult {
  index: number;
  x: number;
  y: number;
  score: number;
}

export interface MatchResponse {
  ref: { index: number; x: number; y: number; suggested: boolean };
  results: MatchResult[];
}

export interface OrderRequest {
  session_id: string;
  order: number[];
  points: Point[] | null;
}

export interface OrderResponse {
  order: number[] | null;
  t?: number[];
  confidence?: number;
  direction_confident?: boolean;
  tracked?: number;
  parallax_px?: number;
  error?: { code: string; message: string; params: Record<string, unknown> };
}

export interface SetLoopRequest {
  mode: LoopMode;
  pattern: number[] | null;
  cycles: number;
}

export interface RenderJob {
  order: number[];
  points: Point[];
  set_loops: SetLoopRequest[];
  frames_per_set: number;
  set_mode: SetLoopMode;
  shared_focus: boolean;
  loops: number | null;
  composition: Composition;
  transition_frames: number;
  parallax_zoom: number;
  fps: number;

  duration: number;
  max_width: number | null;
  preset: Preset;
  anchor: Point | null;
  crop: CropFraction | null;
  adjustments: Adjust[] | null;
}

export interface RenderRequest extends RenderJob {
  session_id: string;
}

export interface BatchRequest {
  session_id: string;
  items: RenderJob[];
  set_numbers: number[];
}

export type BatchStatus = 'running' | 'done' | 'cancelled' | 'failed';

export interface BatchItemError {
  code: string;
  message: string;
  params: Record<string, unknown>;
}

export interface BatchItem {
  set: number;
  status: 'pending' | 'done' | 'failed';
  render?: RenderResponse;
  error?: BatchItemError;
}

export interface BatchState {
  batch_id: string;
  status: BatchStatus;
  total: number;
  done: number;
  items: BatchItem[];
  zip_url: string | null;
}

export interface RenderResponse {
  video_url: string;
  download_url: string;
  poster_url: string;
  video_name: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  duration: number;
  size_bytes: number;
}
