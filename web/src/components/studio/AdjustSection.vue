<script setup lang="ts">
import { RotateCcw, SunMoon } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AdjustRows from '@/components/studio/AdjustRows.vue';
import DeckPanel from '@/components/studio/DeckPanel.vue';
import { useStudioStore } from '@/stores/studio';

const { t } = useI18n();
const studio = useStudioStore();

const title = computed(() =>
  studio.setCount > 1
    ? `${t('studio.adjust.title')} · ${studio.activeSet + 1}`
    : t('studio.adjust.title')
);
</script>

<template>
  <DeckPanel dense :title="title" :hint="t('studio.adjust.hint')" :disabled="!studio.order.length">
    <template #actions>
      <button
        type="button"
        class="hover:bg-bg-2 grid h-7 w-7 place-items-center rounded-md disabled:opacity-40"
        :class="
          studio.adjustBalanced
            ? 'bg-accent-soft text-accent'
            : studio.balanceSuggestion
              ? 'text-warn'
              : 'text-ink-2 hover:text-ink'
        "
        :disabled="!studio.selectionComplete"
        :aria-pressed="studio.adjustBalanced"
        :title="studio.adjustBalanced ? t('studio.adjust.balanceOff') : t('studio.adjust.balance')"
        :aria-label="
          studio.adjustBalanced ? t('studio.adjust.balanceOff') : t('studio.adjust.balance')
        "
        @click="studio.toggleBalance()"
      >
        <SunMoon class="h-4 w-4" />
      </button>
      <button
        type="button"
        class="hover:bg-bg-2 grid h-7 w-7 place-items-center rounded-md disabled:opacity-40"
        :disabled="!studio.hasAdjustments"
        :title="t('studio.adjust.resetAll')"
        :aria-label="t('studio.adjust.resetAll')"
        @click="studio.resetAdjust(null)"
      >
        <RotateCcw class="h-4 w-4" />
      </button>
    </template>

    <label v-if="!studio.adjustBalanced" class="flex items-center gap-1.5 text-[13px]">
      <input
        type="checkbox"
        class="accent-accent"
        :checked="studio.adjustGrouped"
        @change="studio.setAdjustGroup(($event.target as HTMLInputElement).checked)"
      />
      <span>{{ t('studio.adjust.allFrames') }}</span>
    </label>
    <p v-if="studio.balanceSuggestion" class="text-warn truncate text-[12px]">
      {{
        t('studio.adjust.uneven', {
          frames: studio.balanceSuggestion.positions.map((p) => p + 1).join(', ')
        })
      }}
      <button type="button" class="ml-1 underline" @click="studio.applyBalance()">
        {{ t('studio.adjust.balanceNow') }}
      </button>
    </p>
    <AdjustRows
      :frame-index="null"
      :tone="studio.adjustBalanced || studio.adjustGrouped ? 'edit' : 'hidden'"
    />
    <p v-if="studio.adjustBalanced" class="text-ink-2 text-[12px]">
      {{ t('studio.adjust.balancedHint') }}
    </p>
    <p v-else-if="!studio.adjustGrouped" class="text-ink-2 text-[12px]">
      {{ t('studio.adjust.perFrameHint') }}
    </p>
  </DeckPanel>
</template>
