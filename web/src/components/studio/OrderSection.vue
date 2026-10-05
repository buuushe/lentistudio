<script setup lang="ts">
import { ArrowLeftRight, ChevronRight, RotateCw } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import DeckPanel from '@/components/studio/DeckPanel.vue';
import SelectField from '@/components/ui/SelectField.vue';
import StatusLine from '@/components/ui/StatusLine.vue';
import type { SelectValue } from '@/lib/select';
import { useStudioStore } from '@/stores/studio';

const { t } = useI18n();
const studio = useStudioStore();

const title = computed(() =>
  studio.setCount > 1
    ? `${t('studio.order.title')} · ${studio.activeSet + 1}`
    : t('studio.order.title')
);

type DirectionPlan = 'forward' | 'backward' | 'alternate' | 'random';
const DIRECTION_PLANS: DirectionPlan[] = ['forward', 'backward', 'alternate', 'random'];
const planLabels: Record<DirectionPlan, string> = {
  forward: 'studio.order.allForward',
  backward: 'studio.order.allBackward',
  alternate: 'studio.order.alternate',
  random: 'studio.order.random'
};
const planOptions = computed(() =>
  DIRECTION_PLANS.map((plan) => ({ value: plan, label: t(planLabels[plan]) }))
);

function applyPlan(value: SelectValue): void {
  studio.setAllDirections(value as DirectionPlan);
}

const matchPercent = computed(() => {
  const progress = studio.matchProgress;
  return progress && progress.total ? Math.round((100 * progress.done) / progress.total) : 0;
});

const dragging = ref<number | null>(null);
const dropTarget = ref<number | null>(null);

function directionClass(direction: 'forward' | 'backward'): string {
  return studio.orderDirection === direction
    ? 'border-accent text-accent bg-accent-soft'
    : 'border-line text-ink-2 hover:border-ink hover:text-ink';
}

function thumbOf(index: number): string | undefined {
  const frame = studio.frames[index];
  return frame?.thumb_url ?? frame?.url;
}

function onDragStart(event: DragEvent, position: number): void {
  dragging.value = position;
  event.dataTransfer?.setData('text/plain', String(position));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragOver(event: DragEvent, position: number): void {
  if (dragging.value === null) return;
  event.preventDefault();
  dropTarget.value = position;
}

function onDrop(position: number): void {
  if (dragging.value !== null) studio.moveFrame(dragging.value, position);
  endDrag();
}

function endDrag(): void {
  dragging.value = null;
  dropTarget.value = null;
}
</script>

<template>
  <DeckPanel
    dense
    :title="title"
    :hint="t('studio.order.hint')"
    :disabled="!studio.selectionComplete"
  >
    <template #actions>
      <button
        type="button"
        class="hover:bg-bg-2 grid h-7 w-7 place-items-center rounded-md disabled:opacity-40"
        :disabled="!studio.selectionComplete || studio.detectingOrder"
        :title="t('studio.order.detect')"
        :aria-label="t('studio.order.detect')"
        @click="studio.detectOrder()"
      >
        <RotateCw class="h-4 w-4" :class="{ 'animate-spin': studio.detectingOrder }" />
      </button>
      <button
        type="button"
        class="hover:bg-bg-2 grid h-7 w-7 place-items-center rounded-md disabled:opacity-40"
        :disabled="!studio.order.length"
        :title="t('studio.order.reverse')"
        :aria-label="t('studio.order.reverse')"
        @click="studio.reverseOrder()"
      >
        <ArrowLeftRight class="h-4 w-4" />
      </button>
    </template>

    <ol
      v-if="studio.order.length"
      class="flex items-center gap-0.5"
      :aria-label="t('studio.order.playback')"
    >
      <li v-for="(index, position) in studio.order" :key="index" class="flex items-center gap-0.5">
        <ChevronRight
          v-if="position > 0"
          class="text-ink-2 h-3.5 w-3.5 shrink-0"
          aria-hidden="true"
        />
        <img
          :src="thumbOf(index)"
          alt=""
          draggable="true"
          loading="lazy"
          decoding="async"
          class="ring-line aspect-[3/2] w-10 cursor-grab rounded-sm object-cover ring-1"
          :class="{
            'opacity-40': dragging === position,
            'ring-accent ring-2':
              dropTarget === position && dragging !== null && dragging !== position
          }"
          :title="`${t('studio.order.frameOnRoll', { n: index + 1 })} · ${studio.frames[index]?.name ?? ''}`"
          @dragstart="onDragStart($event, position)"
          @dragover="onDragOver($event, position)"
          @dragleave="dropTarget = null"
          @drop.prevent="onDrop(position)"
          @dragend="endDrag"
        />
      </li>
      <li v-if="studio.suggestedOrder" class="ml-1">
        <button
          type="button"
          class="border-accent text-accent rounded-md border px-2 py-0.5 text-[12px]"
          @click="studio.applySuggestedOrder()"
        >
          {{ t('studio.order.apply') }}
        </button>
      </li>
    </ol>

    <div class="flex flex-wrap items-center gap-1 text-[12px]">
      <div class="flex" role="radiogroup" :aria-label="t('studio.order.direction')">
        <button
          type="button"
          role="radio"
          class="h-7 rounded-l-md border px-2 disabled:opacity-40"
          :class="directionClass('forward')"
          :disabled="!studio.order.length"
          :aria-checked="studio.orderDirection === 'forward'"
          @click="studio.setOrderDirection('forward')"
        >
          {{ t('studio.order.leftToRight') }}
        </button>
        <button
          type="button"
          role="radio"
          class="-ml-px h-7 rounded-r-md border px-2 disabled:opacity-40"
          :class="directionClass('backward')"
          :disabled="!studio.order.length"
          :aria-checked="studio.orderDirection === 'backward'"
          @click="studio.setOrderDirection('backward')"
        >
          {{ t('studio.order.rightToLeft') }}
        </button>
      </div>
      <SelectField
        v-if="studio.setCount > 1"
        size="sm"
        :model-value="null"
        :options="planOptions"
        :placeholder="t('studio.order.allSets')"
        :label="t('studio.order.allSets')"
        @update:model-value="applyPlan"
      />
    </div>

    <div
      v-if="studio.matchProgress"
      class="bg-line mt-1.5 h-0.5 w-full overflow-hidden rounded-full"
      role="progressbar"
      :aria-valuenow="studio.matchProgress.done"
      :aria-valuemax="studio.matchProgress.total"
    >
      <div
        class="bg-ink h-full transition-[width] duration-300"
        :style="{ width: `${matchPercent}%` }"
      />
    </div>
    <StatusLine
      v-else
      :status="studio.orderStatus ?? studio.matchStatus"
      class="truncate text-[12px]"
    />
  </DeckPanel>
</template>
