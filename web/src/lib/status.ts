import { isApiError } from '@/api/http';

export type StatusTone = 'neutral' | 'ok' | 'warn' | 'err';

export interface StatusMessage {
  key: string;
  params?: Record<string, unknown>;
  tone: StatusTone;
  fallback?: string;
}

export function status(
  key: string,
  params?: Record<string, unknown>,
  tone: StatusTone = 'neutral'
): StatusMessage {
  return { key, params, tone };
}

export function errorStatus(error: unknown, prefixKey: string): StatusMessage {
  if (isApiError(error)) {
    return { key: error.i18nKey, params: error.params, tone: 'err', fallback: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { key: prefixKey, params: { message }, tone: 'err', fallback: message };
}
