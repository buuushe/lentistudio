import { afterEach, describe, expect, it, vi } from 'vitest';

import { frameAvailable } from '@/api/renderApi';

function respondWith(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('frameAvailable', () => {
  it('probes with HEAD and accepts a served frame', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await frameAvailable('/api/render/frames/abc/0/thumb')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/render/frames/abc/0/thumb', { method: 'HEAD' });
  });

  it('reports a session as gone only when the server says it is missing', async () => {
    respondWith(404);
    expect(await frameAvailable('/x')).toBe(false);
    respondWith(410);
    expect(await frameAvailable('/x')).toBe(false);
  });

  it('keeps the session on a server or method error', async () => {
    for (const status of [405, 500, 502]) {
      respondWith(status);
      expect(await frameAvailable('/x')).toBe(true);
    }
  });

  it('reports a session as gone when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    expect(await frameAvailable('/x')).toBe(false);
  });
});
