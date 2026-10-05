import { requestJson, type RequestOptions } from '@/api/http';
import type {
  BatchRequest,
  BatchState,
  MatchRequest,
  MatchResponse,
  OrderRequest,
  OrderResponse,
  RenderRequest,
  RenderResponse,
  ScansResponse,
  SplitRequest,
  UploadResponse
} from '@/api/types';

const BASE = '/api/render';

function renderRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return requestJson<T>('render', `${BASE}${path}`, options);
}

export function uploadFrames(files: File[], sessionId: string | null): Promise<UploadResponse> {
  const form = new FormData();
  files.forEach((file) => form.append('files', file, file.name));
  if (sessionId) form.append('session_id', sessionId);
  return renderRequest<UploadResponse>('/upload', { method: 'POST', body: form });
}

export function uploadScans(files: File[], sessionId: string | null): Promise<ScansResponse> {
  const form = new FormData();
  files.forEach((file) => form.append('files', file, file.name));
  if (sessionId) form.append('session_id', sessionId);
  return renderRequest<ScansResponse>('/scans', { method: 'POST', body: form });
}

export function splitScans(request: SplitRequest): Promise<UploadResponse> {
  return renderRequest<UploadResponse>('/split', {
    method: 'POST',
    body: request
  });
}

export function matchPoint(request: MatchRequest, signal?: AbortSignal): Promise<MatchResponse> {
  return renderRequest<MatchResponse>('/match', {
    method: 'POST',
    body: request,
    signal
  });
}

export function detectOrder(request: OrderRequest, signal?: AbortSignal): Promise<OrderResponse> {
  return renderRequest<OrderResponse>('/order', {
    method: 'POST',
    body: request,
    signal
  });
}

export function renderVideo(request: RenderRequest): Promise<RenderResponse> {
  return renderRequest<RenderResponse>('/render', {
    method: 'POST',
    body: request
  });
}

export function startBatch(request: BatchRequest): Promise<BatchState> {
  return renderRequest<BatchState>('/render/batch', {
    method: 'POST',
    body: request
  });
}

export function fetchBatch(sessionId: string, batchId: string): Promise<BatchState> {
  return renderRequest<BatchState>(`/render/batch/${sessionId}/${batchId}`);
}

export function cancelBatch(sessionId: string, batchId: string): Promise<BatchState> {
  return renderRequest<BatchState>(`/render/batch/${sessionId}/${batchId}`, {
    method: 'DELETE'
  });
}

const GONE_STATUSES = [404, 410];

export async function frameAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return !GONE_STATUSES.includes(response.status);
  } catch {
    return false;
  }
}

interface PaletteResponse {
  features: {
    index: number;
    signature: number[];
    structure: number[];
    tone?: [number, number];
  }[];
}

export function fetchPalette(sessionId: string, indices: number[]): Promise<PaletteResponse> {
  return renderRequest<PaletteResponse>('/palette', {
    method: 'POST',
    body: { session_id: sessionId, indices }
  });
}

export function closeSession(sessionId: string): Promise<{ closed: boolean }> {
  return renderRequest<{ closed: boolean }>(`/session/${sessionId}`, {
    method: 'DELETE'
  });
}
