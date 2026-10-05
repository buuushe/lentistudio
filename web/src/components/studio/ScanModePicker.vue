<script setup lang="ts">
import { useI18n } from 'vue-i18n';

import { SCAN_MODES, type ScanMode } from '@/lib/scanSplit';

withDefaults(defineProps<{ modelValue: ScanMode; modes?: ScanMode[] }>(), {
  modes: () => SCAN_MODES
});
const emit = defineEmits<{ 'update:modelValue': [mode: ScanMode] }>();

const { t } = useI18n();
const names: Record<ScanMode, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four' };

const GLYPH_WIDTH = 64;
const GLYPH_HEIGHT = 24;
const GLYPH_PADDING = 3;
const GLYPH_GAP = 2;

function cells(mode: ScanMode): { x: number; w: number }[] {
  const inner = GLYPH_WIDTH - GLYPH_PADDING * 2;
  const w = (inner - GLYPH_GAP * (mode - 1)) / mode;
  return Array.from({ length: mode }, (_, k) => ({ x: GLYPH_PADDING + k * (w + GLYPH_GAP), w }));
}

function optionClass(mode: ScanMode, current: ScanMode): string {
  return mode === current
    ? 'border-accent bg-accent-soft text-ink'
    : 'border-line text-ink-2 hover:border-ink-2 hover:text-ink';
}
</script>

<template>
  <div role="radiogroup" :aria-label="t('studio.scanMode.title')" class="flex flex-wrap gap-2">
    <button
      v-for="mode in modes"
      :key="mode"
      type="button"
      role="radio"
      class="flex min-h-9 items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] transition-colors"
      :class="optionClass(mode, modelValue)"
      :aria-checked="mode === modelValue"
      :title="t(`studio.scanMode.${names[mode]}Hint`)"
      @click="emit('update:modelValue', mode)"
    >
      <svg
        :viewBox="`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`"
        class="h-6 w-16 shrink-0"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="1.25"
      >
        <rect x="0.5" y="0.5" :width="GLYPH_WIDTH - 1" :height="GLYPH_HEIGHT - 1" rx="2" />
        <rect
          v-for="cell in cells(mode)"
          :key="cell.x"
          :x="cell.x"
          :y="GLYPH_PADDING"
          :width="cell.w"
          :height="GLYPH_HEIGHT - GLYPH_PADDING * 2"
          rx="1"
          fill="currentColor"
          fill-opacity="0.18"
        />
      </svg>
      <span class="font-semibold whitespace-nowrap">{{ t(`studio.scanMode.${names[mode]}`) }}</span>
    </button>
  </div>
</template>
