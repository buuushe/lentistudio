<script setup lang="ts">
import AdjustSection from '@/components/studio/AdjustSection.vue';
import LoopSection from '@/components/studio/LoopSection.vue';
import OrderSection from '@/components/studio/OrderSection.vue';
import { useStudioStore } from '@/stores/studio';

const studio = useStudioStore();
</script>

<template>
  <div
    v-if="studio.frameCount"
    class="border-line grid shrink-0 grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-x-6 gap-y-3 border-b pb-2"
  >
    <OrderSection />
    <LoopSection />
    <AdjustSection />
  </div>
</template>
