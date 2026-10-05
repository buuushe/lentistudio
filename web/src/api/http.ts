import { ApiError, networkError, parseErrorBody, type ApiSource } from '@/api/ApiError';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function buildInit(options: RequestOptions): RequestInit {
  const headers: Record<string, string> = { ...options.headers };
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return { method: options.method ?? 'GET', headers, body, signal: options.signal };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function requestJson<T>(
  source: ApiSource,
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, buildInit(options));
  } catch (cause) {
    throw networkError(cause);
  }
  const body = await readBody(response);
  if (!response.ok) throw parseErrorBody(source, response.status, body);
  return body as T;
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
