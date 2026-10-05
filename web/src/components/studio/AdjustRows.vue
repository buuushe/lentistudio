<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import RangeRow from '@/components/ui/RangeRow.vue';
import StepperRow from '@/components/ui/StepperRow.vue';
import { ADJUST_RANGE, SHARPEN_MAX, type Adjust } from '@/lib/adjust';
import { useStudioStore } from '@/stores/studio';

const props = withDefaults(
  defineProps<{
    frameIndex: number | null;
    tone?: 'edit' | 'hidden';
    sharpen?: boolean;
  }>(),
  { tone: 'edit', sharpen: true }
);

const { t } = useI18n();
const studio = useStudioStore();

const values = computed<Adjust>(() =>
  props.frameIndex === null ? studio.sharedAdjust : studio.adjustFor(props.frameIndex)
);

function update(key: keyof Adjust, value: number): void {
  studio.setAdjust(props.frameIndex, key, value);
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <template v-if="tone !== 'hidden'">
      <RangeRow
        :label="t('studio.adjust.brightness')"
        :model-value="values.brightness"
        :min="-ADJUST_RANGE"
        :max="ADJUST_RANGE"
        :reset-title="t('studio.adjust.dblclickReset')"
        @update:model-value="update('brightness', $event)"
      />
      <RangeRow
        :label="t('studio.adjust.contrast')"
        :model-value="values.contrast"
        :min="-ADJUST_RANGE"
        :max="ADJUST_RANGE"
        :reset-title="t('studio.adjust.dblclickReset')"
        @update:model-value="update('contrast', $event)"
      />
    </template>
    <StepperRow
      v-if="sharpen"
      :label="t('studio.adjust.sharpen')"
      :model-value="values.sharpen"
      :min="0"
      :max="SHARPEN_MAX"
      :less-label="t('studio.adjust.less')"
      :more-label="t('studio.adjust.more')"
      @update:model-value="update('sharpen', $event)"
    />
  </div>
</template>
