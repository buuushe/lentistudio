import { createPinia, setActivePinia } from 'pinia';
import { expect, it } from 'vitest';
import { usePlaybackStore } from '@/stores/playback';

it('pauses and clamps seeking to an existing output frame', () => {
  setActivePinia(createPinia());
  const playback = usePlaybackStore();
  playback.seek(12, 10);
  expect(playback.frame).toBe(9);
  expect(playback.playing).toBe(false);
  playback.seek(-3, 10);
  expect(playback.frame).toBe(0);
});
