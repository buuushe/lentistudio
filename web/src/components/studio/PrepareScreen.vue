<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { useStudioStore } from '@/stores/studio';

const SHRINK_SHARE = 0.15;
const UPLOAD_SHARE = 0.6;
const GROUPING_SHARE = 0.1;

const { t } = useI18n();
const studio = useStudioStore();

const fraction = computed(() => {
  const progress = studio.prepare;
  if (!progress) return 0;
  const part = progress.total ? progress.done / progress.total : 0;
  if (progress.stage === 'shrinking') return SHRINK_SHARE * part;
  if (progress.stage === 'uploading') return SHRINK_SHARE + (UPLOAD_SHARE - SHRINK_SHARE) * part;
  if (progress.stage === 'grouping' || progress.stage === 'cutting') return UPLOAD_SHARE;
  return UPLOAD_SHARE + GROUPING_SHARE + (1 - UPLOAD_SHARE - GROUPING_SHARE) * part;
});

const stageText = computed(() => {
  const progress = studio.prepare;
  if (!progress) return '';
  return t(`studio.prepare.${progress.stage}`, { done: progress.done, total: progress.total });
});
</script>

<template>
  <div
    class="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center gap-4"
    role="status"
    aria-live="polite"
  >
    <h2 class="text-[16px] font-semibold">{{ t('studio.prepare.title') }}</h2>
    <div class="bg-line h-0.5 w-full overflow-hidden rounded-full">
      <div
        class="bg-ink h-full transition-[width] duration-300"
        :style="{ width: `${Math.round(fraction * 100)}%` }"
      />
    </div>
    <p class="text-ink-2 tabular text-[13px]">{{ stageText }}</p>
  </div>
</template>
