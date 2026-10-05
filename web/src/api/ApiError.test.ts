import { describe, expect, it } from 'vitest';

import { parseErrorBody } from '@/api/ApiError';

describe('parseErrorBody', () => {
  it('reads the render service envelope', () => {
    const error = parseErrorBody('render', 400, {
      detail: {
        code: 'upload.unsupported_format',
        message: 'Unsupported',
        params: { filename: 'a.txt' }
      }
    });
    expect(error.code).toBe('upload.unsupported_format');
    expect(error.params).toEqual({ filename: 'a.txt' });
    expect(error.i18nKey).toBe('errors.render.upload.unsupported_format');
    expect(error.status).toBe(400);
  });

  it('turns FastAPI validation lists into one coded error', () => {
    const error = parseErrorBody('render', 422, {
      detail: [{ loc: ['body', 'order'], msg: 'Value error, order must be distinct' }]
    });
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('distinct');
  });

  it('falls back to an http code for unknown bodies', () => {
    expect(parseErrorBody('render', 502, 'Bad gateway').code).toBe('http_502');
    expect(parseErrorBody('render', 500, { detail: 'boom' }).message).toBe('boom');
  });
});
