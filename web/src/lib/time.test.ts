import { describe, expect, it } from 'vitest';

import { relativeTime } from '@/lib/time';

const now = new Date('2026-09-20T12:00:00Z');

describe('relativeTime', () => {
  it('picks the largest fitting unit', () => {
    expect(relativeTime('2026-09-17T12:00:00Z', 'en', now)).toBe('3 days ago');
    expect(relativeTime('2026-09-20T09:30:00Z', 'en', now)).toBe('2 hours ago');
    expect(relativeTime('2026-09-20T11:59:30Z', 'en', now)).toBe('now');
    expect(relativeTime('2025-06-01T00:00:00Z', 'en', now)).toBe('last year');
  });

  it('returns an empty string for garbage', () => {
    expect(relativeTime('nope', 'en', now)).toBe('');
  });
});
