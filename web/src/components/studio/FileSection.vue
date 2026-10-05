<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import DeckPanel from '@/components/studio/DeckPanel.vue';
import SelectField from '@/components/ui/SelectField.vue';
import type { SelectValue } from '@/lib/select';
import { MAX_LOOPS } from '@/lib/sequence';
import { useStudioStore } from '@/stores/studio';

const { t } = useI18n();
const studio = useStudioStore();

const loopOptions = computed(() => [
  { value: null, label: t('studio.output.loopsByDuration') },
  ...Array.from({ length: MAX_LOOPS }, (_, k) => ({
    value: k + 1,
    label: t('studio.output.loopsExact', { n: k + 1 })
  }))
]);

const fieldClass =
  'bg-bg-2 border-line focus:border-ink h-8 w-full min-w-0 rounded-sm border-b px-2 text-[13px] outline-none';
const rowClass = 'grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3 text-[13px]';
</script>

<template>
  <DeckPanel
    :title="t('studio.output.fileTitle')"
    :hint="t('studio.output.fileHint')"
    :disabled="!studio.selectionComplete"
  >
    <div class="grid grid-cols-[96px_minmax(0,1fr)_32px_64px] items-center gap-3 text-[13px]">
      <span class="text-ink-2 truncate">{{ t('studio.output.fps') }}</span>
      <input
        v-model.number="studio.settings.fps"
        type="range"
        min="4"
        max="30"
        class="accent-ink h-5 w-full min-w-0"
      />
      <output class="tabular text-right">{{ studio.settings.fps }}</output>
      <input
        v-if="studio.settings.loops === null"
        v-model.number="studio.settings.duration"
        type="number"
        min="1"
        max="120"
        step="0.5"
        :class="fieldClass"
        :title="t('studio.output.duration')"
        :aria-label="t('studio.output.duration')"
      />
      <output v-else class="tabular text-ink-2 text-right" :title="t('studio.output.duration')">
        {{ (studio.sequence.length / studio.settings.fps).toFixed(1) }}
      </output>
    </div>

    <label :class="rowClass">
      <span class="text-ink-2 truncate">{{ t('studio.output.loops') }}</span>
      <SelectField
        :model-value="studio.settings.loops"
        :options="loopOptions"
        class="w-full"
        :label="t('studio.output.loops')"
        @update:model-value="
          (value: SelectValue) => (studio.settings.loops = value as number | null)
        "
      />
    </label>
  </DeckPanel>
</template>
