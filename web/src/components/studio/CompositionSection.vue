<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import DeckPanel from '@/components/studio/DeckPanel.vue';
import Hint from '@/components/ui/Hint.vue';
import SelectField from '@/components/ui/SelectField.vue';
import type { SelectValue } from '@/lib/select';
import {
  COMPOSITIONS,
  MAX_PARALLAX_ZOOM,
  MAX_TRANSITION_FRAMES,
  type Composition
} from '@/lib/sequence';
import { useStudioStore } from '@/stores/studio';

const { t } = useI18n();
const studio = useStudioStore();

const compositionOptions = computed(() =>
  COMPOSITIONS.map((item) => ({ value: item, label: t(`studio.output.compositions.${item}`) }))
);
const transitionOptions = computed(() =>
  Array.from({ length: MAX_TRANSITION_FRAMES }, (_, k) => ({
    value: k + 1,
    label: t('studio.output.transitionOption', { n: k + 1 })
  }))
);

const several = computed(() => studio.animatedSetCount > 1);
const crossfading = computed(() => several.value && studio.settings.composition === 'crossfade');
const zoomPercent = computed({
  get: () => Math.round(studio.settings.parallaxZoom * 100),
  set: (value: number) => {
    studio.settings.parallaxZoom = Math.min(MAX_PARALLAX_ZOOM, Math.max(0, value / 100));
  }
});
</script>

<template>
  <DeckPanel
    :title="t('studio.composition.title')"
    :hint="t('studio.composition.hint')"
    :disabled="!studio.selectionComplete"
  >
    <div
      v-if="several"
      class="grid items-center gap-3 text-[13px]"
      :class="
        crossfading ? 'grid-cols-[96px_minmax(0,1fr)_64px]' : 'grid-cols-[96px_minmax(0,1fr)]'
      "
    >
      <span class="text-ink-2 truncate">{{ t('studio.output.composition') }}</span>
      <SelectField
        :model-value="studio.settings.composition"
        :options="compositionOptions"
        class="w-full"
        :label="t('studio.output.composition')"
        @update:model-value="
          (value: SelectValue) => (studio.settings.composition = value as Composition)
        "
      />
      <SelectField
        v-if="crossfading"
        :model-value="studio.settings.transitionFrames"
        :options="transitionOptions"
        class="w-full"
        :title="t('studio.output.transitionFrames')"
        :label="t('studio.output.transitionFrames')"
        @update:model-value="
          (value: SelectValue) => (studio.settings.transitionFrames = value as number)
        "
      />
    </div>

    <label v-if="several" class="flex items-center gap-2 text-[13px]">
      <input v-model="studio.settings.sharedFocus" type="checkbox" class="accent-accent" />
      <span class="min-w-0 flex-1 truncate">{{ t('studio.output.sharedFocus') }}</span>
      <Hint :text="t('studio.output.sharedFocusHint')" />
    </label>

    <div class="grid grid-cols-[96px_minmax(0,1fr)_32px_16px] items-center gap-3 text-[13px]">
      <span class="text-ink-2 truncate">{{ t('studio.output.parallaxZoom') }}</span>
      <input
        v-model.number="zoomPercent"
        type="range"
        min="0"
        :max="Math.round(MAX_PARALLAX_ZOOM * 100)"
        class="accent-ink h-5 w-full min-w-0"
        :title="t('studio.output.parallaxZoomHint')"
      />
      <output class="tabular text-right">{{ zoomPercent }}</output>
      <Hint :text="t('studio.output.parallaxZoomHint')" />
    </div>
  </DeckPanel>
</template>
