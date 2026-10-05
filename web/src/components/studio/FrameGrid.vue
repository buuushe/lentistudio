<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import FramePick from '@/components/studio/FramePick.vue';
import { useStudioStore } from '@/stores/studio';

const studio = useStudioStore();
const chosen = ref<number | null>(null);

const largePosition = computed(() => {
  const order = studio.order;
  if (chosen.value !== null && chosen.value < order.length) return chosen.value;
  const manual = order.findIndex((index) => studio.pointMeta[index]?.source === 'manual');
  return manual >= 0 ? manual : 0;
});

const compareGrid = computed(() => {
  const size = studio.setSize;
  const columns = size <= 2 ? 1 : size <= 4 ? 2 : 3;
  const rows = Math.ceil(size / columns);
  return {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
  };
});

watch(
  () => studio.activeSet,
  () => {
    chosen.value = null;
  }
);
</script>

<template>
  <div
    v-if="studio.order.length"
    class="grid min-h-0 gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
    :style="{ gridTemplateRows: 'minmax(0, 1fr)' }"
  >
    <FramePick
      :key="studio.order[largePosition]"
      :index="studio.order[largePosition]"
      :position="largePosition"
      size="large"
    />
    <div class="grid min-h-0 gap-2" :style="compareGrid">
      <FramePick
        v-for="(index, position) in studio.order"
        :key="index"
        :index="index"
        :position="position"
        size="small"
        :current="position === largePosition"
        @enlarge="chosen = position"
      />
    </div>
  </div>
</template>
