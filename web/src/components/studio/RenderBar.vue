<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import StatusLine from '@/components/ui/StatusLine.vue';
import { useStudioStore } from '@/stores/studio';

const { t } = useI18n();
const studio = useStudioStore();

const label = computed(() => {
  if (!studio.separate) {
    return studio.rendering ? t('studio.render.rendering') : t('studio.render.button');
  }
  const running = studio.batchRunning ? studio.batch : null;
  if (running) return t('studio.batch.rendering', { done: running.done, total: running.total });
  if (studio.rendering) return t('studio.render.rendering');
  return t('studio.batch.button', { n: studio.shownSetCount });
});

const progress = computed(() => {
  const running = studio.batchRunning ? studio.batch : null;
  return running && running.total ? running.done / running.total : null;
});
</script>

<template>
  <div class="flex flex-col gap-1 pt-1">
    <div class="flex gap-2">
      <button
        type="button"
        class="bg-accent h-11 min-w-0 flex-1 rounded-md text-[14px] font-semibold text-white disabled:opacity-40"
        :disabled="!studio.canRender"
        @click="studio.render()"
      >
        {{ label }}
      </button>
      <button
        v-if="studio.batchRunning"
        type="button"
        class="border-line hover:border-ink h-11 shrink-0 rounded-md border px-3 text-[13px]"
        @click="studio.stopBatch()"
      >
        {{ t('studio.batch.stop') }}
      </button>
      <button
        v-else-if="studio.setCount > 1"
        type="button"
        class="border-accent text-accent hover:bg-accent-soft h-11 shrink-0 rounded-md border px-3 text-[13px] font-semibold disabled:opacity-40"
        :disabled="!studio.canRenderActive"
        :title="t('studio.render.activeSetHint', { n: studio.activeSet + 1 })"
        @click="studio.renderActiveSet()"
      >
        {{ t('studio.render.activeSet', { n: studio.activeSet + 1 }) }}
      </button>
    </div>
    <div v-if="progress !== null" class="bg-line h-0.5 w-full overflow-hidden rounded-full">
      <div
        class="bg-ink h-full transition-[width] duration-300"
        :style="{ width: `${Math.round(progress * 100)}%` }"
      />
    </div>
    <StatusLine :status="studio.renderStatus" />
  </div>
</template>
