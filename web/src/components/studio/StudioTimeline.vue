<script setup lang="ts">
import { Film, Pause, Play, Scissors } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import OutputModeSwitch from '@/components/studio/OutputModeSwitch.vue';
import TimelineClip, { type RibbonCell } from '@/components/studio/TimelineClip.vue';
import SelectField from '@/components/ui/SelectField.vue';
import type { SelectValue } from '@/lib/select';
import {
  DWELL_PRESETS,
  loopPattern,
  TIMELINE_SET_MODES,
  type DwellPreset,
  type SetLoopMode
} from '@/lib/sequence';
import { usePlaybackStore } from '@/stores/playback';
import { useStudioStore, type FrameSet } from '@/stores/studio';

const emit = defineEmits<{ interact: []; openLayout: [] }>();

const { t } = useI18n();
const studio = useStudioStore();
const playback = usePlaybackStore();
const draggingSet = ref<number | null>(null);
const dropSet = ref<number | null>(null);

const CLIP_BASIS_PX = 188;
const HIDDEN_CLIP_PX = 112;
const MINI_CLIP_PX = 64;
const ACTIVE_CLIP_PX = 280;
const ACTIVE_CLIP_MAX_PX = 560;
const CLIP_GAP_PX = 8;

const strip = ref<HTMLElement | null>(null);
const stripWidth = ref(0);
let stripObserver: ResizeObserver | null = null;

onMounted(() => {
  stripObserver = new ResizeObserver(([entry]) => {
    stripWidth.value = entry.contentRect.width;
  });
  if (strip.value) stripObserver.observe(strip.value);
});
onBeforeUnmount(() => stripObserver?.disconnect());

const passLength = computed(() => Math.max(1, studio.pass.length));
const passCount = computed(() =>
  Math.max(1, Math.round(studio.composites.length / passLength.value))
);
const currentCell = computed(() => playback.frame % passLength.value);
const duration = computed(() => studio.composites.length / studio.settings.fps);

const composing = computed(() => !studio.separate && studio.animatedSetCount > 1);
const showSetOrder = computed(() => composing.value && !studio.synced);
const showPresets = computed(() => showSetOrder.value && !studio.sweeping);

const setModeOptions = computed(() =>
  TIMELINE_SET_MODES.map((mode) => ({ value: mode, label: t(`studio.output.setModes.${mode}`) }))
);
const presetOptions = computed(() =>
  DWELL_PRESETS.map((preset) => ({ value: preset, label: t(`studio.timeline.presets.${preset}`) }))
);

interface LiveClip {
  ribbon: RibbonCell[];
  highlight: number;
}

function toCells(passes: number[]): RibbonCell[] {
  return passes.map((pass) => {
    const item = studio.pass[pass];
    return { position: item.a % studio.setSize, pass, blend: item.b !== null };
  });
}

function liveClip(animatedIndex: number): LiveClip {
  const visits = studio.clipVisits[animatedIndex] ?? [];
  if (studio.sweeping && !studio.separate) {
    const passes = visits.flatMap((visit) => visit.cells);
    return { ribbon: toCells(passes), highlight: passes.indexOf(currentCell.value) };
  }
  const shown = visits[0]?.cells ?? [];
  const playing = visits.find((visit) => visit.cells.includes(currentCell.value));
  if (!playing) return { ribbon: toCells(shown), highlight: -1 };
  const step = playing.cells.indexOf(currentCell.value);
  const highlight = playing.returning ? shown.length - 1 - step : step;
  return { ribbon: toCells(shown), highlight: Math.min(shown.length - 1, Math.max(0, highlight)) };
}

function ownRibbon(set: FrameSet): RibbonCell[] {
  const once = loopPattern(studio.setSize, set.loop, studio.patternOf(set));
  return Array.from({ length: set.cycles }, () => once)
    .flat()
    .map((position) => ({ position, pass: null, blend: false }));
}

const clips = computed(() =>
  studio.sets.map((set, setIndex) => {
    const animatedIndex = studio.animatedSets.indexOf(set);
    const live =
      animatedIndex >= 0 ? liveClip(animatedIndex) : { ribbon: ownRibbon(set), highlight: -1 };
    return {
      setIndex,
      ribbon: live.ribbon,
      highlight: live.highlight,
      weight: set.hidden ? 0 : Math.max(1, live.ribbon.length)
    };
  })
);

const compact = computed(() => {
  if (!stripWidth.value) return false;
  const needed = clips.value.reduce(
    (sum, clip) => sum + (clip.weight ? CLIP_BASIS_PX : HIDDEN_CLIP_PX) + CLIP_GAP_PX,
    -CLIP_GAP_PX
  );
  return needed > stripWidth.value;
});

function isMini(setIndex: number): boolean {
  return compact.value && setIndex !== studio.activeSet;
}

function clipStyle(setIndex: number, weight: number): Record<string, string> {
  if (isMini(setIndex)) return { flex: `0 0 ${MINI_CLIP_PX}px` };
  if (compact.value)
    return { flex: `1 1 ${ACTIVE_CLIP_PX}px`, maxWidth: `${ACTIVE_CLIP_MAX_PX}px` };
  return weight
    ? { flex: `${weight} 1 ${CLIP_BASIS_PX}px` }
    : { flex: '0 0 auto', minWidth: `${HIDDEN_CLIP_PX}px` };
}

function togglePlay(): void {
  playback.playing = !playback.playing;
  emit('interact');
}

function seek(pass: number): void {
  const base = playback.frame - currentCell.value;
  playback.seek(base + pass, studio.composites.length);
  emit('interact');
}

function chooseSetMode(value: SelectValue): void {
  studio.settings.setMode = value as SetLoopMode;
}

function choosePreset(value: SelectValue): void {
  studio.applyDwellPreset(value as DwellPreset);
}

function onDragStart(event: DragEvent, setIndex: number): void {
  draggingSet.value = setIndex;
  event.dataTransfer?.setData('text/plain', `set:${setIndex}`);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragOver(event: DragEvent, setIndex: number): void {
  if (draggingSet.value === null) return;
  event.preventDefault();
  dropSet.value = setIndex;
}

function onDrop(setIndex: number): void {
  if (draggingSet.value !== null) studio.moveSet(draggingSet.value, setIndex);
  endDrag();
}

function endDrag(): void {
  draggingSet.value = null;
  dropSet.value = null;
}
</script>

<template>
  <section
    v-if="studio.frameCount"
    class="border-line flex min-w-0 shrink-0 flex-col gap-2 border-b pb-3 text-[13px]"
    :aria-label="t('studio.timeline.title')"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <button
        type="button"
        class="border-line hover:bg-bg-2 grid h-9 w-9 shrink-0 place-items-center rounded-md border"
        :aria-label="t('studio.timeline.playPause')"
        @click="togglePlay"
      >
        <Pause v-if="playback.playing" class="h-4 w-4" />
        <Play v-else class="h-4 w-4" />
      </button>
      <output class="tabular flex items-baseline gap-1.5">
        <span class="text-[15px] font-semibold">
          {{ (playback.frame / studio.settings.fps).toFixed(1) }}
        </span>
        <span class="text-ink-2 text-[12px]">/ {{ duration.toFixed(1) }} s</span>
        <span v-if="passCount > 1" class="text-ink-2 text-[12px]">
          · {{ t('studio.timeline.passes', { n: passCount }) }}
        </span>
      </output>

      <label v-if="showSetOrder" class="flex items-center gap-2">
        <span class="text-ink-2">{{ t('studio.output.sets') }}</span>
        <SelectField
          size="sm"
          :model-value="studio.settings.setMode"
          :options="setModeOptions"
          :label="t('studio.output.setOrder')"
          @update:model-value="chooseSetMode"
        />
      </label>
      <label v-if="showPresets" class="flex items-center gap-2">
        <span class="text-ink-2">{{ t('studio.timeline.repeats') }}</span>
        <SelectField
          size="sm"
          :model-value="null"
          :options="presetOptions"
          :placeholder="t('studio.timeline.presetPlaceholder')"
          :label="t('studio.timeline.repeats')"
          @update:model-value="choosePreset"
        />
      </label>

      <span class="ml-auto flex flex-wrap items-center gap-2">
        <OutputModeSwitch v-if="studio.setCount > 1" />
        <button
          v-if="studio.scans.length"
          type="button"
          class="border-line hover:border-ink flex h-10 shrink-0 items-center gap-2 rounded-md border px-3"
          :title="t('studio.cut.recut')"
          @click="studio.openCutting()"
        >
          <Scissors class="h-4 w-4" />
          <span class="tabular">{{ studio.scans.length }}</span>
        </button>
        <button
          type="button"
          class="border-line hover:border-ink flex h-10 shrink-0 items-center gap-2 rounded-md border px-3"
          @click="emit('openLayout')"
        >
          <Film class="h-4 w-4" />
          <span>{{ t('studio.scenes.layout') }}</span>
          <span class="text-ink-2 tabular">{{ studio.frameCount }}</span>
        </button>
      </span>
    </div>

    <ul
      ref="strip"
      class="flex max-h-[40vh] flex-wrap gap-2 overflow-y-auto pr-1"
      :aria-label="t('studio.sets.title')"
    >
      <li
        v-for="clip in clips"
        :key="clip.setIndex"
        class="min-w-0"
        :class="{
          'opacity-40': draggingSet === clip.setIndex,
          'outline-accent rounded-md outline outline-2 outline-offset-1':
            dropSet === clip.setIndex && draggingSet !== null && draggingSet !== clip.setIndex,
          'cursor-grab': studio.setCount > 1
        }"
        :style="clipStyle(clip.setIndex, clip.weight)"
        :draggable="studio.setCount > 1"
        @dragstart="onDragStart($event, clip.setIndex)"
        @dragover="onDragOver($event, clip.setIndex)"
        @dragleave="dropSet = null"
        @drop.prevent="onDrop(clip.setIndex)"
        @dragend="endDrag"
      >
        <TimelineClip
          :set-index="clip.setIndex"
          :ribbon="clip.ribbon"
          :highlight="clip.highlight"
          :mini="isMini(clip.setIndex)"
          @seek="seek"
        />
      </li>
    </ul>
  </section>
</template>
