import { defineStore } from 'pinia';
import { ref } from 'vue';

export const usePlaybackStore = defineStore('playback', () => {
  const frame = ref(0);
  const playing = ref(true);
  function seek(value: number, total: number): void {
    playing.value = false;
    frame.value = Math.max(0, Math.min(total - 1, Math.round(value)));
  }
  return { frame, playing, seek };
});
