<script setup lang="ts">
import { useI18n } from 'vue-i18n';

import { SET_SIZES, type SetSize } from '@/lib/geometry';

defineProps<{ modelValue: SetSize }>();
const emit = defineEmits<{ 'update:modelValue': [size: SetSize] }>();

const { t } = useI18n();

const GLYPH_WIDTH = 64;
const GLYPH_HEIGHT = 24;
const LENS_RADIUS = 4;

function lenses(size: SetSize): number[] {
  const step = (GLYPH_WIDTH - LENS_RADIUS * 4) / Math.max(1, size - 1);
  return Array.from({ length: size }, (_, k) => LENS_RADIUS * 2 + k * step);
}

function optionClass(size: SetSize, current: SetSize): string {
  return size === current
    ? 'border-accent bg-accent-soft text-ink'
    : 'border-line text-ink-2 hover:border-ink-2 hover:text-ink';
}
</script>

<template>
  <div role="radiogroup" :aria-label="t('studio.setSize.title')" class="flex flex-wrap gap-2">
    <button
      v-for="size in SET_SIZES"
      :key="size"
      type="button"
      role="radio"
      class="flex min-h-9 items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] transition-colors"
      :class="optionClass(size, modelValue)"
      :aria-checked="size === modelValue"
      :title="t('studio.setSize.hint', { n: size })"
      @click="emit('update:modelValue', size)"
    >
      <svg
        :viewBox="`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`"
        class="h-6 w-16 shrink-0"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="1.25"
      >
        <rect x="0.5" y="0.5" :width="GLYPH_WIDTH - 1" :height="GLYPH_HEIGHT - 1" rx="4" />
        <circle
          v-for="x in lenses(size)"
          :key="x"
          :cx="x"
          :cy="GLYPH_HEIGHT / 2"
          :r="LENS_RADIUS"
          fill="currentColor"
          fill-opacity="0.18"
        />
      </svg>
      <span class="font-semibold whitespace-nowrap">{{
        t('studio.setSize.option', { n: size })
      }}</span>
    </button>
  </div>
</template>
