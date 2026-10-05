<script setup lang="ts">
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  File,
  Repeat,
  Undo2
} from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { useLoopLabel } from '@/composables/useLoopLabel';
import { useSetVisibilityTitle } from '@/composables/useSetVisibilityTitle';
import { formatPattern, loopPattern, MAX_CYCLES_PER_SET } from '@/lib/sequence';
import { useStudioStore } from '@/stores/studio';

export interface RibbonCell {
  position: number;
  pass: number | null;
  blend: boolean;
}

const props = withDefaults(
  defineProps<{ setIndex: number; ribbon: RibbonCell[]; highlight: number; mini?: boolean }>(),
  { mini: false }
);
const emit = defineEmits<{ seek: [pass: number] }>();

const { t } = useI18n();
const studio = useStudioStore();
const hideTitle = useSetVisibilityTitle();
const loopLabel = useLoopLabel();
const draggingFrame = ref<number | null>(null);
const dropFrame = ref<number | null>(null);

const MAX_LABELLED_CELLS = 16;

const set = computed(() => studio.sets[props.setIndex]);
const active = computed(() => props.setIndex === studio.activeSet);
const pattern = computed(() =>
  loopPattern(studio.setSize, set.value.loop, studio.patternOf(set.value))
);
const usedPositions = computed(() => new Set(pattern.value));
const backward = computed(() => set.value.loop === 'backward');
const seconds = computed(() => (props.ribbon.length / studio.settings.fps).toFixed(1));
const loopFrozen = computed(() => studio.sweeping && !studio.separate);
const labelled = computed(() => props.ribbon.length <= MAX_LABELLED_CELLS);

const loopGlyph = computed(() => {
  const mode = set.value.loop;
  if (mode === 'pingpong' || mode === 'pingpong_hold') return Undo2;
  if (mode === 'ends' || mode === 'middle') return ArrowLeftRight;
  if (mode === 'custom') return null;
  return Repeat;
});

const progress = computed(() =>
  props.highlight < 0 ? 0 : (props.highlight + 1) / Math.max(1, props.ribbon.length)
);

const miniTitle = computed(() =>
  [
    t('studio.sets.tab', { n: props.setIndex + 1 }),
    `${seconds.value} s`,
    `×${set.value.cycles}`,
    loopLabel(set.value.loop)
  ].join(' · ')
);

function thumbOf(index: number): string | undefined {
  const frame = studio.frames[index];
  return frame?.thumb_url ?? frame?.url;
}

function toggleLoop(): void {
  studio.setLoop(props.setIndex, set.value.loop === 'pingpong' ? 'forward' : 'pingpong');
}

function nextCycles(): void {
  studio.setCycles(props.setIndex, (set.value.cycles % MAX_CYCLES_PER_SET) + 1);
}

function onFrameDragStart(event: DragEvent, position: number): void {
  event.stopPropagation();
  draggingFrame.value = position;
  event.dataTransfer?.setData('text/plain', `frame:${props.setIndex}:${position}`);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onFrameDragOver(event: DragEvent, position: number): void {
  if (draggingFrame.value === null) return;
  event.preventDefault();
  event.stopPropagation();
  dropFrame.value = position;
}

function onFrameDrop(event: DragEvent, position: number): void {
  if (draggingFrame.value === null) return;
  event.stopPropagation();
  studio.moveFrameInSet(props.setIndex, draggingFrame.value, position);
  endFrameDrag();
}

function endFrameDrag(): void {
  draggingFrame.value = null;
  dropFrame.value = null;
}

function cellClass(cell: RibbonCell, index: number): string {
  if (index === props.highlight) return 'bg-accent text-white';
  if (cell.blend) return 'bg-line text-ink-2';
  return active.value ? 'bg-accent-soft text-ink' : 'bg-bg-2 text-ink-2';
}
</script>

<template>
  <div
    v-if="mini && set.hidden"
    class="border-line text-ink-2 flex h-full min-h-14 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-[11px]"
    :class="{ 'border-accent': active }"
    :title="hideTitle(setIndex, set)"
  >
    <button type="button" class="tabular font-semibold" @click="studio.selectSet(setIndex)">
      {{ setIndex + 1 }}
    </button>
    <button
      type="button"
      class="hover:text-ink rounded-sm disabled:opacity-40"
      :disabled="!studio.canHideSet(setIndex)"
      :aria-label="hideTitle(setIndex, set)"
      :aria-pressed="true"
      @click="studio.toggleSetHidden(setIndex)"
    >
      <EyeOff class="h-3.5 w-3.5" />
    </button>
  </div>

  <button
    v-else-if="mini"
    type="button"
    class="flex h-full w-full flex-col gap-1 rounded-md border p-1 text-left transition-colors"
    :class="active ? 'border-accent' : 'border-line hover:border-ink-2'"
    :title="miniTitle"
    :aria-label="miniTitle"
    @click="studio.selectSet(setIndex)"
  >
    <span class="flex w-full items-center gap-1 text-[11px] leading-4">
      <span class="tabular font-semibold">{{ setIndex + 1 }}</span>
      <File v-if="studio.separate" class="text-ink-2 h-3 w-3 shrink-0" aria-hidden="true" />
      <component
        :is="loopGlyph"
        v-if="loopGlyph"
        class="text-ink-2 h-3 w-3 shrink-0"
        aria-hidden="true"
      />
      <span v-if="set.cycles > 1" class="tabular text-ink-2 ml-auto">×{{ set.cycles }}</span>
    </span>
    <img
      v-if="set.frames.length"
      :src="thumbOf(set.frames[0])"
      alt=""
      draggable="false"
      loading="lazy"
      decoding="async"
      class="aspect-[3/2] w-full rounded-sm object-cover"
    />
    <span v-else class="border-line aspect-[3/2] w-full rounded-sm border border-dashed" />
    <span class="bg-line block h-1 w-full overflow-hidden rounded-full" aria-hidden="true">
      <span class="bg-accent block h-full" :style="{ width: `${Math.round(progress * 100)}%` }" />
    </span>
  </button>

  <div
    v-else-if="set.hidden"
    class="border-line text-ink-2 flex h-full min-h-14 items-center gap-2 rounded-md border border-dashed px-2 text-[12px]"
    :class="{ 'border-accent': active }"
  >
    <button type="button" class="tabular font-semibold" @click="studio.selectSet(setIndex)">
      {{ setIndex + 1 }}
    </button>
    <span class="truncate">
      {{ studio.separate ? t('studio.sets.notRendered') : t('studio.sets.hiddenState') }}
    </span>
    <button
      type="button"
      class="hover:text-ink ml-auto rounded-sm p-0.5 disabled:opacity-40"
      :disabled="!studio.canHideSet(setIndex)"
      :title="hideTitle(setIndex, set)"
      :aria-label="hideTitle(setIndex, set)"
      :aria-pressed="true"
      @click="studio.toggleSetHidden(setIndex)"
    >
      <EyeOff class="h-4 w-4" />
    </button>
  </div>

  <div
    v-else
    class="group flex h-full flex-col gap-1.5 rounded-md border p-1.5 transition-colors"
    :class="active ? 'border-accent' : 'border-line hover:border-ink-2'"
    @click="studio.selectSet(setIndex)"
  >
    <header class="flex min-w-0 items-center gap-1.5 text-[12px]">
      <button
        type="button"
        class="tabular text-[13px] font-semibold"
        :class="active ? 'text-accent' : 'text-ink'"
        :aria-pressed="active"
        :aria-label="t('studio.sets.tab', { n: setIndex + 1 })"
        @click.stop="studio.selectSet(setIndex)"
      >
        {{ setIndex + 1 }}
      </button>
      <File
        v-if="studio.separate"
        class="text-ink-2 h-3.5 w-3.5 shrink-0"
        :aria-label="t('studio.timeline.ownFile')"
      />
      <span class="text-ink-2 tabular truncate">{{ seconds }} s</span>
      <button
        type="button"
        class="border-line hover:border-ink tabular ml-auto rounded-sm border px-1.5 leading-5 disabled:opacity-40"
        :disabled="loopFrozen"
        :title="t('studio.timeline.cyclesTitle', { n: set.cycles })"
        :aria-label="t('studio.timeline.cyclesTitle', { n: set.cycles })"
        @click.stop="nextCycles"
      >
        ×{{ set.cycles }}
      </button>
      <button
        type="button"
        class="text-ink-2 hover:bg-bg-2 hover:text-ink rounded-sm p-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 disabled:opacity-40"
        :disabled="!studio.canHideSet(setIndex)"
        :title="hideTitle(setIndex, set)"
        :aria-label="hideTitle(setIndex, set)"
        :aria-pressed="false"
        @click.stop="studio.toggleSetHidden(setIndex)"
      >
        <Eye class="h-4 w-4" />
      </button>
    </header>

    <ol class="flex items-center gap-0.5" :aria-label="t('studio.order.playback')">
      <li
        v-for="(index, position) in set.frames"
        :key="index"
        class="flex min-w-0 items-center gap-0.5"
      >
        <template v-if="position > 0">
          <ChevronLeft v-if="backward" class="text-ink-2 h-3 w-3 shrink-0" aria-hidden="true" />
          <ChevronRight v-else class="text-ink-2 h-3 w-3 shrink-0" aria-hidden="true" />
        </template>
        <img
          :src="thumbOf(index)"
          alt=""
          draggable="true"
          loading="lazy"
          decoding="async"
          class="ring-line aspect-[3/2] w-9 min-w-0 cursor-grab rounded-sm object-cover ring-1"
          :class="{
            'opacity-35': !usedPositions.has(position),
            'opacity-50': draggingFrame === position,
            'ring-accent ring-2': dropFrame === position && draggingFrame !== position
          }"
          :title="`${position + 1} · ${t('studio.order.frameOnRoll', { n: index + 1 })}`"
          @dragstart="onFrameDragStart($event, position)"
          @dragover="onFrameDragOver($event, position)"
          @dragleave="dropFrame = null"
          @drop.prevent="onFrameDrop($event, position)"
          @dragend="endFrameDrag"
        />
      </li>
      <li class="ml-auto shrink-0">
        <button
          type="button"
          class="text-ink-2 hover:bg-bg-2 hover:text-ink flex h-6 min-w-6 items-center justify-center rounded-sm px-1 text-[11px] disabled:opacity-40"
          :disabled="loopFrozen"
          :title="loopLabel(set.loop)"
          :aria-label="t('studio.timeline.toggleLoop')"
          @click.stop="toggleLoop"
        >
          <component :is="loopGlyph" v-if="loopGlyph" class="h-3.5 w-3.5" />
          <span v-else class="tabular">{{ formatPattern(pattern) }}</span>
        </button>
      </li>
    </ol>

    <div class="flex h-4 gap-px overflow-hidden rounded-sm" role="presentation">
      <button
        v-for="(cell, k) in ribbon"
        :key="k"
        type="button"
        class="tabular min-w-0 flex-1 text-[11px] leading-4 disabled:cursor-default"
        :class="cellClass(cell, k)"
        :disabled="cell.pass === null"
        :tabindex="-1"
        :title="t('studio.timeline.seek', { n: cell.position + 1 })"
        @click.stop="cell.pass !== null && emit('seek', cell.pass)"
      >
        {{ labelled ? cell.position + 1 : '' }}
      </button>
    </div>
  </div>
</template>
