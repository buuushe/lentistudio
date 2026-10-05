<script setup lang="ts">
import { Crosshair } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import SelectField from '@/components/ui/SelectField.vue';
import { PRESETS, type CropFraction, type Preset } from '@/lib/geometry';
import type { SelectValue } from '@/lib/select';
import { themeColor } from '@/lib/pickPainter';
import {
  canvasCrop,
  HANDLE_FRACTION,
  paintComposite,
  paintCompositeGuides,
  paintPlaceholder,
  previewCanvasSize
} from '@/lib/previewPainter';
import { frameBuffers, useStudioStore } from '@/stores/studio';
import { usePlaybackStore } from '@/stores/playback';

type Corner = 'nw' | 'ne' | 'sw' | 'se';
type Hit = { kind: 'move' } | { kind: 'resize'; corner: Corner } | null;

interface Drag {
  hit: Exclude<Hit, null>;
  x0: number;
  y0: number;
  scaleX: number;
  scaleY: number;
  areaCenter: [number, number];
  crop: CropFraction | null;
}

const { t } = useI18n();
const studio = useStudioStore();
const playback = usePlaybackStore();

const presetOptions = computed(() =>
  (Object.keys(PRESETS) as Preset[]).map((preset) => ({
    value: preset,
    label: t(`studio.output.presets.${preset}`)
  }))
);
const widthOptions = computed(() =>
  [null, 1920, 1080, 720].map((width) => ({
    value: width,
    label: width === null ? t('studio.output.original') : String(width)
  }))
);

const canvas = ref<HTMLCanvasElement | null>(null);
const hover = ref<Hit>(null);
let timer: ReturnType<typeof setInterval> | null = null;
let drag: Drag | null = null;

const layout = computed(() => studio.layout);
const pannable = computed(() => layout.value?.hasPreset ?? false);
const custom = computed(() => studio.settings.preset === 'custom');
const sizable = computed(() => studio.settings.preset !== 'free' && layout.value !== null);

const placeholder = computed(() => {
  const several = studio.setCount > 1;
  if (studio.previewIncompleteSet >= 0) {
    const set = studio.previewIncompleteSet;
    const params = { n: studio.sets[set].frames.length, max: studio.setSize, set: set + 1 };
    return t(several ? 'studio.preview.needFramesInSet' : 'studio.preview.needFrames', params);
  }
  if (studio.previewUnmarkedSet >= 0) {
    const set = studio.previewUnmarkedSet;
    const params = { n: studio.pointsInSet(set), max: studio.setSize, set: set + 1 };
    return t(several ? 'studio.preview.needPointsInSet' : 'studio.preview.needPoints', params);
  }
  return t('studio.preview.noOverlap');
});

const info = computed(() => {
  const current = layout.value;
  if (!current) return '';
  const [, , bw, bh] = current.alignment.crop;
  const [, , cw, ch] = current.crop;
  return t('studio.preview.info', {
    area: `${bw}×${bh}`,
    crop: `${cw}×${ch}`,
    out: `${current.out[0]}×${current.out[1]}`,
    frames: studio.sequence.length,
    seconds: (studio.sequence.length / studio.settings.fps).toFixed(1)
  });
});

const cursorClass = computed(() => {
  const hit = drag?.hit ?? hover.value;
  if (!hit || !pannable.value) return '';
  if (hit.kind === 'move') return drag ? 'cursor-grabbing' : 'cursor-grab';
  return hit.corner === 'nw' || hit.corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize';
});

function colors() {
  return {
    accent: themeColor('--accent', '#c8402e'),
    placeholderBackground: themeColor('--bg-2', '#efece5'),
    placeholderText: themeColor('--ink-2', '#6b6a66')
  };
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function paint(sequencePosition: number): void {
  const current = layout.value;
  const ctx = canvas.value?.getContext('2d');
  const item = studio.composites[sequencePosition];
  if (!current || !ctx || !item) return;
  const buffers = (position: number) => {
    const frameIndex = current.ordered[position]?.index;
    return frameIndex === undefined ? undefined : frameBuffers.get(frameIndex);
  };
  const style = {
    composition: studio.settings.composition,
    framesPerSet: studio.setSize,
    parallaxZoom: studio.settings.parallaxZoom
  };
  paintComposite(ctx, current, buffers, item, style, colors(), false);
  paintCompositeGuides(ctx, current, item, style, colors());
}

function fitCanvas(): boolean {
  const current = layout.value;
  if (!current || !canvas.value) return false;
  const [w, h] = previewCanvasSize(current);
  if (canvas.value.width !== w || canvas.value.height !== h) {
    canvas.value.width = w;
    canvas.value.height = h;
  }
  return true;
}

function restart(): void {
  stop();
  const ctx = canvas.value?.getContext('2d');
  if (!canvas.value || !ctx) return;
  if (!layout.value) {
    canvas.value.width = 640;
    canvas.value.height = 400;
    paintPlaceholder(ctx, placeholder.value, colors());
    return;
  }
  fitCanvas();
  const total = studio.composites.length;
  playback.frame = Math.max(0, Math.min(playback.frame, total - 1));
  repaintCurrent();
  timer = setInterval(() => {
    if (playback.playing) playback.frame = (playback.frame + 1) % total;
  }, 1000 / studio.settings.fps);
}

function repaintCurrent(): void {
  if (fitCanvas()) paint(playback.frame);
}

function canvasPoint(event: PointerEvent): { x: number; y: number; rect: DOMRect } | null {
  if (!canvas.value) return null;
  const rect = canvas.value.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.value.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.value.height;
  return { x, y, rect };
}

function hitTest(event: PointerEvent): Hit {
  const current = layout.value;
  const at = canvasPoint(event);
  if (!current || !at || !canvas.value || !pannable.value) return null;
  const W = canvas.value.width;
  const [rx, ry, rw, rh] = canvasCrop(current, W, canvas.value.height);
  const reach = Math.max(16, W * HANDLE_FRACTION * 1.5);
  const corners: [Corner, number, number][] = [
    ['nw', rx, ry],
    ['ne', rx + rw, ry],
    ['sw', rx, ry + rh],
    ['se', rx + rw, ry + rh]
  ];
  if (sizable.value) {
    for (const [corner, cx, cy] of corners) {
      if (Math.abs(at.x - cx) <= reach && Math.abs(at.y - cy) <= reach) {
        return { kind: 'resize', corner };
      }
    }
  }
  const inside = at.x >= rx && at.x <= rx + rw && at.y >= ry && at.y <= ry + rh;
  return inside ? { kind: 'move' } : null;
}

function onPointerDown(event: PointerEvent): void {
  const current = layout.value;
  const hit = hitTest(event);
  if (!current || !hit || !canvas.value) return;
  event.preventDefault();
  canvas.value.focus();
  canvas.value.setPointerCapture(event.pointerId);
  if (hit.kind === 'resize' && !custom.value) studio.startCustomCrop();
  const rect = canvas.value.getBoundingClientRect();
  const [bx, by, bw, bh] = current.alignment.crop;
  const [cx, cy, cw, ch] = current.crop;
  drag = {
    hit,
    x0: event.clientX,
    y0: event.clientY,
    scaleX: bw / rect.width,
    scaleY: bh / rect.height,
    areaCenter: [cx + cw / 2 - bx, cy + ch / 2 - by],
    crop: studio.customCrop ? { ...studio.customCrop } : null
  };
}

function resizeTo(event: PointerEvent, corner: Corner, start: CropFraction): void {
  if (!canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  const px = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  const py = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
  const fixedX = corner === 'nw' || corner === 'sw' ? start.x + start.w : start.x;
  const fixedY = corner === 'nw' || corner === 'ne' ? start.y + start.h : start.y;
  studio.setCustomCrop({
    x: Math.min(px, fixedX),
    y: Math.min(py, fixedY),
    w: Math.abs(px - fixedX),
    h: Math.abs(py - fixedY)
  });
}

function onPointerMove(event: PointerEvent): void {
  const current = layout.value;
  if (!current) return;
  if (!drag) {
    hover.value = hitTest(event);
    return;
  }
  if (drag.hit.kind === 'resize') {
    if (drag.crop) resizeTo(event, drag.hit.corner, drag.crop);
    return;
  }
  const [bx, by, bw, bh] = current.alignment.crop;
  const dx = (event.clientX - drag.x0) * drag.scaleX;
  const dy = (event.clientY - drag.y0) * drag.scaleY;
  if (custom.value && drag.crop) {
    studio.setCustomCrop({ ...drag.crop, x: drag.crop.x + dx / bw, y: drag.crop.y + dy / bh });
    return;
  }
  const nx = bx + drag.areaCenter[0] + dx;
  const ny = by + drag.areaCenter[1] + dy;
  studio.setAnchor({ x: (nx - bx) / bw, y: (ny - by) / bh });
}

function onPointerEnd(): void {
  if (drag?.hit.kind === 'resize' && !studio.customCrop) return;
  drag = null;
}

function onKeyDown(event: KeyboardEvent): void {
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
  if (custom.value && studio.customCrop && layout.value) {
    const [, , bw, bh] = layout.value.alignment.crop;
    studio.setCustomCrop({
      ...studio.customCrop,
      x: studio.customCrop.x + d[0] / bw,
      y: studio.customCrop.y + d[1] / bh
    });
    return;
  }
  studio.panAnchor(d[0], d[1]);
}

function recenter(): void {
  if (custom.value) studio.centerCustomCrop();
  else studio.resetAnchor();
}

const moved = computed(() => {
  if (custom.value) {
    const crop = studio.customCrop;
    return crop
      ? Math.abs(crop.x - (1 - crop.w) / 2) > 1e-6 || Math.abs(crop.y - (1 - crop.h) / 2) > 1e-6
      : false;
  }
  return studio.anchor !== null;
});

onMounted(restart);
onBeforeUnmount(stop);

watch(
  [
    () => studio.flatOrder.join(','),
    () => studio.seriesPointsCount,
    () => studio.sequence,
    () => studio.settings.preset,
    () => studio.settings.maxWidth,
    () => studio.settings.sharedFocus,
    () => studio.settings.fps,
    () => studio.bufferVersion,
    placeholder
  ],
  restart,
  { flush: 'post' }
);
watch(() => studio.layout, restart, { flush: 'post' });
watch(() => playback.frame, repaintCurrent, { flush: 'post' });
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="bg-bg-2 grid place-items-center rounded-sm p-1">
      <canvas
        ref="canvas"
        tabindex="0"
        class="focus-visible:outline-ink block max-h-[38vh] max-w-full rounded-sm outline-offset-2"
        :class="cursorClass"
        style="touch-action: none"
        :aria-label="t('studio.preview.label')"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerEnd"
        @pointercancel="onPointerEnd"
        @pointerleave="hover = null"
        @keydown="onKeyDown"
        @dblclick="recenter"
      />
    </div>
    <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-[13px]">
      <span class="text-ink-2">{{ t('studio.preview.format') }}</span>
      <SelectField
        :model-value="studio.settings.preset"
        :options="presetOptions"
        class="w-full"
        :label="t('studio.preview.format')"
        @update:model-value="(value: SelectValue) => studio.choosePreset(value as Preset)"
      />
      <SelectField
        v-if="studio.settings.preset === 'free' || custom"
        :model-value="studio.settings.maxWidth"
        :options="widthOptions"
        class="w-24"
        :title="t('studio.output.maxWidth')"
        :label="t('studio.output.maxWidth')"
        @update:model-value="
          (value: SelectValue) => (studio.settings.maxWidth = value as number | null)
        "
      />
    </div>
    <p v-if="info" class="text-ink-2 tabular text-[12px]">{{ info }}</p>
    <div v-if="pannable" class="flex items-center justify-between gap-2 text-[13px]">
      <span class="text-ink-2">
        {{
          custom
            ? t('studio.preview.customHint')
            : moved
              ? t('studio.preview.anchorMoved')
              : t('studio.preview.anchorCenter')
        }}
      </span>
      <button
        type="button"
        class="hover:text-ink text-ink-2 flex items-center gap-1 disabled:opacity-40"
        :disabled="!moved"
        :title="t('studio.preview.recenter')"
        @click="recenter"
      >
        <Crosshair class="h-3.5 w-3.5" />
        <span>{{ t('studio.preview.recenter') }}</span>
      </button>
    </div>
  </div>
</template>
