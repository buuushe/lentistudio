<script setup lang="ts">
import { ArrowLeft, Columns2, Copy, Rows2, Scissors } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import ScanModePicker from '@/components/studio/ScanModePicker.vue';
import StatusLine from '@/components/ui/StatusLine.vue';
import type { CropFraction } from '@/lib/geometry';
import {
  type BoxHandle,
  dividerBands,
  type EdgeSide,
  framePixelSize,
  gapFromEdge,
  maxGapFor,
  movedSplit,
  resizedSplit,
  type ScanMode,
  type ScanSplit,
  type SplitAxis,
  splitFrames,
  type SplitScope
} from '@/lib/scanSplit';
import { useStudioStore } from '@/stores/studio';

type Hit =
  | { kind: 'handle'; handle: BoxHandle }
  | { kind: 'gap'; divider: number; side: EdgeSide }
  | { kind: 'move' }
  | null;

interface Drag {
  hit: NonNullable<Hit>;
  start: ScanSplit;
  x0: number;
  y0: number;
}

const HANDLE_REACH = 10;
const HANDLE_SIZE = 8;
const MIN_BAND = 12;
const GAP_SLIDER_STEPS = 1000;

const { t } = useI18n();
const studio = useStudioStore();

const host = ref<HTMLDivElement | null>(null);
const overlay = ref<SVGSVGElement | null>(null);
const hostSize = ref({ width: 0, height: 0 });
const hover = ref<Hit>(null);
let drag: Drag | null = null;
let observer: ResizeObserver | null = null;

const scan = computed(() => studio.scans[studio.currentScan] ?? studio.scans[0]);
const split = computed(() => studio.split);
const frames = computed(() => (split.value ? splitFrames(split.value) : []));
const modes = computed<ScanMode[]>(() => [2, 3, 4]);
const cutCount = computed(() => studio.scans.length * (split.value?.count ?? 0));
const frameSize = computed(() =>
  split.value && scan.value ? framePixelSize(split.value, scan.value) : null
);
const gapMax = computed(() => (split.value ? maxGapFor(split.value) : 0));
const gapValue = computed(() =>
  split.value && gapMax.value > 0
    ? Math.round((split.value.gap / gapMax.value) * GAP_SLIDER_STEPS)
    : 0
);

const view = computed(() => {
  const current = scan.value;
  const { width, height } = hostSize.value;
  if (!current?.width || !current.height || !width || !height) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(width / current.width, height / current.height);
  const fitWidth = current.width * scale;
  const fitHeight = current.height * scale;
  return {
    left: (width - fitWidth) / 2,
    top: (height - fitHeight) / 2,
    width: fitWidth,
    height: fitHeight
  };
});

function measure(): void {
  const el = host.value;
  if (el) hostSize.value = { width: el.clientWidth, height: el.clientHeight };
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver(measure);
  if (host.value) observer.observe(host.value);
});
onBeforeUnmount(() => observer?.disconnect());

const px = (fraction: number, axis: SplitAxis): number =>
  fraction * (axis === 'x' ? view.value.width : view.value.height);

const dimPath = computed(() => {
  const { width, height } = view.value;
  const outer = `M0 0H${width}V${height}H0Z`;
  const holes = frames.value
    .map((f) => {
      const x = px(f.x, 'x');
      const y = px(f.y, 'y');
      return `M${x} ${y}h${px(f.w, 'x')}v${px(f.h, 'y')}h${-px(f.w, 'x')}Z`;
    })
    .join('');
  return outer + holes;
});

interface HandlePoint {
  handle: BoxHandle;
  x: number;
  y: number;
}

const handles = computed<HandlePoint[]>(() => {
  const current = split.value;
  if (!current) return [];
  const { x, y, w, h } = current.box;
  const left = px(x, 'x');
  const right = px(x + w, 'x');
  const top = px(y, 'y');
  const bottom = px(y + h, 'y');
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  return [
    { handle: 'nw', x: left, y: top },
    { handle: 'n', x: midX, y: top },
    { handle: 'ne', x: right, y: top },
    { handle: 'e', x: right, y: midY },
    { handle: 'se', x: right, y: bottom },
    { handle: 's', x: midX, y: bottom },
    { handle: 'sw', x: left, y: bottom },
    { handle: 'w', x: left, y: midY }
  ];
});

function toFraction(event: PointerEvent): { x: number; y: number } | null {
  const svg = overlay.value;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  };
}

function hitTest(event: PointerEvent): Hit {
  const current = split.value;
  const at = toFraction(event);
  if (!current || !at) return null;
  const atX = px(at.x, 'x');
  const atY = px(at.y, 'y');
  for (const point of handles.value) {
    if (Math.abs(point.x - atX) <= HANDLE_REACH && Math.abs(point.y - atY) <= HANDLE_REACH) {
      return { kind: 'handle', handle: point.handle };
    }
  }
  const along = current.axis === 'x' ? atX : atY;
  const across = current.axis === 'x' ? at.y : at.x;
  const acrossInside =
    current.axis === 'x'
      ? across >= current.box.y && across <= current.box.y + current.box.h
      : across >= current.box.x && across <= current.box.x + current.box.w;
  if (acrossInside) {
    const bands = dividerBands(current);
    for (const [divider, band] of bands.entries()) {
      const from = px(band.from, current.axis);
      const to = px(band.to, current.axis);
      const centre = (from + to) / 2;
      const half = Math.max((to - from) / 2, MIN_BAND / 2);
      if (along >= centre - half && along <= centre + half) {
        return { kind: 'gap', divider, side: along < centre ? 'end' : 'start' };
      }
    }
  }
  const { x, y, w, h } = current.box;
  const inside = at.x >= x && at.x <= x + w && at.y >= y && at.y <= y + h;
  return inside ? { kind: 'move' } : null;
}

const cursorClass = computed(() => {
  const hit = drag?.hit ?? hover.value;
  const current = split.value;
  if (!hit || !current) return '';
  if (hit.kind === 'move') return drag ? 'cursor-grabbing' : 'cursor-grab';
  if (hit.kind === 'gap') return current.axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize';
  const diagonal: Record<BoxHandle, string> = {
    n: 'cursor-ns-resize',
    s: 'cursor-ns-resize',
    e: 'cursor-ew-resize',
    w: 'cursor-ew-resize',
    nw: 'cursor-nwse-resize',
    se: 'cursor-nwse-resize',
    ne: 'cursor-nesw-resize',
    sw: 'cursor-nesw-resize'
  };
  return diagonal[hit.handle];
});

function onPointerDown(event: PointerEvent): void {
  const current = split.value;
  const hit = hitTest(event);
  const at = toFraction(event);
  if (!current || !hit || !at || !overlay.value) return;
  event.preventDefault();
  overlay.value.focus();
  overlay.value.setPointerCapture(event.pointerId);
  drag = { hit, start: current, x0: at.x, y0: at.y };
}

function onPointerMove(event: PointerEvent): void {
  if (!drag) {
    hover.value = hitTest(event);
    return;
  }
  const at = toFraction(event);
  if (!at) return;
  const { hit, start } = drag;
  if (hit.kind === 'move') studio.setSplit(movedSplit(start, at.x - drag.x0, at.y - drag.y0));
  else if (hit.kind === 'handle') studio.setSplit(resizedSplit(start, hit.handle, at));
  else {
    const along = start.axis === 'x' ? at.x : at.y;
    studio.setSplit(gapFromEdge(start, hit.divider, hit.side, along));
  }
}

function onPointerEnd(): void {
  drag = null;
}

function onKeyDown(event: KeyboardEvent): void {
  const current = split.value;
  if (!current || !scan.value) return;
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
  studio.setSplit(movedSplit(current, d[0] / scan.value.width, d[1] / scan.value.height));
}

function setAxis(axis: SplitAxis): void {
  if (split.value) studio.setSplit({ ...split.value, axis });
}

function setGap(event: Event): void {
  const current = split.value;
  if (!current) return;
  const raw = Number((event.target as HTMLInputElement).value);
  studio.setSplit({ ...current, gap: (raw / GAP_SLIDER_STEPS) * gapMax.value });
}

function thumbFrames(index: number): CropFraction[] {
  const current = studio.splitFor(index);
  return current ? splitFrames(current) : [];
}

function scopeClass(scope: SplitScope): string {
  return studio.splitScope === scope
    ? 'border-accent bg-accent-soft text-ink'
    : 'border-line text-ink-2 hover:border-ink-2 hover:text-ink';
}

function thumbFrameStyle(frame: CropFraction): Record<string, string> {
  return {
    left: `${frame.x * 100}%`,
    top: `${frame.y * 100}%`,
    width: `${frame.w * 100}%`,
    height: `${frame.h * 100}%`
  };
}

function axisClass(axis: SplitAxis): string {
  return split.value?.axis === axis
    ? 'border-accent bg-accent-soft text-ink'
    : 'border-line text-ink-2 hover:border-ink-2 hover:text-ink';
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <header class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 class="text-[16px] font-semibold">{{ t('studio.cut.title') }}</h2>
      <span v-if="scan" class="text-ink-2 tabular text-[13px]">
        {{ t('studio.cut.scanOf', { n: studio.currentScan + 1, total: studio.scans.length }) }}
        · {{ scan.name }}
      </span>
    </header>

    <div
      class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] lg:grid-rows-[minmax(0,1fr)]"
    >
      <section class="flex min-h-0 min-w-0 flex-col gap-2">
        <div
          ref="host"
          class="bg-bg-2 relative h-[60vh] overflow-hidden rounded-sm lg:h-auto lg:min-h-0 lg:flex-1"
        >
          <img
            v-if="scan && view.width"
            :src="scan.url"
            :alt="scan.name"
            draggable="false"
            class="absolute block max-w-none select-none"
            :style="{
              left: `${view.left}px`,
              top: `${view.top}px`,
              width: `${view.width}px`,
              height: `${view.height}px`
            }"
            decoding="async"
          />
          <svg
            v-if="split && view.width"
            ref="overlay"
            tabindex="0"
            class="focus-visible:outline-ink absolute outline-offset-2"
            :class="cursorClass"
            :style="{
              left: `${view.left}px`,
              top: `${view.top}px`,
              width: `${view.width}px`,
              height: `${view.height}px`,
              touchAction: 'none'
            }"
            :viewBox="`0 0 ${view.width} ${view.height}`"
            role="application"
            :aria-label="t('studio.cut.canvasLabel', { n: studio.currentScan + 1 })"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerEnd"
            @pointercancel="onPointerEnd"
            @pointerleave="hover = null"
            @keydown="onKeyDown"
          >
            <path :d="dimPath" fill="rgba(0, 0, 0, 0.5)" fill-rule="evenodd" />
            <g v-for="(frame, k) in frames" :key="k">
              <rect
                :x="px(frame.x, 'x')"
                :y="px(frame.y, 'y')"
                :width="px(frame.w, 'x')"
                :height="px(frame.h, 'y')"
                fill="none"
                stroke="var(--color-accent)"
                stroke-width="1.5"
              />
              <text
                :x="px(frame.x, 'x') + 8"
                :y="px(frame.y, 'y') + 18"
                font-size="13"
                font-weight="600"
                fill="#fff"
                stroke="rgba(0, 0, 0, 0.6)"
                stroke-width="3"
                paint-order="stroke"
              >
                {{ k + 1 }}
              </text>
            </g>
            <rect
              v-for="point in handles"
              :key="point.handle"
              :x="point.x - HANDLE_SIZE / 2"
              :y="point.y - HANDLE_SIZE / 2"
              :width="HANDLE_SIZE"
              :height="HANDLE_SIZE"
              fill="#fff"
              stroke="var(--color-ink)"
              stroke-width="1"
            />
          </svg>
        </div>

        <ul
          v-if="studio.scans.length > 1"
          class="flex max-h-[22vh] shrink-0 flex-wrap gap-2 overflow-y-auto pr-1"
          :aria-label="t('studio.cut.title')"
        >
          <li v-for="(item, index) in studio.scans" :key="item.index">
            <button
              type="button"
              class="focus-visible:outline-ink relative block h-16 overflow-hidden rounded-sm outline-offset-2"
              :class="
                index === studio.currentScan ? 'ring-accent ring-2' : 'opacity-80 hover:opacity-100'
              "
              :aria-pressed="index === studio.currentScan"
              :title="t('studio.cut.pick', { n: index + 1 })"
              @click="studio.selectScan(index)"
            >
              <img
                :src="item.thumb_url"
                alt=""
                draggable="false"
                loading="lazy"
                decoding="async"
                class="block h-16 w-auto"
              />
              <span
                v-for="(frame, k) in thumbFrames(index)"
                :key="k"
                class="border-accent pointer-events-none absolute border"
                :style="thumbFrameStyle(frame)"
              />
              <span
                class="tabular absolute bottom-0.5 left-1 text-[11px] font-semibold text-white [text-shadow:0_0_3px_rgba(0,0,0,0.9)]"
              >
                {{ index + 1 }}
              </span>
            </button>
          </li>
        </ul>
      </section>

      <aside class="flex min-h-0 flex-col gap-4 text-[13px]">
        <p class="text-ink-2">{{ t('studio.cut.hint') }}</p>

        <div v-if="studio.scans.length > 1" class="flex flex-col gap-1.5">
          <span class="text-ink-2">{{ t('studio.cut.scope') }}</span>
          <div class="flex flex-wrap gap-2" role="radiogroup" :aria-label="t('studio.cut.scope')">
            <button
              v-for="scope in ['shared', 'each'] as const"
              :key="scope"
              type="button"
              role="radio"
              class="flex min-h-9 items-center rounded-md border px-3 py-1.5 transition-colors"
              :class="scopeClass(scope)"
              :aria-checked="studio.splitScope === scope"
              @click="studio.setSplitScope(scope)"
            >
              {{ scope === 'shared' ? t('studio.cut.scopeShared') : t('studio.cut.scopeEach') }}
            </button>
          </div>
          <p class="text-ink-2">
            {{
              studio.splitScope === 'shared'
                ? t('studio.cut.scopeSharedHint')
                : t('studio.cut.scopeEachHint')
            }}
          </p>
          <button
            v-if="studio.splitScope === 'each'"
            type="button"
            class="text-ink-2 hover:text-ink flex min-h-9 items-center gap-2 self-start"
            @click="studio.applySplitToAll()"
          >
            <Copy class="h-4 w-4" />
            <span>{{ t('studio.cut.applyAll') }}</span>
          </button>
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="text-ink-2">{{ t('studio.scanMode.title') }}</span>
          <ScanModePicker
            :model-value="studio.scanMode"
            :modes="modes"
            @update:model-value="studio.setScanMode"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="text-ink-2">{{ t('studio.cut.axis') }}</span>
          <div class="flex flex-wrap gap-2" role="radiogroup" :aria-label="t('studio.cut.axis')">
            <button
              type="button"
              role="radio"
              class="flex min-h-9 items-center gap-2 rounded-md border px-3 py-1.5 transition-colors"
              :class="axisClass('x')"
              :aria-checked="split?.axis === 'x'"
              @click="setAxis('x')"
            >
              <Columns2 class="h-4 w-4" />
              <span>{{ t('studio.cut.axisX') }}</span>
            </button>
            <button
              type="button"
              role="radio"
              class="flex min-h-9 items-center gap-2 rounded-md border px-3 py-1.5 transition-colors"
              :class="axisClass('y')"
              :aria-checked="split?.axis === 'y'"
              @click="setAxis('y')"
            >
              <Rows2 class="h-4 w-4" />
              <span>{{ t('studio.cut.axisY') }}</span>
            </button>
          </div>
        </div>

        <label class="grid grid-cols-[minmax(0,1fr)_48px] items-center gap-x-3 gap-y-1">
          <span class="text-ink-2">{{ t('studio.cut.gap') }}</span>
          <span class="tabular text-right">{{ ((split?.gap ?? 0) * 100).toFixed(1) }}%</span>
          <input
            type="range"
            class="accent-ink col-span-2 h-5 w-full min-w-0 cursor-pointer"
            min="0"
            :max="GAP_SLIDER_STEPS"
            step="1"
            :value="gapValue"
            :disabled="!split"
            @input="setGap"
          />
        </label>

        <p v-if="frameSize" class="text-ink-2 tabular">
          {{ t('studio.cut.frameSize', { w: frameSize.width, h: frameSize.height }) }}
        </p>

        <div class="mt-auto flex flex-col gap-2">
          <button
            type="button"
            class="bg-accent flex h-10 items-center justify-center gap-2 rounded-md px-4 text-[14px] font-semibold text-white disabled:opacity-50"
            :disabled="!split || !studio.scans.length || studio.cuttingBusy || studio.uploading"
            @click="studio.cutScans()"
          >
            <Scissors class="h-4 w-4" />
            <span>{{ t('studio.cut.cut', { scans: studio.scans.length, frames: cutCount }) }}</span>
          </button>
          <button
            v-if="studio.frameCount"
            type="button"
            class="text-ink-2 hover:text-ink flex h-9 items-center justify-center gap-2 rounded-md"
            @click="studio.closeCutting()"
          >
            <ArrowLeft class="h-4 w-4" />
            <span>{{ t('studio.cut.back') }}</span>
          </button>
          <StatusLine :status="studio.cutStatus ?? studio.uploadStatus" />
        </div>
      </aside>
    </div>
  </div>
</template>
