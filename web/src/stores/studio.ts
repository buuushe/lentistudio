import { defineStore } from 'pinia';
import { computed, reactive, ref, shallowRef, toRaw, watch } from 'vue';

import {
  cancelBatch,
  closeSession,
  detectOrder as detectOrderRequest,
  fetchPalette,
  fetchBatch,
  frameAvailable,
  matchPoint,
  renderVideo,
  splitScans,
  startBatch,
  uploadFrames,
  uploadScans as uploadScansRequest
} from '@/api/renderApi';
import type {
  BatchState,
  FrameMeta,
  MatchResponse,
  RenderJob,
  RenderResponse,
  ScanMeta
} from '@/api/types';
import { defaultAdjust, isIdentityAdjust, layerAdjust, type Adjust } from '@/lib/adjust';
import { createFrameBuffer, FrameBufferRegistry, loadImage, rebuildWork } from '@/lib/frameBuffers';
import {
  anchorFromCropCenter,
  computeLayout,
  type CropFraction,
  fractionFromCrop,
  DEFAULT_SET_SIZE,
  isSetSize,
  type SetSize,
  type Layout,
  normalizeFraction,
  type Point,
  type Preset,
  shiftedAnchor
} from '@/lib/geometry';
import { balanceAdjustments, type Tone, unevenPositions } from '@/lib/balance';
import { groupSimilar, meanSignature, orderBy, type ShuffleMode } from '@/lib/palette';
import { clampToFrame } from '@/lib/pickPainter';
import {
  FRAME_MAX_SIDE,
  isHeavy,
  isOverHardLimit,
  megabytes,
  SCAN_MAX_SIDE,
  shrinkAll,
  UPLOAD_HARD_LIMIT_BYTES,
  UPLOAD_SOFT_LIMIT_BYTES
} from '@/lib/shrink';
import {
  cloneSplit,
  defaultSplit,
  scanGeometry,
  type SplitScope,
  isSplitCount,
  normalizeSplit,
  type ScanMode,
  type ScanSplit
} from '@/lib/scanSplit';
import {
  baseSetMode,
  clampCycles,
  compositePass,
  compositeSequence,
  dwellCycles,
  isSyncComposition,
  legacySetCycles,
  LOOP_MODES,
  parsePattern,
  passVisits,
  SWEEP_SET_MODE,
  type Composition,
  type DwellPreset,
  type LoopMode,
  type SetLoop,
  type SetLoopMode
} from '@/lib/sequence';
import { errorStatus, status, type StatusMessage } from '@/lib/status';
import {
  clearLocalSnapshot,
  loadLocalSnapshot,
  saveLocalSnapshot,
  SNAPSHOT_VERSION,
  type StudioSnapshot
} from '@/lib/studioSnapshot';

export const frameBuffers = new FrameBufferRegistry();

type PointSource = 'manual' | 'auto' | 'center';

interface PointMeta {
  source: PointSource;
  score?: number;
}

export interface FrameSet {
  frames: number[];
  adjust: Adjust;
  grouped: boolean;
  balanced: boolean;
  hidden: boolean;
  loop: LoopMode;
  patternText: string;
  cycles: number;
  anchor: Point | null;
  customCrop: CropFraction | null;
  orderChecked: boolean;
  orderStatus: StatusMessage | null;
  suggestedOrder: number[] | null;
  detecting: boolean;
  orderSeq: number;
}

interface SetTemplate {
  adjust: Adjust;
  grouped: boolean;
  balanced?: boolean;
  loop?: LoopMode;
  patternText?: string;
  cycles?: number;
}

const DEFAULT_LOOP: LoopMode = 'pingpong';

function isLoopMode(value: unknown): value is LoopMode {
  return typeof value === 'string' && (LOOP_MODES as readonly string[]).includes(value);
}

function setTemplateOf(set: FrameSet): SetTemplate {
  return {
    adjust: set.adjust,
    grouped: set.grouped,
    balanced: set.balanced,
    loop: set.loop,
    patternText: set.patternText,
    cycles: set.cycles
  };
}

function newFrameSet(frames: number[] = [], template?: SetTemplate): FrameSet {
  return {
    frames,
    adjust: template ? { ...template.adjust } : defaultAdjust(),
    grouped: template?.grouped ?? true,
    balanced: template?.balanced ?? false,
    hidden: false,
    loop: template?.loop ?? DEFAULT_LOOP,
    patternText: template?.patternText ?? '',
    cycles: template?.cycles ?? 1,
    anchor: null,
    customCrop: null,
    orderChecked: false,
    orderStatus: null,
    suggestedOrder: null,
    detecting: false,
    orderSeq: 0
  };
}

export type OutputMode = 'combined' | 'separate';

function isOutputMode(value: unknown): value is OutputMode {
  return value === 'combined' || value === 'separate';
}

interface OutputSettings {
  output: OutputMode;
  setMode: SetLoopMode;
  sharedFocus: boolean;
  loops: number | null;
  composition: Composition;
  transitionFrames: number;
  parallaxZoom: number;
  fps: number;
  duration: number;
  preset: Preset;
  maxWidth: number | null;
}

const SETTING_KEYS = Object.keys(defaultSettings()) as (keyof OutputSettings)[];

function pickSettings(saved: object): Partial<OutputSettings> {
  const source = saved as Record<string, unknown>;
  return Object.fromEntries(
    SETTING_KEYS.filter((key) => key in source).map((key) => [key, source[key]])
  ) as Partial<OutputSettings>;
}

const SET_SIZE_KEY = 'lenti.studio.setSize';

function loadSetSize(): SetSize {
  try {
    const raw = Number(localStorage.getItem(SET_SIZE_KEY));
    return isSetSize(raw) ? raw : DEFAULT_SET_SIZE;
  } catch {
    return DEFAULT_SET_SIZE;
  }
}

function saveSetSize(size: SetSize): void {
  try {
    localStorage.setItem(SET_SIZE_KEY, String(size));
  } catch {
    return;
  }
}

const SCAN_MODE_KEY = 'lenti.studio.scanMode';

function loadScanMode(): ScanMode {
  try {
    const raw = Number(localStorage.getItem(SCAN_MODE_KEY));
    return isSplitCount(raw) ? raw : 1;
  } catch {
    return 1;
  }
}

function saveScanMode(mode: ScanMode): void {
  try {
    localStorage.setItem(SCAN_MODE_KEY, String(mode));
  } catch {
    return;
  }
}

export const LOW_CONFIDENCE = 0.6;
export const ADJUST_DEBOUNCE_MS = 40;
export const LOCAL_SAVE_DEBOUNCE_MS = 300;
export const BATCH_POLL_MS = 1000;

function defaultSettings(): OutputSettings {
  return {
    output: 'combined',
    setMode: 'forward',
    sharedFocus: false,
    loops: null,
    composition: 'single',
    transitionFrames: 2,
    parallaxZoom: 0,
    fps: 10,
    duration: 6,
    preset: 'ig_portrait',
    maxWidth: 1080
  };
}
const MIN_ORDER_CONFIDENCE = 0.3;

const UPLOAD_BATCH_BYTES = 30 * 1024 * 1024;
const UPLOAD_BATCH_FILES = 24;

export function batchFiles(
  files: File[],
  maxBytes = UPLOAD_BATCH_BYTES,
  maxFiles = UPLOAD_BATCH_FILES
): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let currentBytes = 0;
  files.forEach((file) => {
    const overflow = currentBytes + file.size > maxBytes || current.length >= maxFiles;
    if (current.length && overflow) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  });
  if (current.length) batches.push(current);
  return batches;
}

export function pickImageFiles(list: Iterable<File>): File[] {
  return Array.from(list)
    .filter((file) => file.type.startsWith('image/') || /\.(tiff?|webp|bmp)$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function moveWithin<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

type OrderDirection = 'forward' | 'backward';

export function orderDirectionOf(order: number[]): OrderDirection | null {
  if (order.length < 2) return null;
  const ascending = order.every((index, k) => k === 0 || index > order[k - 1]);
  if (ascending) return 'forward';
  const descending = order.every((index, k) => k === 0 || index < order[k - 1]);
  return descending ? 'backward' : null;
}

function chunkBy<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export const useStudioStore = defineStore('studio', () => {
  const sessionId = ref<string | null>(null);
  const frames = ref<FrameMeta[]>([]);
  const sets = ref<FrameSet[]>([newFrameSet()]);
  const activeSet = ref(0);
  const points = reactive<Record<number, Point>>({});
  const pointMeta = reactive<Record<number, PointMeta>>({});
  const lastManual = ref<number | null>(null);
  const combinedAnchor = ref<Point | null>(null);
  const combinedCrop = ref<CropFraction | null>(null);
  const adjust = reactive({ per: {} as Record<number, Adjust> });
  const settings = reactive<OutputSettings>(defaultSettings());
  const autoMatch = ref(true);
  const renders = ref<RenderResponse[]>([]);
  const currentRender = ref<RenderResponse | null>(null);
  const batch = ref<BatchState | null>(null);
  const askOutput = ref(false);
  const rendering = ref(false);
  const renderStatus = shallowRef<StatusMessage | null>(null);
  const bufferVersion = ref(0);

  const uploading = ref(false);
  const uploadStatus = shallowRef<StatusMessage | null>(null);
  const scanMode = ref<ScanMode>(loadScanMode());
  const setSize = ref<SetSize>(loadSetSize());
  const scans = ref<ScanMeta[]>([]);
  const sharedSplit = ref<ScanSplit | null>(null);
  const splitScope = ref<SplitScope>('shared');
  const scanSplits = ref<ScanSplit[]>([]);
  const cutting = ref(false);
  const cuttingBusy = ref(false);
  const cutStatus = shallowRef<StatusMessage | null>(null);
  const currentScan = ref(0);
  const split = computed<ScanSplit | null>(() => splitFor(currentScan.value));
  const matchStatus = shallowRef<StatusMessage | null>(null);
  const matching = ref(false);
  let matchRequestSeq = 0;

  const active = computed(() => sets.value[activeSet.value]);
  const order = computed({
    get: () => active.value.frames,
    set: (next: number[]) => {
      active.value.frames = next;
    }
  });
  const setCount = computed(() => sets.value.length);
  const shownSets = computed(() => sets.value.filter((set) => !set.hidden));
  const shownSetCount = computed(() => shownSets.value.length);
  const separate = computed(() => settings.output === 'separate');
  const animatedSets = computed(() => (separate.value ? [active.value] : shownSets.value));
  const animatedSetCount = computed(() => animatedSets.value.length);
  const flatOrder = computed(() => animatedSets.value.flatMap((set) => set.frames));
  const anchor = computed<Point | null>({
    get: () => (separate.value ? active.value.anchor : combinedAnchor.value),
    set: (next) => {
      if (separate.value) active.value.anchor = next;
      else combinedAnchor.value = next;
    }
  });
  const customCrop = computed<CropFraction | null>({
    get: () =>
      separate.value ? (active.value.customCrop ?? combinedCrop.value) : combinedCrop.value,
    set: (next) => {
      if (separate.value) active.value.customCrop = next;
      else combinedCrop.value = next;
    }
  });
  const assignedFrames = computed(() => sets.value.flatMap((set) => set.frames));
  const frameCount = computed(() => frames.value.length);
  const selectionComplete = computed(() => order.value.length === setSize.value);
  const seriesComplete = computed(
    () =>
      animatedSetCount.value > 0 &&
      animatedSets.value.every((set) => set.frames.length === setSize.value)
  );
  const orderedFrames = computed(() => flatOrder.value.map((index) => frames.value[index]));
  const pointsCount = computed(() => order.value.filter((index) => points[index]).length);
  const seriesPointsCount = computed(() => flatOrder.value.filter((index) => points[index]).length);
  const allPointsSet = computed(
    () => selectionComplete.value && pointsCount.value === setSize.value
  );
  const seriesPointsSet = computed(
    () => seriesComplete.value && seriesPointsCount.value === flatOrder.value.length
  );
  function isIncomplete(set: FrameSet): boolean {
    return set.frames.length < setSize.value;
  }
  function isUnmarked(set: FrameSet): boolean {
    return set.frames.some((index) => !points[index]);
  }
  function firstShownWhere(test: (set: FrameSet) => boolean): number {
    return sets.value.findIndex((set) => !set.hidden && test(set));
  }
  function firstAnimatedWhere(test: (set: FrameSet) => boolean): number {
    const found = animatedSets.value.find(test);
    return found ? sets.value.indexOf(found) : -1;
  }
  const incompleteSet = computed(() => firstShownWhere(isIncomplete));
  const unmarkedSet = computed(() => firstShownWhere(isUnmarked));
  const previewIncompleteSet = computed(() => firstAnimatedWhere(isIncomplete));
  const previewUnmarkedSet = computed(() => firstAnimatedWhere(isUnmarked));
  const batchReady = computed(
    () => shownSetCount.value > 0 && incompleteSet.value < 0 && unmarkedSet.value < 0
  );
  const orderDirection = computed(() => orderDirectionOf(order.value));
  const adjustGrouped = computed(() => active.value.grouped);
  const adjustBalanced = computed(() => active.value.balanced);
  const sharedAdjust = computed(() => active.value.adjust);
  const orderStatus = computed(() => active.value.orderStatus);
  const suggestedOrder = computed(() => active.value.suggestedOrder);
  const detectingOrder = computed(() => active.value.detecting);
  function patternOf(set: FrameSet): number[] | null {
    return set.loop === 'custom' ? parsePattern(set.patternText, setSize.value) : null;
  }
  function loopOf(set: FrameSet): SetLoop {
    return { mode: set.loop, custom: patternOf(set), cycles: set.cycles };
  }
  function patternMissing(set: FrameSet): boolean {
    return set.loop === 'custom' && patternOf(set) === null;
  }
  const sweeping = computed(() => settings.setMode === SWEEP_SET_MODE);
  const synced = computed(
    () => animatedSetCount.value > 1 && isSyncComposition(settings.composition)
  );
  const patternValid = computed(() => {
    if (separate.value) return !shownSets.value.some(patternMissing);
    return sweeping.value || !animatedSets.value.some(patternMissing);
  });
  const composition = computed<Composition>(() =>
    animatedSetCount.value > 1 ? settings.composition : 'single'
  );
  const seriesShape = computed(() => ({
    setCount: animatedSetCount.value,
    framesPerSet: setSize.value,
    mode: DEFAULT_LOOP,
    setMode: settings.setMode,
    cyclesPerSet: 1,
    loops: animatedSets.value.map(loopOf)
  }));
  const pass = computed(() =>
    compositePass(seriesShape.value, composition.value, settings.transitionFrames)
  );
  const composites = computed(() =>
    compositeSequence(seriesShape.value, settings.fps, settings.duration, {
      composition: composition.value,
      transitionFrames: settings.transitionFrames,
      loops: settings.loops
    })
  );
  const clipVisits = computed(() =>
    passVisits(pass.value, setSize.value, animatedSetCount.value, settings.setMode, synced.value)
  );
  const sequence = computed(() => composites.value.map((item) => item.a));
  function layoutFor(
    order: number[],
    anchorValue: Point | null,
    cropValue: CropFraction | null
  ): Layout | null {
    return computeLayout(
      order.map((index) => frames.value[index]),
      order.map((index) => points[index]),
      {
        preset: settings.preset,
        maxWidth: settings.maxWidth,
        anchor: anchorValue,
        customCrop: cropValue,
        framesPerSet: setSize.value,
        sharedFocus: settings.sharedFocus
      }
    );
  }

  const layout = computed<Layout | null>(() =>
    seriesComplete.value ? layoutFor(flatOrder.value, anchor.value, customCrop.value) : null
  );

  const renderReady = computed(() => (separate.value ? batchReady.value : layout.value !== null));
  const canRender = computed(
    () => renderReady.value && sessionId.value !== null && patternValid.value && !rendering.value
  );

  function setLoop(setIndex: number, mode: LoopMode): void {
    const set = sets.value[setIndex];
    if (set) set.loop = mode;
  }

  function setPatternText(setIndex: number, text: string): void {
    const set = sets.value[setIndex];
    if (set) set.patternText = text;
  }

  function setCycles(setIndex: number, cycles: number): void {
    const set = sets.value[setIndex];
    if (set) set.cycles = clampCycles(cycles);
  }

  function applyLoopToAll(): void {
    const source = active.value;
    sets.value.forEach((set) => {
      set.loop = source.loop;
      set.patternText = source.patternText;
      set.cycles = source.cycles;
    });
  }

  function applyDwellPreset(preset: DwellPreset): void {
    const shown = shownSets.value;
    dwellCycles(preset, shown.length).forEach((cycles, k) => {
      shown[k].cycles = cycles;
    });
    if (preset === 'swing') settings.setMode = 'pingpong';
  }

  function moveFrameInSet(setIndex: number, from: number, to: number): void {
    const set = sets.value[setIndex];
    if (!set || from === to || to < 0 || to >= set.frames.length) return;
    set.frames.splice(0, set.frames.length, ...moveWithin(set.frames, from, to));
    if (setIndex === activeSet.value) anchor.value = null;
  }

  function setHolding(index: number): FrameSet {
    return sets.value[setOf(index)] ?? active.value;
  }

  function adjustFor(index: number): Adjust {
    const set = setHolding(index);
    if (set.grouped) return set.adjust;
    if (!adjust.per[index]) adjust.per[index] = { ...set.adjust };
    return adjust.per[index];
  }

  function appliedAdjust(index: number): Adjust {
    const set = setHolding(index);
    return set.balanced ? layerAdjust(adjustFor(index), set.adjust) : adjustFor(index);
  }

  function normalizedAnchorOf(current: Layout, anchorValue: Point | null): Point | null {
    if (!current.hasPreset || !anchorValue) return anchorValue;
    return anchorFromCropCenter(current.alignment.crop, current.crop);
  }

  function panAnchor(dx: number, dy: number): void {
    const current = layout.value;
    if (!current || !current.hasPreset) return;
    anchor.value = shiftedAnchor(current, dx, dy);
  }

  function setAnchor(next: Point): void {
    if (!layout.value?.hasPreset) return;
    anchor.value = next;
  }

  function startCustomCrop(): void {
    const current = layout.value;
    if (settings.preset === 'custom') {
      customCrop.value ??= { x: 0, y: 0, w: 1, h: 1 };
      return;
    }
    customCrop.value = current
      ? fractionFromCrop(current.alignment.crop, current.crop)
      : { x: 0, y: 0, w: 1, h: 1 };
    settings.preset = 'custom';
    anchor.value = null;
  }

  function choosePreset(preset: Preset): void {
    if (preset === 'custom') startCustomCrop();
    else settings.preset = preset;
  }

  function setCustomCrop(next: CropFraction): void {
    customCrop.value = normalizeFraction(next);
  }

  function centerCustomCrop(): void {
    const current = customCrop.value;
    if (!current) return;
    setCustomCrop({ ...current, x: (1 - current.w) / 2, y: (1 - current.h) / 2 });
  }

  function resetAnchor(): void {
    anchor.value = null;
  }

  function renderJobFor(
    order: number[],
    current: Layout,
    anchorValue: Point | null,
    cropValue: CropFraction | null
  ): RenderJob {
    const isFree = settings.preset === 'free';
    const isCustom = settings.preset === 'custom';
    const setTotal = order.length / setSize.value;
    return {
      order: order.slice(),
      points: current.ordered.map((frame) => points[frame.index]),
      set_loops: chunkBy(order, setSize.value).map((quad) => {
        const set = sets.value[setOf(quad[0])] ?? active.value;
        return { mode: set.loop, pattern: patternOf(set), cycles: set.cycles };
      }),
      set_mode: settings.setMode,
      frames_per_set: setSize.value,
      shared_focus: settings.sharedFocus,
      loops: settings.loops,
      composition: setTotal > 1 ? settings.composition : 'single',
      transition_frames: settings.transitionFrames,
      parallax_zoom: settings.parallaxZoom,
      fps: settings.fps,
      duration: settings.duration,
      max_width: isFree || isCustom ? settings.maxWidth : null,
      preset: settings.preset,
      anchor: isFree || isCustom ? null : normalizedAnchorOf(current, anchorValue),
      crop: isCustom ? cropValue : null,
      adjustments: current.ordered.map((frame) => ({ ...appliedAdjust(frame.index) }))
    };
  }

  async function render(): Promise<void> {
    if (separate.value) return renderBatch();
    const current = layout.value;
    if (!current || !canRender.value) return;
    await renderOne(renderJobFor(flatOrder.value, current, anchor.value, customCrop.value));
  }

  function activeFraming(): { anchor: Point | null; crop: CropFraction | null } {
    const set = active.value;
    if (separate.value) return { anchor: set.anchor, crop: set.customCrop ?? combinedCrop.value };
    return { anchor: combinedAnchor.value, crop: combinedCrop.value };
  }

  const activeLayout = computed(() => {
    const set = active.value;
    if (set.frames.length !== setSize.value || isUnmarked(set)) return null;
    const framing = activeFraming();
    return layoutFor(set.frames, framing.anchor, framing.crop);
  });

  const canRenderActive = computed(
    () =>
      activeLayout.value !== null &&
      sessionId.value !== null &&
      !patternMissing(active.value) &&
      !rendering.value
  );

  async function renderActiveSet(): Promise<void> {
    const current = activeLayout.value;
    if (!current || !canRenderActive.value) return;
    const framing = activeFraming();
    await renderOne(renderJobFor(active.value.frames, current, framing.anchor, framing.crop));
  }

  async function renderOne(job: RenderJob): Promise<void> {
    if (!sessionId.value) return;
    rendering.value = true;
    renderStatus.value = status('studio.render.rendering');
    try {
      const response = await renderVideo({ session_id: sessionId.value, ...job });
      renders.value = [
        response,
        ...renders.value.filter((item) => item.video_name !== response.video_name)
      ];
      currentRender.value = response;
      renderStatus.value = status('studio.render.done', undefined, 'ok');
    } catch (error) {
      renderStatus.value = errorStatus(error, 'studio.render.failed');
    } finally {
      rendering.value = false;
    }
  }

  interface BatchPlan {
    items: RenderJob[];
    setNumbers: number[];
  }

  function batchPlan(): BatchPlan | { blockedSet: number } {
    const plan: BatchPlan = { items: [], setNumbers: [] };
    for (const [setIndex, set] of sets.value.entries()) {
      if (set.hidden) continue;
      const crop = set.customCrop ?? combinedCrop.value;
      const current = layoutFor(set.frames, set.anchor, crop);
      if (!current) return { blockedSet: setIndex };
      plan.items.push(renderJobFor(set.frames, current, set.anchor, crop));
      plan.setNumbers.push(setIndex + 1);
    }
    return plan;
  }

  const batchRunning = computed(() => batch.value?.status === 'running');

  function batchRenders(state: BatchState): RenderResponse[] {
    return state.items.flatMap((item) => (item.render ? [item.render] : []));
  }

  function waitForBatch(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, BATCH_POLL_MS));
  }

  function reportBatch(state: BatchState): void {
    const failed = state.items.filter((item) => item.status === 'failed').length;
    const made = batchRenders(state).length;
    if (state.status === 'running') {
      renderStatus.value = status('studio.batch.progress', {
        done: state.done,
        total: state.total
      });
    } else if (state.status === 'done') {
      const key = failed ? 'studio.batch.doneWithFailures' : 'studio.batch.done';
      renderStatus.value = status(key, { n: made, failed }, failed ? 'warn' : 'ok');
    } else if (state.status === 'cancelled') {
      renderStatus.value = status('studio.batch.cancelled', { n: made }, 'warn');
    } else {
      renderStatus.value = status('studio.batch.failed', { n: made }, 'err');
    }
  }

  function acceptBatch(state: BatchState): void {
    batch.value = state;
    reportBatch(state);
    const first = batchRenders(state)[0];
    if (state.status !== 'running' && first) currentRender.value = first;
  }

  async function followBatch(sid: string): Promise<void> {
    while (batch.value?.status === 'running') {
      await waitForBatch();
      const batchId = batch.value?.batch_id;
      if (sessionId.value !== sid || !batchId) return;
      acceptBatch(await fetchBatch(sid, batchId));
    }
  }

  async function runBatch(sid: string, start: () => Promise<BatchState>): Promise<void> {
    rendering.value = true;
    try {
      acceptBatch(await start());
      await followBatch(sid);
    } catch (error) {
      renderStatus.value = errorStatus(error, 'studio.render.failed');
    } finally {
      rendering.value = false;
    }
  }

  async function renderBatch(): Promise<void> {
    const sid = sessionId.value;
    if (!sid || !canRender.value) return;
    const plan = batchPlan();
    if ('blockedSet' in plan) {
      renderStatus.value = status('studio.batch.noOverlap', { set: plan.blockedSet + 1 }, 'err');
      return;
    }
    renderStatus.value = status('studio.batch.starting', { total: plan.items.length });
    await runBatch(sid, () =>
      startBatch({ session_id: sid, items: plan.items, set_numbers: plan.setNumbers })
    );
  }

  async function resumeBatch(): Promise<void> {
    const sid = sessionId.value;
    const running = batch.value;
    if (!sid || !running || running.status !== 'running' || rendering.value) return;
    await runBatch(sid, () => fetchBatch(sid, running.batch_id));
  }

  async function stopBatch(): Promise<void> {
    const sid = sessionId.value;
    const running = batch.value;
    if (!sid || !running || running.status !== 'running') return;
    renderStatus.value = status('studio.batch.stopping');
    try {
      await cancelBatch(sid, running.batch_id);
    } catch (error) {
      renderStatus.value = errorStatus(error, 'studio.render.failed');
    }
  }

  function setOutputMode(mode: OutputMode): void {
    if (settings.output === mode) return;
    settings.output = mode;
    matchStatus.value = null;
  }

  function chooseOutput(mode: OutputMode): void {
    setOutputMode(mode);
    askOutput.value = false;
  }

  function showRender(item: RenderResponse): void {
    currentRender.value = item;
  }

  const hasAdjustments = computed(() => {
    const set = active.value;
    if (!isIdentityAdjust(set.adjust)) return true;
    return set.frames.some((index) => adjust.per[index] && !isIdentityAdjust(adjust.per[index]));
  });

  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let rebuildQueue: Set<number> | null = new Set();

  function rebuildBuffers(indices: number[] | null): void {
    const targets = indices ?? frameBuffers.indices();
    targets.forEach((index) => {
      const buffer = frameBuffers.get(index);
      if (buffer) rebuildWork(buffer, appliedAdjust(index));
    });
    bufferVersion.value += 1;
  }

  function scheduleRebuild(indices: number[] | null): void {
    if (indices === null) rebuildQueue = null;
    else if (rebuildQueue) indices.forEach((index) => rebuildQueue?.add(index));
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      const queued = rebuildQueue ? [...rebuildQueue] : null;
      rebuildQueue = new Set();
      rebuildBuffers(queued);
    }, ADJUST_DEBOUNCE_MS);
  }

  function setAdjust(index: number | null, key: keyof Adjust, value: number): void {
    const set = active.value;
    const target = index === null ? set.adjust : adjustFor(index);
    target[key] = value;
    if (index === null && key === 'sharpen' && !set.grouped) {
      set.frames.forEach((frame) => {
        adjustFor(frame).sharpen = value;
      });
    }
    scheduleRebuild(index === null ? set.frames.slice() : [index]);
  }

  function resetAdjust(index: number | null): void {
    if (index === null) {
      const set = active.value;
      set.adjust = defaultAdjust();
      set.grouped = true;
      set.balanced = false;
      set.frames.forEach((frame) => delete adjust.per[frame]);
      scheduleRebuild(set.frames.slice());
    } else {
      adjust.per[index] = defaultAdjust();
      scheduleRebuild([index]);
    }
  }

  const tones = reactive<Record<number, Tone>>({});

  function rememberTones(features: { index: number; tone?: [number, number] }[]): void {
    features.forEach((feature) => {
      if (feature.tone) tones[feature.index] = { mean: feature.tone[0], std: feature.tone[1] };
    });
  }

  async function ensureTones(indices: number[]): Promise<void> {
    const missing = indices.filter((index) => !tones[index]);
    if (!missing.length || !sessionId.value) return;
    const { features } = await fetchPalette(sessionId.value, missing);
    rememberTones(features);
  }

  function balanceFor(set: FrameSet): Adjust[] | null {
    if (set.frames.length !== setSize.value || !set.frames.every((index) => tones[index]))
      return null;
    return balanceAdjustments(
      set.frames.map((index) => tones[index]),
      set.adjust.sharpen
    );
  }

  const balanceSuggestion = computed(() => {
    const set = active.value;
    if (!set.grouped) return null;
    const adjusts = balanceFor(set);
    if (!adjusts) return null;
    const positions = unevenPositions(adjusts);
    return positions.length ? { positions } : null;
  });

  function applyBalanceTo(setIndex: number): boolean {
    const set = sets.value[setIndex];
    const adjusts = balanceFor(set);
    if (!adjusts || !unevenPositions(adjusts).length) return false;
    set.grouped = false;
    set.balanced = true;
    set.frames.forEach((index, position) => {
      adjust.per[index] = { ...adjusts[position] };
    });
    scheduleRebuild(set.frames.slice());
    return true;
  }

  async function applyBalance(setIndex = activeSet.value): Promise<boolean> {
    const set = sets.value[setIndex];
    if (!set || set.frames.length !== setSize.value) return false;
    await ensureTones(set.frames);
    return applyBalanceTo(setIndex);
  }

  function stopBalance(setIndex = activeSet.value): void {
    const set = sets.value[setIndex];
    if (!set?.balanced) return;
    set.balanced = false;
    set.grouped = true;
    set.frames.forEach((index) => delete adjust.per[index]);
    scheduleRebuild(set.frames.slice());
  }

  async function toggleBalance(): Promise<void> {
    if (active.value.balanced) stopBalance();
    else await applyBalance();
  }

  function balanceAllSets(): number {
    return sets.value.reduce((count, _, setIndex) => count + (applyBalanceTo(setIndex) ? 1 : 0), 0);
  }

  function setAdjustGroup(group: boolean): void {
    const set = active.value;
    set.grouped = group;
    set.balanced = false;
    if (!group) {
      set.frames.forEach((index) => {
        adjust.per[index] = { ...set.adjust };
      });
    }
    scheduleRebuild(set.frames.slice());
  }

  function resetFrameState(): void {
    frames.value = [];
    sets.value = [newFrameSet()];
    activeSet.value = 0;
    Object.keys(points).forEach((key) => delete points[Number(key)]);
    Object.keys(pointMeta).forEach((key) => delete pointMeta[Number(key)]);
    adjust.per = {};
    lastManual.value = null;
    combinedAnchor.value = null;
    renders.value = [];
    currentRender.value = null;
    batch.value = null;
    askOutput.value = false;
    frameBuffers.clear();
  }

  function resetSession(): void {
    resetFrameState();
    scans.value = [];
    scanSplits.value = [];
    cutting.value = false;
    currentScan.value = 0;
  }

  function resetSetDerived(setIndex: number): void {
    const set = sets.value[setIndex];
    set.suggestedOrder = null;
    set.orderChecked = false;
    set.orderStatus = null;
  }

  function resetSelectionDerived(): void {
    anchor.value = null;
    resetSetDerived(activeSet.value);
    matchStatus.value = null;
  }

  function setOf(index: number): number {
    return sets.value.findIndex((set) => set.frames.includes(index));
  }

  function pointsInSet(setIndex: number): number {
    return sets.value[setIndex]?.frames.filter((index) => points[index]).length ?? 0;
  }

  function isManual(index: number): boolean {
    return pointMeta[index]?.source === 'manual';
  }

  function isPlacedByUserOrSearch(index: number): boolean {
    return Boolean(points[index]) && pointMeta[index]?.source !== 'center';
  }

  function centerMissingPoints(): void {
    assignedFrames.value.forEach((index) => {
      const frame = frames.value[index];
      if (points[index] || !frame) return;
      points[index] = { x: frame.width / 2, y: frame.height / 2 };
      pointMeta[index] = { source: 'center' };
    });
  }

  function recheckOrderWhenComplete(): void {
    if (!sessionId.value) return;
    sets.value.forEach((set, setIndex) => {
      const ready =
        set.frames.length === setSize.value &&
        set.frames.every((index) => isPlacedByUserOrSearch(index));
      if (ready && !set.orderChecked) {
        set.orderChecked = true;
        void detectOrder(setIndex);
      }
    });
  }

  function manualIn(setIndex: number): number | null {
    const found = sets.value[setIndex]?.frames.find((index) => isManual(index));
    return found === undefined ? null : found;
  }

  function dropOtherManualPoints(index: number): void {
    const setIndex = setOf(index);
    if (setIndex < 0) return;
    sets.value[setIndex].frames
      .filter((other) => other !== index && isManual(other))
      .forEach(dropPoint);
  }

  function setPoint(index: number, point: Point): void {
    const frame = frames.value[index];
    if (!frame) return;
    dropOtherManualPoints(index);
    points[index] = clampToFrame(point, frame.width, frame.height);
    pointMeta[index] = { source: 'manual' };
    lastManual.value = index;
    anchor.value = null;
    recheckOrderWhenComplete();
  }

  function nudgePoint(index: number, dx: number, dy: number): void {
    const current = points[index];
    if (!current) return;
    setPoint(index, { x: current.x + dx, y: current.y + dy });
  }

  function afterManualPoint(index: number): void {
    if (autoMatch.value) void propagateFrom(index);
  }

  function dropPoint(index: number): void {
    delete points[index];
    delete pointMeta[index];
  }

  function clearPoints(): void {
    order.value.forEach(dropPoint);
    if (lastManual.value !== null && !points[lastManual.value]) lastManual.value = null;
    matchRequestSeq += 1;
    matching.value = false;
    matchStatus.value = null;
    anchor.value = null;
  }

  function ownSetTargets(setIndex: number, refIndex: number): number[] {
    return sets.value[setIndex].frames.filter((index) => index !== refIndex && !isManual(index));
  }

  function unmarkedTargetsOutside(setIndex: number): number[] {
    return sets.value.flatMap((set, k) =>
      k === setIndex ? [] : set.frames.filter((index) => !isPlacedByUserOrSearch(index))
    );
  }

  interface MatchProgress {
    done: number;
    total: number;
  }
  const matchProgress = shallowRef<MatchProgress | null>(null);

  function targetBatches(targets: number[]): number[][] {
    const bySet = new Map<number, number[]>();
    targets.forEach((index) => {
      const setIndex = setOf(index);
      bySet.set(setIndex, [...(bySet.get(setIndex) ?? []), index]);
    });
    return [...bySet.values()];
  }

  function applyMatchResults(data: MatchResponse, refIndex: number): void {
    if (data.ref.suggested) {
      points[refIndex] = { x: data.ref.x, y: data.ref.y };
      pointMeta[refIndex] = { source: 'auto', score: 1 };
    }
    data.results.forEach((result) => {
      points[result.index] = { x: result.x, y: result.y };
      pointMeta[result.index] = { source: 'auto', score: result.score };
    });
  }

  async function propagate(refIndex: number, targets: number[], suggest: boolean): Promise<void> {
    if (!sessionId.value) return;
    if (!targets.length && !suggest) {
      matchStatus.value = status('studio.focus.allManual');
      return;
    }
    const requestSeq = ++matchRequestSeq;
    matching.value = true;
    matchProgress.value = { done: 0, total: targets.length };
    matchStatus.value = status('studio.focus.searching');
    const batches = targets.length ? targetBatches(targets) : [[]];
    let found = 0;
    let low = 0;
    try {
      for (const [k, batch] of batches.entries()) {
        const data = await matchPoint({
          session_id: sessionId.value,
          ref_index: refIndex,
          point: suggest && k === 0 ? null : (points[refIndex] ?? null),
          targets: batch
        });
        if (requestSeq !== matchRequestSeq) return;
        applyMatchResults(data, refIndex);
        found += data.results.length;
        low += data.results.filter((result) => result.score < LOW_CONFIDENCE).length;
        matchProgress.value = { done: Math.min(targets.length, found), total: targets.length };
      }
      const foundKey = low ? 'studio.focus.foundLow' : 'studio.focus.found';
      matchStatus.value = status(
        found ? foundKey : 'studio.focus.done',
        { n: found, low },
        low ? 'warn' : 'ok'
      );
      anchor.value = null;
      recheckOrderWhenComplete();
    } catch (error) {
      if (requestSeq !== matchRequestSeq) return;
      matchStatus.value = errorStatus(error, 'studio.focus.failed');
    } finally {
      if (requestSeq === matchRequestSeq) {
        matching.value = false;
        matchProgress.value = null;
      }
    }
  }

  function propagateFrom(refIndex: number, suggest = false): Promise<void> {
    const setIndex = setOf(refIndex);
    if (setIndex < 0) return Promise.resolve();
    const targets = [...ownSetTargets(setIndex, refIndex), ...unmarkedTargetsOutside(setIndex)];
    return propagate(refIndex, targets, suggest);
  }

  function autoFind(): void {
    if (!selectionComplete.value) return;
    const own = manualIn(activeSet.value);
    const elsewhere = lastManual.value;
    const manual =
      own ?? (elsewhere !== null && points[elsewhere] && setOf(elsewhere) >= 0 ? elsewhere : null);
    if (manual !== null) {
      void propagate(manual, ownSetTargets(activeSet.value, manual), false);
      return;
    }

    const ref = order.value[0];
    order.value.filter((index) => index !== ref).forEach(dropPoint);
    void propagate(ref, ownSetTargets(activeSet.value, ref), true);
  }

  const loadingBuffers = new Set<number>();

  function releaseUnusedBuffers(): boolean {
    const wanted = new Set(assignedFrames.value);
    const unused = frameBuffers.indices().filter((index) => !wanted.has(index));
    unused.forEach((index) => frameBuffers.delete(index));
    return unused.length > 0;
  }

  async function loadBuffer(index: number): Promise<void> {
    const frame = frames.value[index];
    if (!frame) return;
    loadingBuffers.add(index);
    try {
      const image = await loadImage(frame.url);
      if (!assignedFrames.value.includes(index)) return;
      const buffer = createFrameBuffer(index, image);
      const current = appliedAdjust(index);
      if (!isIdentityAdjust(current)) rebuildWork(buffer, current);
      frameBuffers.set(buffer);
    } finally {
      loadingBuffers.delete(index);
    }
  }

  async function ensureBuffers(): Promise<void> {
    const released = releaseUnusedBuffers();
    const missing = assignedFrames.value.filter(
      (index) => !frameBuffers.has(index) && !loadingBuffers.has(index)
    );
    if (!missing.length) {
      if (released) bufferVersion.value += 1;
      return;
    }
    await Promise.all(missing.map(loadBuffer));
    bufferVersion.value += 1;
  }

  watch(assignedFrames, () => void ensureBuffers());

  type PrepareStage = 'shrinking' | 'uploading' | 'cutting' | 'grouping' | 'ordering';
  interface PrepareProgress {
    stage: PrepareStage;
    done: number;
    total: number;
  }
  const prepare = shallowRef<PrepareProgress | null>(null);

  function advancePrepare(patch: Partial<PrepareProgress>): void {
    if (prepare.value) prepare.value = { ...prepare.value, ...patch };
  }

  function chooseSetSize(size: SetSize): void {
    if (assignedFrames.value.length) return;
    setSize.value = size;
    saveSetSize(size);
  }

  function setScanMode(mode: ScanMode): void {
    scanMode.value = mode;
    saveScanMode(mode);
    if (isSplitCount(mode)) {
      sharedSplit.value = sharedSplit.value
        ? normalizeSplit({ ...sharedSplit.value, count: mode })
        : defaultSplit(mode);
      scanSplits.value = scanSplits.value.map((item) => normalizeSplit({ ...item, count: mode }));
    }
  }

  function splitFor(index: number): ScanSplit | null {
    if (splitScope.value === 'each') return scanSplits.value[index] ?? sharedSplit.value;
    return sharedSplit.value;
  }

  function setSplit(next: ScanSplit): void {
    const normalized = normalizeSplit(next);
    if (splitScope.value === 'shared') {
      sharedSplit.value = normalized;
      return;
    }
    const copies = scans.value.map(
      (_, index) => scanSplits.value[index] ?? cloneSplit(sharedSplit.value)
    );
    copies[currentScan.value] = normalized;
    scanSplits.value = copies.filter((item): item is ScanSplit => item !== null);
  }

  function setSplitScope(scope: SplitScope): void {
    if (scope === splitScope.value) return;
    const current = cloneSplit(split.value);
    if (scope === 'each') {
      scanSplits.value = scans.value
        .map((_, index) => cloneSplit(scanSplits.value[index] ?? sharedSplit.value))
        .filter((item): item is ScanSplit => item !== null);
    } else {
      sharedSplit.value = current;
    }
    splitScope.value = scope;
  }

  function applySplitToAll(): void {
    const current = split.value;
    if (!current) return;
    sharedSplit.value = cloneSplit(current);
    scanSplits.value = scans.value.map(() => cloneSplit(current) as ScanSplit);
  }

  function selectScan(index: number): void {
    if (index >= 0 && index < scans.value.length) currentScan.value = index;
  }

  function openCutting(): void {
    if (!scans.value.length) return;
    sharedSplit.value ??= defaultSplit(isSplitCount(scanMode.value) ? scanMode.value : 4);
    cutting.value = true;
  }

  function closeCutting(): void {
    if (frames.value.length) cutting.value = false;
  }

  type UploadKind = 'frames' | 'scans';

  interface UploadNotice {
    heavy: number;
    total: number;
    largestMb: number;
    softMb: number;
    hardMb: number;
    side: number;
  }

  const uploadNotice = shallowRef<UploadNotice | null>(null);
  let pendingUpload: { files: File[]; kind: UploadKind } | null = null;

  function uploadKind(): UploadKind {
    return scanMode.value === 1 ? 'frames' : 'scans';
  }

  function maxSideFor(kind: UploadKind): number {
    return kind === 'frames' ? FRAME_MAX_SIDE : SCAN_MAX_SIDE;
  }

  function isFreshRoll(files: File[]): boolean {
    return (
      assignedFrames.value.length === 0 &&
      scans.value.length === 0 &&
      files.length >= setSize.value * 2
    );
  }

  function upload(list: Iterable<File>): Promise<void> {
    const files = pickImageFiles(list);
    if (!files.length) {
      uploadStatus.value = status('studio.upload.noImages', undefined, 'err');
      return Promise.resolve();
    }
    const kind = uploadKind();
    const heavy = files.filter((file) => isHeavy(file));
    if (!heavy.length) return startUpload(files, kind);
    pendingUpload = { files, kind };
    uploadNotice.value = {
      heavy: heavy.length,
      total: files.length,
      largestMb: megabytes(Math.max(...heavy.map((file) => file.size))),
      softMb: megabytes(UPLOAD_SOFT_LIMIT_BYTES),
      hardMb: megabytes(UPLOAD_HARD_LIMIT_BYTES),
      side: maxSideFor(kind)
    };
    return Promise.resolve();
  }

  function confirmUpload(): Promise<void> {
    const pending = pendingUpload;
    pendingUpload = null;
    uploadNotice.value = null;
    return pending ? startUpload(pending.files, pending.kind) : Promise.resolve();
  }

  function cancelUpload(): void {
    pendingUpload = null;
    uploadNotice.value = null;
  }

  async function shrinkForUpload(files: File[], kind: UploadKind): Promise<File[]> {
    const wholeRoll = isFreshRoll(files);
    uploading.value = true;
    if (wholeRoll) prepare.value = { stage: 'shrinking', done: 0, total: files.length };
    try {
      return await shrinkAll(files, maxSideFor(kind), (done) => {
        uploadStatus.value = status('studio.upload.shrinking', { n: files.length, done });
        advancePrepare({ done });
      });
    } finally {
      uploading.value = false;
    }
  }

  async function startUpload(files: File[], kind: UploadKind): Promise<void> {
    const shrunk = await shrinkForUpload(files, kind);
    const accepted = shrunk.filter((file) => !isOverHardLimit(file));
    const skipped = shrunk.length - accepted.length;
    const limitMb = megabytes(UPLOAD_HARD_LIMIT_BYTES);
    if (!accepted.length) {
      prepare.value = null;
      uploadStatus.value = status('studio.upload.allTooLarge', { limitMb }, 'err');
      return;
    }
    if (kind === 'frames') await uploadSingleFrames(accepted);
    else await uploadScans(accepted);
    if (skipped) {
      uploadStatus.value = status('studio.upload.skippedLarge', { n: skipped, limitMb }, 'warn');
    }
  }

  async function uploadScans(files: File[]): Promise<void> {
    uploading.value = true;
    const fresh = isFreshRoll(files);
    if (fresh) prepare.value = { stage: 'uploading', done: 0, total: files.length };
    let done = 0;
    try {
      for (const batch of batchFiles(files)) {
        uploadStatus.value = status('studio.upload.uploading', { n: files.length, done });
        advancePrepare({ done });
        const response = await uploadScansRequest(batch, sessionId.value);
        if (sessionId.value !== response.session_id) {
          forgetServerSession(sessionId.value);
          resetSession();
        }
        sessionId.value = response.session_id;
        response.scans.forEach((scan) => {
          scans.value[scan.index] = scan;
        });
        done += batch.length;
      }
      uploadStatus.value = status('studio.upload.scansDone', { n: scans.value.length }, 'ok');
      currentScan.value = Math.max(0, scans.value.length - done);
      openCutting();
    } catch (error) {
      uploadStatus.value = errorStatus(error, 'studio.upload.failed');
      if (scans.value.length) openCutting();
    } finally {
      uploading.value = false;
      prepare.value = null;
    }
  }

  async function balanceAllSetsFromPalette(): Promise<void> {
    try {
      await ensureTones(assignedFrames.value);
      balanceAllSets();
    } catch {
      return;
    }
  }

  async function cutScans(): Promise<void> {
    const geometry = sharedSplit.value;
    if (!sessionId.value || !geometry || !scans.value.length || cuttingBusy.value) return;
    cuttingBusy.value = true;
    cutStatus.value = status('studio.cut.cutting');
    prepare.value = { stage: 'cutting', done: 0, total: scans.value.length };
    try {
      const response = await splitScans({
        session_id: sessionId.value,
        count: geometry.count,
        axis: geometry.axis,
        box: { ...geometry.box },
        gap: geometry.gap,
        scans:
          splitScope.value === 'each'
            ? scans.value.map((_, index) => scanGeometry(splitFor(index) ?? geometry))
            : undefined
      });
      resetFrameState();
      combinedCrop.value = null;
      frames.value = response.frames.map((frame) => ({ ...frame }));
      const indices = frames.value.map((frame) => frame.index);
      const quads = chunkBy(indices, setSize.value).filter((quad) => quad.length === setSize.value);
      if (quads.length) await replaceSets(quads);
      else {
        order.value = indices.slice(0, setSize.value);
        afterSelectionChange();
      }
      await ensureBuffers();
      await balanceAllSetsFromPalette();
      centerMissingPoints();
      askOutput.value = quads.length > 1;
      cutting.value = false;
      cutStatus.value = status('studio.cut.done', { n: frames.value.length }, 'ok');
      const first = frames.value[0];
      uploadStatus.value = status(
        'studio.upload.done',
        { n: frames.value.length, width: first?.width ?? 0, height: first?.height ?? 0 },
        'ok'
      );
    } catch (error) {
      cutStatus.value = errorStatus(error, 'studio.cut.failed');
    } finally {
      cuttingBusy.value = false;
      prepare.value = null;
    }
  }

  async function uploadSingleFrames(files: File[]): Promise<void> {
    uploading.value = true;
    const freshRoll = assignedFrames.value.length === 0;
    const wholeRoll = isFreshRoll(files);
    if (wholeRoll) prepare.value = { stage: 'uploading', done: 0, total: files.length };
    let done = 0;
    let first: FrameMeta | null = null;
    try {
      for (const batch of batchFiles(files)) {
        uploadStatus.value = status('studio.upload.uploading', { n: files.length, done });
        advancePrepare({ done });
        const response = await uploadFrames(batch, sessionId.value);
        if (sessionId.value !== response.session_id) {
          forgetServerSession(sessionId.value);
          resetSession();
        }
        sessionId.value = response.session_id;
        response.frames.forEach((frame) => {
          frames.value[frame.index] = frame;
        });
        for (const frame of response.frames) {
          if (order.value.length >= setSize.value) break;
          if (setOf(frame.index) < 0) order.value.push(frame.index);
        }
        first ??= response.frames[0] ?? null;
        done += batch.length;
      }
      await ensureBuffers();
      uploadStatus.value = status(
        'studio.upload.done',
        { n: frames.value.length, width: first?.width ?? 0, height: first?.height ?? 0 },
        'ok'
      );
      advancePrepare({ done, stage: 'grouping' });
      const grouped =
        freshRoll && frames.value.length >= setSize.value * 2 && (await groupLibraryBySimilarity());
      if (grouped) balanceAllSets();
      else afterSelectionChange();
      askOutput.value = Boolean(grouped) && sets.value.length > 1;
      centerMissingPoints();
    } catch (error) {
      uploadStatus.value = errorStatus(error, 'studio.upload.failed');
      if (done) afterSelectionChange();
    } finally {
      uploading.value = false;
      prepare.value = null;
    }
  }

  function afterSelectionChange(detect = true): void {
    resetSelectionDerived();
    if (detect && selectionComplete.value) void detectOrder();
  }

  function releaseFrame(index: number): void {
    sets.value.forEach((set, setIndex) => {
      const position = set.frames.indexOf(index);
      if (position < 0) return;
      set.frames.splice(position, 1);
      resetSetDerived(setIndex);
    });
  }

  function toggleSelect(index: number): void {
    const position = order.value.indexOf(index);
    if (position >= 0) {
      order.value.splice(position, 1);
    } else {
      releaseFrame(index);
      if (order.value.length < setSize.value) order.value.push(index);
      else order.value[setSize.value - 1] = index;
    }
    afterSelectionChange();
  }

  function selectRange(start: number): void {
    const n = frames.value.length;
    const from = Math.max(0, Math.min(start, n - setSize.value));
    const next = Array.from({ length: Math.min(setSize.value, n) }, (_, k) => from + k);
    next.forEach(releaseFrame);
    order.value = next;
    afterSelectionChange();
  }

  function selectPrevious(): void {
    const first = order.value.length ? Math.min(...order.value) : 0;
    selectRange(first - setSize.value);
  }

  function selectNext(): void {
    const first = order.value.length ? Math.min(...order.value) : -setSize.value;
    selectRange(first + setSize.value);
  }

  function clearSelection(): void {
    order.value = [];
    afterSelectionChange();
  }

  function unusedFramesAfter(last: number): number[] {
    const used = new Set(assignedFrames.value);
    return frames.value
      .map((frame) => frame.index)
      .filter((index) => !used.has(index) && index > last);
  }

  function nextFreeFrames(): number[] {
    const last = assignedFrames.value.length ? Math.max(...assignedFrames.value) : -1;
    const following = unusedFramesAfter(last);
    const candidates = following.length >= setSize.value ? following : unusedFramesAfter(-1);
    return candidates.slice(0, setSize.value);
  }

  function addSet(): void {
    sets.value.push(newFrameSet(nextFreeFrames(), active.value));
    activeSet.value = sets.value.length - 1;
    afterSelectionChange();
  }

  async function replaceSets(quads: number[][]): Promise<void> {
    if (!quads.length) return;
    const template = setTemplateOf(active.value);
    sets.value = quads.map((quad) => newFrameSet(quad, template));
    centerMissingPoints();
    activeSet.value = 0;
    anchor.value = null;
    matchStatus.value = null;
    advancePrepare({ stage: 'ordering', done: 0, total: sets.value.length });
    let checked = 0;
    await Promise.all(
      sets.value.map((_, setIndex) =>
        detectOrder(setIndex, true).then(() => advancePrepare({ done: ++checked }))
      )
    );
  }

  function startSetAt(frameIndex: number): void {
    const rollOrder = frames.value.map((frame) => frame.index);
    const from = rollOrder.indexOf(frameIndex);
    if (from < 0) return;
    const kept = sets.value.filter(
      (set) => set.frames.length > 0 && set.frames.every((index) => rollOrder.indexOf(index) < from)
    );
    const quads = chunkBy(rollOrder.slice(from), setSize.value).filter(
      (quad) => quad.length === setSize.value
    );
    const template = setTemplateOf(active.value);
    const fresh = quads.map((quad) => newFrameSet(quad, template));
    if (!kept.length && !fresh.length) return;
    sets.value = [...kept, ...fresh];
    activeSet.value = kept.length;
    anchor.value = null;
    matchStatus.value = null;
    fresh.forEach((_, k) => void detectOrder(kept.length + k));
  }

  function splitLibraryIntoSets(): void {
    const quads = chunkBy(
      frames.value.map((frame) => frame.index),
      setSize.value
    ).filter((quad) => quad.length === setSize.value);
    void replaceSets(quads);
  }

  function keepOneSetShown(): void {
    const first = sets.value[0];
    if (first && !shownSetCount.value) first.hidden = false;
  }

  function canHideSet(setIndex: number): boolean {
    const set = sets.value[setIndex];
    if (!set) return false;
    return set.hidden || shownSetCount.value > 1;
  }

  function toggleSetHidden(setIndex: number): void {
    const set = sets.value[setIndex];
    if (!set || !canHideSet(setIndex)) return;
    set.hidden = !set.hidden;
    combinedAnchor.value = null;
    matchStatus.value = null;
  }

  function removeSet(setIndex: number): void {
    if (setIndex < 0 || setIndex >= sets.value.length) return;
    if (sets.value.length === 1) {
      clearSelection();
      return;
    }
    sets.value.splice(setIndex, 1);
    if (activeSet.value > setIndex) activeSet.value -= 1;
    activeSet.value = Math.min(activeSet.value, sets.value.length - 1);
    keepOneSetShown();
    combinedAnchor.value = null;
    matchStatus.value = null;
  }

  function selectSet(setIndex: number): void {
    if (setIndex < 0 || setIndex >= sets.value.length) return;
    activeSet.value = setIndex;
    matchStatus.value = null;
  }

  function applyOrder(next: number[]): void {
    order.value = next;
    anchor.value = null;
  }

  function moveFrame(from: number, to: number): void {
    if (from === to || to < 0 || to >= order.value.length) return;
    applyOrder(moveWithin(order.value, from, to));
  }

  function swapFrames(position: number, direction: -1 | 1): void {
    const target = position + direction;
    if (target < 0 || target >= order.value.length) return;
    const next = order.value.slice();
    [next[position], next[target]] = [next[target], next[position]];
    applyOrder(next);
  }

  function reverseOrder(): void {
    if (order.value.length) applyOrder(order.value.slice().reverse());
  }

  function setOrderDirection(direction: OrderDirection): void {
    if (!order.value.length || orderDirection.value === direction) return;
    const ascending = order.value.slice().sort((a, b) => a - b);
    applyOrder(direction === 'forward' ? ascending : ascending.reverse());
  }

  type DirectionPlan = 'forward' | 'backward' | 'alternate' | 'random';

  function setAllDirections(plan: DirectionPlan, pick: () => number = Math.random): void {
    sets.value.forEach((set, setIndex) => {
      if (set.frames.length !== setSize.value) return;
      const ascending = set.frames.slice().sort((a, b) => a - b);
      const backward =
        plan === 'backward' ||
        (plan === 'alternate' && setIndex % 2 === 1) ||
        (plan === 'random' && pick() < 0.5);
      set.frames.splice(0, set.frames.length, ...(backward ? ascending.reverse() : ascending));
    });
    anchor.value = null;
  }

  const shuffling = ref(false);
  const shuffleStatus = shallowRef<StatusMessage | null>(null);

  async function groupLibraryBySimilarity(): Promise<boolean> {
    if (!sessionId.value || frames.value.length < setSize.value || shuffling.value) return false;
    shuffling.value = true;
    shuffleStatus.value = status('studio.sets.grouping');
    try {
      const indices = frames.value.map((frame) => frame.index);
      const { features } = await fetchPalette(sessionId.value, indices);
      rememberTones(features);
      const byIndex = new Map(features.map((f) => [f.index, f.structure ?? []]));
      const groups = groupSimilar(
        indices.map((index) => byIndex.get(index) ?? []),
        setSize.value
      ).map((group) => group.map((k) => indices[k]));
      await replaceSets(groups);
      shuffleStatus.value = status('studio.sets.grouped', { n: groups.length }, 'ok');
      return groups.length > 0;
    } catch (error) {
      shuffleStatus.value = errorStatus(error, 'studio.sets.groupFailed');
      return false;
    } finally {
      shuffling.value = false;
    }
  }

  function correctAllOrders(): void {
    sets.value.forEach((set, setIndex) => {
      if (set.frames.length === setSize.value) void detectOrder(setIndex, true);
    });
  }

  async function shuffleSets(mode: ShuffleMode): Promise<void> {
    if (!sessionId.value || sets.value.length < 2 || shuffling.value) return;
    shuffling.value = true;
    shuffleStatus.value = status('studio.sets.shuffling');
    try {
      const { features } = await fetchPalette(sessionId.value, assignedFrames.value);
      const byIndex = new Map(features.map((f) => [f.index, f.signature]));
      const signatures = sets.value.map((set) =>
        meanSignature(set.frames.map((index) => byIndex.get(index) ?? []))
      );
      const current = active.value;
      sets.value = orderBy(mode, signatures).map((k) => sets.value[k]);
      activeSet.value = sets.value.indexOf(current);
      combinedAnchor.value = null;
      shuffleStatus.value = status(`studio.sets.shuffled.${mode}`, undefined, 'ok');
    } catch (error) {
      shuffleStatus.value = errorStatus(error, 'studio.sets.shuffleFailed');
    } finally {
      shuffling.value = false;
    }
  }

  function moveSet(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= sets.value.length || to >= sets.value.length) {
      return;
    }
    const current = active.value;
    sets.value = moveWithin(sets.value, from, to);
    activeSet.value = sets.value.indexOf(current);
    combinedAnchor.value = null;
  }

  async function detectOrder(setIndex = activeSet.value, autoApply = false): Promise<void> {
    const set = sets.value[setIndex];
    if (!sessionId.value || !set || set.frames.length !== setSize.value) return;
    const requestSeq = ++set.orderSeq;
    const requestOrder = set.frames.slice();
    const withPoints = requestOrder.every((index) => isPlacedByUserOrSearch(index));
    set.detecting = true;
    set.suggestedOrder = null;
    set.orderStatus = status('studio.order.detecting');
    try {
      const data = await detectOrderRequest({
        session_id: sessionId.value,
        order: requestOrder,
        points: withPoints ? requestOrder.map((index) => points[index]) : null
      });
      if (requestSeq !== set.orderSeq) return;
      applyDetection(
        set,
        requestOrder,
        data.order,
        data.confidence ?? 0,
        data.direction_confident ?? true,
        data.parallax_px ?? 0,
        data.error?.message,
        autoApply
      );
    } catch (error) {
      if (requestSeq !== set.orderSeq) return;
      set.orderStatus = errorStatus(error, 'studio.order.failed');
    } finally {
      if (requestSeq === set.orderSeq) set.detecting = false;
    }
  }

  function applyDetection(
    set: FrameSet,
    requestOrder: number[],
    detected: number[] | null,
    confidence: number,
    directionConfident: boolean,
    parallaxPx: number,
    errorMessage: string | undefined,
    autoApply = false
  ): void {
    if (!detected) {
      set.orderStatus = status('studio.order.undetermined', { reason: errorMessage ?? '' }, 'warn');
      return;
    }
    const permutation =
      detected.length === requestOrder.length &&
      detected.every((value) => requestOrder.includes(value));
    if (!permutation) {
      set.orderStatus = status('studio.order.undetermined', { reason: '' }, 'warn');
      return;
    }
    const percent = Math.round(confidence * 100);
    const same = detected.every((value, k) => value === requestOrder[k]);
    const reversed = detected.every(
      (value, k) => value === requestOrder[requestOrder.length - 1 - k]
    );
    const names = detected.map((index) => requestOrder.indexOf(index) + 1).join('-');
    const params = { conf: percent, names, px: parallaxPx, guessed: directionConfident ? 0 : 1 };
    if (confidence < MIN_ORDER_CONFIDENCE) {
      set.orderStatus = status('studio.order.lowParallax', params, 'warn');
    } else if (same || reversed) {
      set.orderStatus = status('studio.order.confirmed', params, 'ok');
    } else if (autoApply) {
      set.frames.splice(0, set.frames.length, ...detected);
      anchor.value = null;
      set.orderStatus = status('studio.order.corrected', params, 'ok');
    } else {
      set.suggestedOrder = detected;
      set.orderStatus = status('studio.order.looksOrder', params, 'warn');
    }
  }

  function applySuggestedOrder(): void {
    const set = active.value;
    if (!set.suggestedOrder) return;
    applyOrder(set.suggestedOrder);
    set.suggestedOrder = null;
    set.orderStatus = status('studio.order.applied', undefined, 'ok');
  }

  const snapshot = computed<StudioSnapshot>(() => ({
    version: SNAPSHOT_VERSION,
    sessionId: sessionId.value,
    frames: frames.value.map((frame) => ({ ...frame })),
    sets: sets.value.map((set) => ({
      frames: set.frames.slice(),
      adjust: { ...set.adjust },
      grouped: set.grouped,
      balanced: set.balanced,
      hidden: set.hidden,
      loop: set.loop,
      patternText: set.patternText,
      cycles: set.cycles,
      anchor: set.anchor ? { ...set.anchor } : null,
      customCrop: set.customCrop ? { ...set.customCrop } : null
    })),
    activeSet: activeSet.value,
    points: { ...points },
    pointMeta: { ...pointMeta },
    lastManual: lastManual.value,
    anchor: combinedAnchor.value ? { ...combinedAnchor.value } : null,
    customCrop: combinedCrop.value ? { ...combinedCrop.value } : null,
    perFrameAdjust: { ...adjust.per },
    settings: { ...settings },
    autoMatch: autoMatch.value,
    renders: renders.value.slice(),
    currentRenderName: currentRender.value?.video_name ?? null,
    batch: batch.value ? structuredClone(toRaw(batch.value)) : null,
    scanMode: scanMode.value,
    setSize: setSize.value,
    scans: scans.value.map((scan) => ({ ...scan })),
    split: cloneSplit(sharedSplit.value),
    splitScope: splitScope.value,
    scanSplits: scanSplits.value.map((item) => cloneSplit(item) as ScanSplit),
    cutting: cutting.value
  }));

  function applySnapshot(saved: StudioSnapshot): void {
    frameBuffers.clear();
    sessionId.value = saved.sessionId;
    frames.value = saved.frames.map((frame) => ({ ...frame }));
    const legacy = saved.settings;
    const legacyLoop = isLoopMode(legacy.mode) ? legacy.mode : DEFAULT_LOOP;
    const legacyCycles = legacySetCycles(
      legacy.setMode ?? 'forward',
      saved.sets.length,
      legacy.cyclesPerSet ?? 1
    );
    sets.value = saved.sets.length
      ? saved.sets.map((set, setIndex) => ({
          ...newFrameSet(set.frames.slice(), {
            adjust: set.adjust,
            grouped: set.grouped,
            balanced: Boolean(set.balanced),
            loop: isLoopMode(set.loop) ? set.loop : legacyLoop,
            patternText: set.patternText ?? legacy.patternText ?? '',
            cycles: clampCycles(set.cycles ?? legacyCycles[setIndex] ?? 1)
          }),
          hidden: Boolean(set.hidden),
          anchor: set.anchor ? { ...set.anchor } : null,
          customCrop: set.customCrop ? { ...set.customCrop } : null
        }))
      : [newFrameSet()];
    keepOneSetShown();
    activeSet.value = Math.min(Math.max(0, saved.activeSet), sets.value.length - 1);
    Object.keys(points).forEach((key) => delete points[Number(key)]);
    Object.keys(pointMeta).forEach((key) => delete pointMeta[Number(key)]);
    Object.entries(saved.points).forEach(([key, point]) => {
      points[Number(key)] = { ...point };
    });
    Object.entries(saved.pointMeta).forEach(([key, meta]) => {
      pointMeta[Number(key)] = { ...meta };
    });
    lastManual.value = saved.lastManual;
    combinedAnchor.value = saved.anchor ? { ...saved.anchor } : null;
    combinedCrop.value = saved.customCrop ? { ...saved.customCrop } : null;
    adjust.per = Object.fromEntries(
      Object.entries(saved.perFrameAdjust).map(([key, value]) => [key, { ...value }])
    );
    Object.assign(settings, defaultSettings(), pickSettings(saved.settings));
    settings.setMode = baseSetMode(settings.setMode);
    if (!isOutputMode(settings.output)) settings.output = 'combined';
    autoMatch.value = saved.autoMatch;
    renders.value = saved.renders.slice();
    batch.value = saved.batch ? structuredClone(saved.batch) : null;
    currentRender.value =
      [...renders.value, ...(batch.value ? batchRenders(batch.value) : [])].find(
        (item) => item.video_name === saved.currentRenderName
      ) ?? null;
    askOutput.value = false;
    scans.value = (saved.scans ?? []).map((scan) => ({ ...scan }));
    sharedSplit.value = saved.split
      ? normalizeSplit({ ...saved.split, box: { ...saved.split.box } })
      : null;
    splitScope.value = saved.splitScope === 'each' ? 'each' : 'shared';
    scanSplits.value = (saved.scanSplits ?? []).map((item) =>
      normalizeSplit({ ...item, box: { ...item.box } })
    );
    cutting.value = saved.cutting ?? (scans.value.length > 0 && frames.value.length === 0);
    currentScan.value = 0;
    if (saved.scanMode) setScanMode(saved.scanMode);
    setSize.value = isSetSize(saved.setSize) ? saved.setSize : DEFAULT_SET_SIZE;
    matchStatus.value = null;
    renderStatus.value = null;
    cutStatus.value = null;
  }

  function forgetServerSession(sid: string | null): void {
    if (sid) void closeSession(sid).catch(() => undefined);
  }

  function resetAll(): void {
    forgetServerSession(sessionId.value);
    resetSession();
    sessionId.value = null;
    Object.assign(settings, defaultSettings());
    combinedCrop.value = null;
    autoMatch.value = true;
    uploadStatus.value = null;
    matchStatus.value = null;
    renderStatus.value = null;
    cutStatus.value = null;
    clearLocalSnapshot();
  }

  async function verifySession(): Promise<boolean> {
    const first = frames.value[0];
    const firstScan = scans.value[0];
    if (!sessionId.value || (!first && !firstScan)) return true;
    const probe = first ? (first.thumb_url ?? first.url) : firstScan.thumb_url;
    const alive = await frameAvailable(probe);
    if (alive) {
      await ensureBuffers();
      return true;
    }
    resetAll();
    uploadStatus.value = status('studio.upload.expired', undefined, 'warn');
    return false;
  }

  let restored = false;

  async function restoreLocal(): Promise<void> {
    if (restored) return;
    restored = true;
    const saved = loadLocalSnapshot();
    if (!saved || (!saved.frames.length && !saved.scans?.length)) return;
    applySnapshot(saved);
    if (await verifySession()) {
      const restoredKey = frames.value.length
        ? 'studio.upload.restored'
        : 'studio.upload.restoredScans';
      const n = frames.value.length || scans.value.length;
      uploadStatus.value = status(restoredKey, { n }, 'ok');
      void resumeBatch();
    }
  }

  let localSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleLocalSave(): void {
    if (localSaveTimer) clearTimeout(localSaveTimer);
    localSaveTimer = setTimeout(() => {
      localSaveTimer = null;
      if (frames.value.length || scans.value.length) saveLocalSnapshot(snapshot.value);
      else clearLocalSnapshot();
    }, LOCAL_SAVE_DEBOUNCE_MS);
  }

  watch(snapshot, scheduleLocalSave);

  return {
    sessionId,
    frames,
    sets,
    activeSet,
    order,
    points,
    pointMeta,
    lastManual,
    anchor,
    adjust,
    settings,
    autoMatch,
    renders,
    currentRender,
    batch,
    batchRunning,
    askOutput,
    separate,
    animatedSets,
    animatedSetCount,
    previewIncompleteSet,
    previewUnmarkedSet,
    batchReady,
    setOutputMode,
    chooseOutput,
    stopBatch,
    bufferVersion,
    uploading,
    uploadStatus,
    prepare,
    scanMode,
    setSize,
    chooseSetSize,
    scans,
    split,
    splitScope,
    splitFor,
    setSplitScope,
    applySplitToAll,
    cutting,
    cuttingBusy,
    cutStatus,
    currentScan,
    setScanMode,
    setSplit,
    selectScan,
    openCutting,
    closeCutting,
    uploadScans,
    cutScans,
    uploadNotice,
    confirmUpload,
    cancelUpload,
    orderStatus,
    orderDirection,
    matchStatus,
    suggestedOrder,
    detectingOrder,
    matching,
    matchProgress,
    frameCount,
    setCount,
    shownSets,
    shownSetCount,
    assignedFrames,
    canHideSet,
    toggleSetHidden,
    flatOrder,
    selectionComplete,
    seriesComplete,
    orderedFrames,
    pointsCount,
    seriesPointsCount,
    allPointsSet,
    seriesPointsSet,
    incompleteSet,
    unmarkedSet,
    patternValid,
    patternOf,
    sweeping,
    synced,
    composition,
    pass,
    clipVisits,
    setLoop,
    setPatternText,
    setCycles,
    applyDwellPreset,
    applyLoopToAll,
    moveFrameInSet,
    sequence,
    composites,
    layout,
    canRender,
    rendering,
    renderStatus,
    panAnchor,
    setAnchor,
    resetAnchor,
    render,
    renderActiveSet,
    canRenderActive,
    showRender,
    hasAdjustments,
    customCrop,
    startCustomCrop,
    choosePreset,
    setCustomCrop,
    centerCustomCrop,
    tones,
    balanceSuggestion,
    applyBalance,
    balanceAllSets,
    adjustGrouped,
    adjustBalanced,
    toggleBalance,
    sharedAdjust,
    adjustFor,

    setAdjust,
    resetAdjust,
    setAdjustGroup,
    upload,
    toggleSelect,
    selectRange,
    selectPrevious,
    selectNext,
    clearSelection,
    addSet,
    splitLibraryIntoSets,
    startSetAt,
    groupLibraryBySimilarity,
    correctAllOrders,

    removeSet,
    selectSet,
    setOf,
    pointsInSet,
    isPlacedByUserOrSearch,
    applyOrder,
    moveFrame,
    swapFrames,
    reverseOrder,
    setOrderDirection,
    setAllDirections,
    moveSet,
    shuffleSets,
    shuffling,
    shuffleStatus,

    detectOrder,
    applySuggestedOrder,
    setPoint,
    nudgePoint,
    afterManualPoint,
    clearPoints,
    propagateFrom,
    autoFind,
    snapshot,
    applySnapshot,
    resetAll,
    restoreLocal
  };
});
