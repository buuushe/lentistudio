export type ApiSource = 'render' | 'network';

interface ApiErrorBody {
  code: string;
  message: string;
  params: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params: Record<string, unknown>;
  readonly source: ApiSource;

  constructor(source: ApiSource, status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.source = source;
    this.status = status;
    this.code = body.code;
    this.params = body.params;
  }

  get i18nKey(): string {
    return `errors.${this.source}.${this.code}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fromDetail(detail: unknown, status: number): ApiErrorBody {
  if (typeof detail === 'string') return { code: `http_${status}`, message: detail, params: {} };
  if (isRecord(detail) && typeof detail.code === 'string') {
    return {
      code: detail.code,
      message: typeof detail.message === 'string' ? detail.message : detail.code,
      params: isRecord(detail.params) ? detail.params : {}
    };
  }
  if (Array.isArray(detail)) {
    const first = detail[0];
    const message =
      isRecord(first) && typeof first.msg === 'string' ? first.msg : 'Invalid request';
    return { code: 'validation_failed', message, params: {} };
  }
  return { code: `http_${status}`, message: `Request failed with status ${status}`, params: {} };
}

export function parseErrorBody(source: ApiSource, status: number, body: unknown): ApiError {
  const envelope = isRecord(body) ? body.detail : undefined;
  return new ApiError(source, status, fromDetail(envelope, status));
}

export function networkError(cause: unknown): ApiError {
  const message = cause instanceof Error ? cause.message : 'Network request failed';
  return new ApiError('network', 0, { code: 'unreachable', message, params: {} });
}
