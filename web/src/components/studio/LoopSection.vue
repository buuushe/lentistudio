<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import DeckPanel from '@/components/studio/DeckPanel.vue';
import Hint from '@/components/ui/Hint.vue';
import SelectField from '@/components/ui/SelectField.vue';
import { useLoopLabel } from '@/composables/useLoopLabel';
import type { SelectValue } from '@/lib/select';
import { LOOP_MODES, MAX_CYCLES_PER_SET, type LoopMode } from '@/lib/sequence';
import { useStudioStore } from '@/stores/studio';

const { t } = useI18n();
const studio = useStudioStore();
const loopLabel = useLoopLabel();

const set = computed(() => studio.sets[studio.activeSet]);
const title = computed(() =>
  studio.setCount > 1
    ? `${t('studio.loop.title')} · ${studio.activeSet + 1}`
    : t('studio.loop.title')
);
const frozen = computed(() => studio.sweeping && !studio.separate && studio.animatedSetCount > 1);
const note = computed(() => {
  if (frozen.value) return t('studio.loop.sweepNote');
  if (studio.synced) return t('studio.loop.syncedNote');
  return '';
});

const loopOptions = computed(() =>
  LOOP_MODES.map((mode) => ({ value: mode, label: loopLabel(mode) }))
);
const cycleChoices = Array.from({ length: MAX_CYCLES_PER_SET }, (_, k) => k + 1);
const patternInvalid = computed(
  () =>
    set.value.loop === 'custom' &&
    set.value.patternText !== '' &&
    studio.patternOf(set.value) === null
);

function chipClass(selected: boolean): string {
  return selected
    ? 'border-accent text-accent bg-accent-soft'
    : 'border-line text-ink-2 hover:border-ink hover:text-ink';
}

function chooseLoop(value: SelectValue): void {
  studio.setLoop(studio.activeSet, value as LoopMode);
}

function updatePattern(event: Event): void {
  studio.setPatternText(studio.activeSet, (event.target as HTMLInputElement).value);
}

const fieldClass =
  'bg-bg-2 border-line focus:border-ink h-7 w-full min-w-0 rounded-sm border-b px-2 text-[13px] outline-none';
</script>

<template>
  <DeckPanel
    dense
    :title="title"
    :hint="t('studio.loop.hint', { n: studio.setSize })"
    :disabled="!studio.selectionComplete || frozen"
  >
    <template #actions>
      <button
        v-if="studio.setCount > 1"
        type="button"
        class="text-ink-2 hover:text-ink hover:bg-bg-2 h-7 rounded-md px-2 text-[12px]"
        @click="studio.applyLoopToAll()"
      >
        {{ t('studio.loop.applyAll') }}
      </button>
    </template>

    <SelectField
      size="sm"
      class="w-full"
      :model-value="set.loop"
      :options="loopOptions"
      :label="t('studio.loop.title')"
      @update:model-value="chooseLoop"
    />

    <label
      v-if="set.loop === 'custom'"
      class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-[13px]"
    >
      <input
        :value="set.patternText"
        type="text"
        spellcheck="false"
        :placeholder="t('studio.output.patternPlaceholder')"
        :aria-label="t('studio.output.pattern')"
        :class="[fieldClass, { 'border-err': patternInvalid }]"
        @input="updatePattern"
      />
      <Hint :text="t('studio.output.patternHint', { max: studio.setSize })" />
    </label>

    <div
      class="flex items-center gap-1 text-[12px]"
      role="radiogroup"
      :aria-label="t('studio.loop.repeats')"
    >
      <span class="text-ink-2 mr-1">{{ t('studio.loop.repeats') }}</span>
      <button
        v-for="cycles in cycleChoices"
        :key="cycles"
        type="button"
        role="radio"
        class="tabular h-7 min-w-8 rounded-md border px-1.5"
        :class="chipClass(set.cycles === cycles)"
        :aria-checked="set.cycles === cycles"
        @click="studio.setCycles(studio.activeSet, cycles)"
      >
        ×{{ cycles }}
      </button>
    </div>

    <p v-if="note" class="text-ink-2 truncate text-[12px]" :title="note">{{ note }}</p>
  </DeckPanel>
</template>
