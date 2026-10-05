<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { useStudioStore, type OutputMode } from '@/stores/studio';

const GLYPH_WIDTH = 96;
const GLYPH_HEIGHT = 32;
const GLYPH_CELLS = 3;
const GLYPH_PADDING = 4;
const GLYPH_GAP = 6;

const { t } = useI18n();
const studio = useStudioStore();

const cellWidth = (GLYPH_WIDTH - GLYPH_PADDING * 2 - GLYPH_GAP * (GLYPH_CELLS - 1)) / GLYPH_CELLS;
const cellOffsets = Array.from(
  { length: GLYPH_CELLS },
  (_, k) => GLYPH_PADDING + k * (cellWidth + GLYPH_GAP)
);

const options = computed(() => [
  {
    mode: 'combined' as const,
    title: t('studio.outputChoice.combined', { n: studio.setCount }),
    hint: t('studio.outputChoice.combinedHint')
  },
  {
    mode: 'separate' as const,
    title: t('studio.outputChoice.separate', { n: studio.setCount }),
    hint: t('studio.outputChoice.separateHint', { n: studio.setCount })
  }
]);

function choose(mode: OutputMode): void {
  studio.chooseOutput(mode);
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center gap-4">
    <h2 class="text-[16px] font-semibold">
      {{ t('studio.outputChoice.title', { n: studio.setCount }) }}
    </h2>
    <div class="grid grid-cols-2 gap-3">
      <button
        v-for="option in options"
        :key="option.mode"
        type="button"
        class="border-line hover:border-accent hover:bg-accent-soft flex flex-col items-start gap-3 rounded-md border p-4 text-left transition-colors"
        @click="choose(option.mode)"
      >
        <svg
          :viewBox="`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`"
          class="text-ink-2 h-8 w-24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="1.25"
        >
          <rect
            v-if="option.mode === 'combined'"
            x="0.5"
            y="0.5"
            :width="GLYPH_WIDTH - 1"
            :height="GLYPH_HEIGHT - 1"
            rx="3"
          />
          <rect
            v-for="x in cellOffsets"
            :key="x"
            :x="x"
            :y="GLYPH_PADDING"
            :width="cellWidth"
            :height="GLYPH_HEIGHT - GLYPH_PADDING * 2"
            rx="2"
          />
        </svg>
        <span class="text-[15px] font-semibold">{{ option.title }}</span>
        <span class="text-ink-2 text-[13px]">{{ option.hint }}</span>
      </button>
    </div>
    <p class="text-ink-2 text-[12px]">{{ t('studio.outputChoice.later') }}</p>
  </div>
</template>
