<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { useStudioStore, type OutputMode } from '@/stores/studio';

const { t } = useI18n();
const studio = useStudioStore();

const modes = computed(() => [
  {
    mode: 'combined' as const,
    label: t('studio.outputMode.combined'),
    hint: t('studio.outputMode.combinedHint')
  },
  {
    mode: 'separate' as const,
    label: t('studio.outputMode.separate'),
    hint: t('studio.outputMode.separateHint', { n: studio.shownSetCount })
  }
]);

function modeClass(mode: OutputMode): string {
  return studio.settings.output === mode
    ? 'border-accent text-accent bg-accent-soft'
    : 'border-line text-ink-2 hover:border-ink hover:text-ink';
}
</script>

<template>
  <div
    class="flex shrink-0 items-center gap-1 text-[13px]"
    role="radiogroup"
    :aria-label="t('studio.outputMode.label')"
  >
    <button
      v-for="item in modes"
      :key="item.mode"
      type="button"
      role="radio"
      class="h-10 rounded-md border px-3 disabled:opacity-40"
      :class="modeClass(item.mode)"
      :title="item.hint"
      :aria-checked="studio.settings.output === item.mode"
      :disabled="studio.rendering"
      @click="studio.setOutputMode(item.mode)"
    >
      {{ item.label }}
    </button>
  </div>
</template>
