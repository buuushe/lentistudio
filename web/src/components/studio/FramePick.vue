<script setup lang="ts">
import { Maximize, ZoomIn, ZoomOut } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import AdjustRows from '@/components/studio/AdjustRows.vue';
import type { Point } from '@/lib/geometry';
import {
  LOUPE_SIZE,
  loupePosition,
  paintFrame,
  paintLoupe,
  pointerToImage,
  themeColor
} from '@/lib/pickPainter';
import { frameBuffers, LOW_CONFIDENCE, useStudioStore } from '@/stores/studio';

const props = withDefaults(
  defineProps<{
    index: number;
    position: number;
    size?: 'large' | 'small';
    current?: boolean;
  }>(),
  { size: 'large', current: false }
);
const emit = defineEmits<{ enlarge: [] }>();

const { t } = useI18n();
const studio = useStudioStore();

const host = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const loupe = ref<HTMLCanvasElement | null>(null);
const loupeStyle = ref<{ left: string; top: string } | null>(null);

let dragging = false;
let moved = false;
let keyTimer: ReturnType<typeof setTimeout> | null = null;

const frame = computed(() => studio.frames[props.index]);
const point = computed(() => studio.points[props.index]);
const meta = computed(() => studio.pointMeta[props.index]);
const isAuto = computed(() => meta.value?.source !== 'manual');
const isCenter = computed(() => meta.value?.source === 'center');
const lowConfidence = computed(
  () => isAuto.value && !isCenter.value && (meta.value?.score ?? 1) < LOW_CONFIDENCE
);

const sourceLabel = computed(() => {
  if (!point.value) return t('studio.focus.noPoint');
  if (isCenter.value) return t('studio.focus.srcCenter');
  if (isAuto.value)
    return t('studio.focus.srcAuto', { score: (meta.value?.score ?? 0).toFixed(2) });
  return t('studio.focus.srcManual');
});

const large = computed(() => props.size === 'large');

const SMALL_ZOOM = 2.5;
const ZOOM_STEP = 1.25;
const MAX_ZOOM = 6;
const zoom = ref(1);

const zoomOrigin = computed(() => {
  if (!point.value || !frame.value) return '50% 50%';
  const x = (point.value.x / frame.value.width) * 100;
  const y = (point.value.y / frame.value.height) * 100;
  return `${x}% ${y}%`;
});

const zoomStyle = computed(() => ({
  transform: `scale(${zoom.value})`,
  transformOrigin: zoomOrigin.value
}));

function setZoom(next: number): void {
  zoom.value = Math.min(MAX_ZOOM, Math.max(1, next));
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  setZoom(zoom.value * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
}

const dotClass = computed(() => {
  if (!point.value) return 'bg-line';
  if (lowConfidence.value) return 'bg-err';
  if (isCenter.value) return 'bg-ink-2';
  return isAuto.value ? 'bg-warn' : 'bg-accent';
});

function colors() {
  return {
    manual: themeColor('--accent', '#c8402e'),
    auto: themeColor('--warn', '#b8862b'),
    ring: '#ffffff'
  };
}

function draw(): void {
  const buffer = frameBuffers.get(props.index);
  const ctx = canvas.value?.getContext('2d');
  if (!buffer || !ctx || !canvas.value) return;
  paintFrame(
    ctx,
    buffer,
    point.value,
    isAuto.value,
    colors(),
    large.value ? 1 : SMALL_ZOOM,
    !large.value
  );
}

function toImage(event: PointerEvent): Point | null {
  if (!canvas.value || !frame.value) return null;
  return pointerToImage(
    event,
    canvas.value.getBoundingClientRect(),
    frame.value.width,
    frame.value.height
  );
}

function showLoupe(at: Point, event: PointerEvent): void {
  const buffer = frameBuffers.get(props.index);
  const ctx = loupe.value?.getContext('2d');
  if (!buffer || !ctx || !host.value || !canvas.value || !frame.value) return;
  const screenScale = canvas.value.getBoundingClientRect().width / frame.value.width;
  paintLoupe(ctx, buffer.image, at, colors().manual, screenScale);
  const rect = host.value.getBoundingClientRect();
  const { left, top } = loupePosition(
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
    { width: rect.width, height: rect.height }
  );
  loupeStyle.value = { left: `${left}px`, top: `${top}px` };
}

function hideLoupe(): void {
  loupeStyle.value = null;
}

function place(next: Point): void {
  studio.setPoint(props.index, next);
  moved = true;
}

function finishManual(): void {
  if (moved) studio.afterManualPoint(props.index);
  moved = false;
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  canvas.value?.focus();
  canvas.value?.setPointerCapture(event.pointerId);
  dragging = true;
  const at = toImage(event);
  if (!at) return;
  place(at);
  if (event.pointerType === 'mouse') showLoupe(at, event);
}

function onPointerMove(event: PointerEvent): void {
  const at = toImage(event);
  if (!at) return;
  if (dragging) place(at);
  if (event.pointerType === 'mouse') showLoupe(dragging ? (point.value ?? at) : at, event);
}

function onPointerEnd(): void {
  const was = dragging;
  dragging = false;
  hideLoupe();
  if (was) finishManual();
}

function onPointerLeave(): void {
  if (!dragging) hideLoupe();
}

function onKeyDown(event: KeyboardEvent): void {
  const current = point.value;
  if (!current) return;
  const step = event.shiftKey ? 10 : 1;
  const delta: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step]
  };
  const d = delta[event.key];
  if (!d) return;
  event.preventDefault();
  studio.nudgePoint(props.index, d[0], d[1]);
  moved = true;
  if (keyTimer) clearTimeout(keyTimer);
  keyTimer = setTimeout(finishManual, 400);
}

onMounted(draw);
onBeforeUnmount(() => {
  if (keyTimer) clearTimeout(keyTimer);
});
watch([point, isAuto, () => studio.bufferVersion], draw, { flush: 'post', deep: true });
</script>

<template>
  <div ref="host" class="relative flex min-h-0 min-w-0 flex-col gap-1">
    <div class="text-ink-2 flex items-center gap-1.5 text-[12px] whitespace-nowrap">
      <span class="text-ink tabular font-semibold">{{ position + 1 }}</span>
      <span
        class="h-2 w-2 rounded-full"
        :class="dotClass"
        :title="lowConfidence ? t('studio.focus.lowConfidence') : sourceLabel"
        role="img"
        :aria-label="sourceLabel"
      />
      <span v-if="large" class="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          class="hover:bg-bg-2 hover:text-ink rounded-md p-0.5 disabled:opacity-40"
          :disabled="zoom <= 1"
          :title="t('studio.focus.zoomOut')"
          :aria-label="t('studio.focus.zoomOut')"
          @click="setZoom(zoom / ZOOM_STEP)"
        >
          <ZoomOut class="h-3.5 w-3.5" />
        </button>
        <span class="tabular w-8 text-center text-[11px]">{{ zoom.toFixed(1) }}×</span>
        <button
          type="button"
          class="hover:bg-bg-2 hover:text-ink rounded-md p-0.5 disabled:opacity-40"
          :disabled="zoom >= MAX_ZOOM"
          :title="t('studio.focus.zoomIn')"
          :aria-label="t('studio.focus.zoomIn')"
          @click="setZoom(zoom * ZOOM_STEP)"
        >
          <ZoomIn class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          class="hover:bg-bg-2 hover:text-ink rounded-md p-0.5 disabled:opacity-40"
          :disabled="zoom <= 1"
          :title="t('studio.focus.zoomFit')"
          :aria-label="t('studio.focus.zoomFit')"
          @click="setZoom(1)"
        >
          <Maximize class="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
    <div
      v-if="large"
      class="flex min-h-0 flex-1 items-start justify-center overflow-hidden rounded-sm"
      @wheel="onWheel"
    >
      <canvas
        ref="canvas"
        tabindex="0"
        class="focus-visible:outline-ink block max-h-full max-w-full cursor-crosshair rounded-sm bg-bg-2 outline-offset-2 select-none"
        :style="zoomStyle"
        style="touch-action: none; width: auto; height: auto"
        :aria-label="t('studio.focus.canvasLabel', { n: position + 1 })"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerEnd"
        @pointercancel="onPointerEnd"
        @pointerleave="onPointerLeave"
        @keydown="onKeyDown"
      />
    </div>
    <button
      v-else
      type="button"
      class="focus-visible:outline-ink flex min-h-0 flex-1 items-start rounded-sm outline-offset-2"
      :class="current ? 'ring-accent ring-2' : ''"
      :aria-pressed="current"
      :title="t('studio.focus.showLarge', { n: position + 1, zoom: SMALL_ZOOM })"
      :aria-label="t('studio.focus.showLarge', { n: position + 1, zoom: SMALL_ZOOM })"
      @click="emit('enlarge')"
    >
      <canvas
        ref="canvas"
        class="block max-h-full max-w-full rounded-sm bg-bg-2 opacity-90 hover:opacity-100"
        style="width: auto; height: auto"
      />
    </button>
    <canvas
      ref="loupe"
      :width="LOUPE_SIZE"
      :height="LOUPE_SIZE"
      class="border-accent pointer-events-none absolute rounded-full border-2 bg-black"
      :class="{ hidden: !loupeStyle }"
      :style="loupeStyle ?? undefined"
    />
    <div
      v-if="large && !studio.adjustGrouped && !studio.adjustBalanced"
      class="border-line mt-1 flex flex-col gap-1 border-t pt-2"
    >
      <div class="text-ink-2 flex items-center justify-between text-[11px]">
        <span>{{ t('studio.adjust.title') }}</span>
        <button
          type="button"
          class="hover:text-ink px-1"
          :title="t('studio.adjust.resetFrame')"
          :aria-label="t('studio.adjust.resetFrame')"
          @click="studio.resetAdjust(index)"
        >
          ↺
        </button>
      </div>
      <AdjustRows :frame-index="index" :sharpen="false" />
    </div>
  </div>
</template>
