import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BatchState,
  FrameMeta,
  MatchResponse,
  OrderResponse,
  RenderResponse,
  ScansResponse,
  UploadResponse
} from '@/api/types';
import { ApiError } from '@/api/ApiError';

vi.mock('@/api/renderApi', () => ({
  uploadFrames: vi.fn(),
  uploadScans: vi.fn(),
  splitScans: vi.fn(),
  detectOrder: vi.fn(),
  matchPoint: vi.fn(),
  renderVideo: vi.fn(),
  startBatch: vi.fn(),
  fetchBatch: vi.fn(),
  cancelBatch: vi.fn(),
  frameAvailable: vi.fn(async () => true),
  fetchPalette: vi.fn(),
  closeSession: vi.fn(async () => ({ closed: true }))
}));

vi.mock('@/lib/shrink', async () => {
  const actual = await vi.importActual<typeof import('@/lib/shrink')>('@/lib/shrink');
  return { ...actual, shrinkAll: vi.fn(actual.shrinkAll) };
});

vi.mock('@/lib/frameBuffers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/frameBuffers')>('@/lib/frameBuffers');
  return {
    ...actual,
    loadImage: vi.fn(async () => ({}) as HTMLImageElement),
    createFrameBuffer: vi.fn((index: number) => ({ index, version: 0 })),
    rebuildWork: vi.fn()
  };
});

import {
  cancelBatch,
  detectOrder,
  fetchBatch,
  fetchPalette,
  frameAvailable,
  matchPoint,
  renderVideo,
  splitScans,
  startBatch,
  uploadFrames,
  uploadScans
} from '@/api/renderApi';
import { jpegName, MEGABYTE, shrinkAll } from '@/lib/shrink';
import { loadLocalSnapshot } from '@/lib/studioSnapshot';
import { rebuildWork } from '@/lib/frameBuffers';
import {
  ADJUST_DEBOUNCE_MS,
  BATCH_POLL_MS,
  batchFiles,
  frameBuffers,
  LOCAL_SAVE_DEBOUNCE_MS,
  moveWithin,
  orderDirectionOf,
  pickImageFiles,
  useStudioStore
} from '@/stores/studio';

const mockedUpload = vi.mocked(uploadFrames);
const mockedDetect = vi.mocked(detectOrder);
const mockedMatch = vi.mocked(matchPoint);
const mockedRebuild = vi.mocked(rebuildWork);
const mockedRender = vi.mocked(renderVideo);
const mockedUploadScans = vi.mocked(uploadScans);
const mockedSplit = vi.mocked(splitScans);
const mockedPalette = vi.mocked(fetchPalette);
const mockedShrinkAll = vi.mocked(shrinkAll);

function frame(index: number): FrameMeta {
  return {
    index,
    name: `f${index}.png`,
    width: 400,
    height: 300,
    url: `/api/render/frames/s/${index}`,
    thumb_url: `/api/render/frames/s/${index}/thumb`
  };
}

function uploadResponse(sessionId: string, indices: number[]): UploadResponse {
  return { session_id: sessionId, frames: indices.map(frame), total: indices.length };
}

function file(name: string, type = 'image/png'): File {
  return new File(['x'], name, { type });
}

describe('pickImageFiles', () => {
  it('keeps images, accepts raw extensions and sorts numerically', () => {
    const picked = pickImageFiles([
      file('scan10.png'),
      file('notes.txt', 'text/plain'),
      file('scan2.tif', ''),
      file('scan1.png')
    ]);
    expect(picked.map((f) => f.name)).toEqual(['scan1.png', 'scan2.tif', 'scan10.png']);
  });
});

describe('batchFiles', () => {
  function sized(name: string, bytes: number): File {
    return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
  }

  it('splits by total size and by count, keeping oversized files alone', () => {
    const files = [sized('a', 6), sized('b', 6), sized('c', 6), sized('d', 20), sized('e', 1)];
    expect(batchFiles(files, 12, 10).map((batch) => batch.map((f) => f.name))).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
      ['e']
    ]);
    expect(batchFiles(files, 1000, 2).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batchFiles([], 10, 10)).toEqual([]);
  });
});

describe('moveWithin', () => {
  it('moves an element to the target position', () => {
    expect(moveWithin([0, 1, 2, 3], 0, 2)).toEqual([1, 2, 0, 3]);
    expect(moveWithin([0, 1, 2, 3], 3, 0)).toEqual([3, 0, 1, 2]);
  });
});

describe('studio store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockResolvedValue({
      order: [0, 1, 2, 3],
      confidence: 0.9,
      direction_confident: true
    });
  });

  it('uploads, selects the first four frames and detects the order', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    expect(store.sessionId).toBe('s1');
    expect(store.frameCount).toBe(6);
    expect(store.order).toEqual([0, 1, 2, 3]);
    expect(frameBuffers.indices()).toEqual([0, 1, 2, 3]);
    expect(store.uploadStatus?.key).toBe('studio.upload.done');
    await vi.waitFor(() => expect(store.orderStatus?.key).toBe('studio.order.confirmed'));
    expect(mockedDetect).toHaveBeenCalledWith({
      session_id: 's1',
      order: [0, 1, 2, 3],
      points: null
    });
  });

  it('uploads a big roll in batches into one session and reports progress', async () => {
    const files = Array.from({ length: 50 }, (_, k) => file(`scan${k}.png`));
    mockedUpload.mockImplementation(async (batch: File[], sessionId: string | null) => {
      const start = sessionId ? 24 * mockedUpload.mock.calls.length - 24 : 0;
      return uploadResponse(
        's1',
        batch.map((_, k) => start + k)
      );
    });
    const store = useStudioStore();
    const pending = store.upload(files);
    await vi.waitFor(() => expect(store.uploadStatus?.params).toMatchObject({ n: 50, done: 0 }));
    await pending;
    expect(mockedUpload).toHaveBeenCalledTimes(3);
    expect(mockedUpload.mock.calls.map((call) => call[0].length)).toEqual([24, 24, 2]);
    expect(mockedUpload.mock.calls[0][1]).toBeNull();
    expect(mockedUpload.mock.calls[1][1]).toBe('s1');
    expect(store.frameCount).toBe(50);
    expect(store.order).toEqual([0, 1, 2, 3]);
    expect(store.uploadStatus).toMatchObject({ key: 'studio.upload.done', params: { n: 50 } });
  });

  it('keeps the frames that were uploaded before a failing batch', async () => {
    const files = Array.from({ length: 30 }, (_, k) => file(`scan${k}.png`));
    mockedUpload.mockResolvedValueOnce(
      uploadResponse(
        's1',
        Array.from({ length: 24 }, (_, k) => k)
      )
    );
    mockedUpload.mockRejectedValueOnce(
      new ApiError('render', 429, { code: 'rate.too_many_requests', message: 'slow', params: {} })
    );
    const store = useStudioStore();
    await store.upload(files);
    expect(store.frameCount).toBe(24);
    expect(store.order).toEqual([0, 1, 2, 3]);
    expect(store.uploadStatus?.key).toBe('errors.render.rate.too_many_requests');
  });

  it('appends to the same session and resets on a new one', async () => {
    mockedUpload.mockResolvedValueOnce(uploadResponse('s1', [0, 1]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    mockedUpload.mockResolvedValueOnce(uploadResponse('s1', [2, 3]));
    await store.upload([file('b.png')]);
    expect(mockedUpload).toHaveBeenLastCalledWith(expect.any(Array), 's1');
    expect(store.order).toEqual([0, 1, 2, 3]);
    mockedUpload.mockResolvedValueOnce(uploadResponse('s2', [0]));
    await store.upload([file('c.png')]);
    expect(store.frameCount).toBe(1);
    expect(store.order).toEqual([0]);
  });

  it('reports upload errors as translatable statuses', async () => {
    mockedUpload.mockRejectedValue(
      new ApiError('render', 400, {
        code: 'upload.unsupported_format',
        message: 'Bad',
        params: { filename: 'x' }
      })
    );
    const store = useStudioStore();
    await store.upload([file('x.png')]);
    expect(store.uploadStatus).toMatchObject({
      key: 'errors.render.upload.unsupported_format',
      tone: 'err',
      params: { filename: 'x' }
    });
    await store.upload([file('readme.md', 'text/markdown')]);
    expect(store.uploadStatus?.key).toBe('studio.upload.noImages');
  });

  it('toggles selection, replaces the last slot when full and pages by four', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.toggleSelect(1);
    expect(store.order).toEqual([0, 2, 3]);
    store.toggleSelect(5);
    store.toggleSelect(6);
    expect(store.order).toEqual([0, 2, 3, 6]);
    store.selectNext();
    expect(store.order).toEqual([4, 5, 6, 7]);
    store.selectNext();
    expect(store.order).toEqual([4, 5, 6, 7]);
    store.selectPrevious();
    expect(store.order).toEqual([0, 1, 2, 3]);
    store.clearSelection();
    expect(store.order).toEqual([]);
  });

  it('reorders by move, swap and reverse and clears the anchor', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.anchor = { x: 0.3, y: 0.4 };
    store.moveFrame(0, 3);
    expect(store.order).toEqual([1, 2, 3, 0]);
    expect(store.anchor).toBeNull();
    store.swapFrames(0, 1);
    expect(store.order).toEqual([2, 1, 3, 0]);
    store.swapFrames(3, 1);
    expect(store.order).toEqual([2, 1, 3, 0]);
    store.reverseOrder();
    expect(store.order).toEqual([0, 3, 1, 2]);
  });

  it('suggests a detected order and applies it', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
    mockedDetect.mockResolvedValue({
      order: [1, 0, 3, 2],
      confidence: 0.8,
      direction_confident: false
    });
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    await vi.waitFor(() => expect(store.orderStatus?.key).toBe('studio.order.looksOrder'));
    expect(store.orderStatus?.params).toMatchObject({ conf: 80, guessed: 1 });
    expect(store.suggestedOrder).toEqual([1, 0, 3, 2]);
    store.applySuggestedOrder();
    expect(store.order).toEqual([1, 0, 3, 2]);
    expect(store.orderStatus?.key).toBe('studio.order.applied');
  });

  it('treats the reversed order as confirmed', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
    mockedDetect.mockResolvedValue({ order: [3, 2, 1, 0], confidence: 0.8 });
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    await vi.waitFor(() => expect(store.orderStatus?.key).toBe('studio.order.confirmed'));
    expect(store.suggestedOrder).toBeNull();
    expect(store.order).toEqual([0, 1, 2, 3]);
  });

  it('corrects the order in every set at once', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
    mockedDetect.mockImplementation(async (req) => ({ order: req.order, confidence: 0.9 }));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    await vi.waitFor(() => expect(store.sets[1].orderStatus?.key).toBe('studio.order.confirmed'));
    mockedDetect.mockImplementation(async (req) => ({
      order: [req.order[1], req.order[0], req.order[3], req.order[2]],
      confidence: 0.9
    }));
    store.correctAllOrders();
    await vi.waitFor(() => expect(store.sets[1].orderStatus?.key).toBe('studio.order.corrected'));
    expect(store.sets[0].frames).toEqual([1, 0, 3, 2]);
    expect(store.sets[1].frames).toEqual([5, 4, 7, 6]);
    expect(store.sets[1].suggestedOrder).toBeNull();
  });

  it('reports low parallax and undetermined results without suggesting', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
    mockedDetect.mockResolvedValue({ order: [1, 0, 2, 3], confidence: 0.1, parallax_px: 0.4 });
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    await vi.waitFor(() => expect(store.orderStatus?.key).toBe('studio.order.lowParallax'));
    expect(store.suggestedOrder).toBeNull();
    const undetermined: OrderResponse = {
      order: null,
      error: { code: 'render.too_few_features', message: 'Not enough detail', params: {} }
    };
    mockedDetect.mockResolvedValue(undetermined);
    await store.detectOrder();
    expect(store.orderStatus).toMatchObject({ key: 'studio.order.undetermined', tone: 'warn' });
  });

  it('ignores stale order responses', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    await vi.waitFor(() => expect(store.orderStatus?.key).toBe('studio.order.confirmed'));
    let resolveFirst!: (value: OrderResponse) => void;
    mockedDetect.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)));
    mockedDetect.mockResolvedValueOnce({ order: [0, 1, 2, 3], confidence: 0.95 });
    const first = store.detectOrder();
    const second = store.detectOrder();
    await second;
    resolveFirst({ order: [3, 2, 1, 0], confidence: 0.99 });
    await first;
    expect(store.orderStatus?.key).toBe('studio.order.confirmed');
    expect(store.suggestedOrder).toBeNull();
  });
});

describe('studio store · focus points', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedMatch.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
  });

  it('sets a manual point clamped to the frame and propagates to the others', async () => {
    mockedMatch.mockResolvedValue({
      ref: { index: 0, x: 100, y: 50, suggested: false },
      results: [
        { index: 1, x: 90, y: 51, score: 0.9 },
        { index: 2, x: 110, y: 49, score: 0.4 },
        { index: 3, x: 120, y: 50, score: 0.8 }
      ]
    });
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.setPoint(0, { x: 100, y: 999 });
    expect(store.points[0]).toEqual({ x: 100, y: 299 });
    expect(store.pointMeta[0]).toEqual({ source: 'manual' });
    expect(store.lastManual).toBe(0);
    store.afterManualPoint(0);
    await vi.waitFor(() => expect(store.matching).toBe(false));
    expect(mockedMatch).toHaveBeenCalledWith({
      session_id: 's1',
      ref_index: 0,
      point: { x: 100, y: 299 },
      targets: [1, 2, 3]
    });
    expect(store.pointsCount).toBe(4);
    expect(store.pointMeta[2]).toEqual({ source: 'auto', score: 0.4 });
    expect(store.matchStatus).toMatchObject({
      key: 'studio.focus.foundLow',
      tone: 'warn',
      params: { n: 3, low: 1 }
    });
    await vi.waitFor(() => expect(mockedDetect).toHaveBeenCalledTimes(2));
    expect(mockedDetect.mock.calls[1][0].points).toHaveLength(4);
  });

  it('keeps a single manual point per set and moves it to the last clicked frame', async () => {
    mockedMatch.mockResolvedValue({ ref: { index: 0, x: 1, y: 1, suggested: false }, results: [] });
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.setPoint(1, { x: 5, y: 5 });
    store.setPoint(0, { x: 1, y: 1 });
    expect(store.points[1]).toBeUndefined();
    expect(store.pointMeta[0]).toEqual({ source: 'manual' });
    await store.propagateFrom(0);
    expect(mockedMatch.mock.calls[0][0].targets).toEqual([1, 2, 3]);
    store.nudgePoint(0, 1, 0);
    expect(store.points[0]).toEqual({ x: 2, y: 1 });
    expect(store.pointMeta[0]).toEqual({ source: 'manual' });
  });

  it('autoFind searches again from the manual point of the active set', async () => {
    mockedMatch.mockResolvedValue({
      ref: { index: 2, x: 50, y: 50, suggested: false },
      results: [0, 1, 3].map((index) => ({ index, x: 50, y: 50, score: 0.7 }))
    });
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.setPoint(2, { x: 50, y: 50 });
    store.afterManualPoint(2);
    await vi.waitFor(() => expect(store.matching).toBe(false));
    store.autoFind();
    await vi.waitFor(() => expect(mockedMatch).toHaveBeenCalledTimes(2));
    expect(mockedMatch.mock.calls[1][0]).toMatchObject({
      ref_index: 2,
      point: { x: 50, y: 50 },
      targets: [0, 1, 3]
    });
    await vi.waitFor(() => expect(store.matching).toBe(false));
    expect(store.pointMeta[2]).toEqual({ source: 'manual' });
    expect(store.pointMeta[0]).toEqual({ source: 'auto', score: 0.7 });
  });

  it('autoFind asks the server for a suggested point when nothing is manual', async () => {
    mockedMatch.mockResolvedValue({
      ref: { index: 0, x: 200, y: 150, suggested: true },
      results: [1, 2, 3].map((index) => ({ index, x: 200, y: 150, score: 0.95 }))
    });
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.autoFind();
    await vi.waitFor(() => expect(store.pointsCount).toBe(4));
    expect(mockedMatch.mock.calls[0][0]).toMatchObject({ ref_index: 0, point: null });
    expect(store.pointMeta[0]).toEqual({ source: 'auto', score: 1 });
    expect(store.matchStatus?.tone).toBe('ok');
  });

  it('clearPoints drops everything and ignores late responses', async () => {
    let resolveMatch!: (value: MatchResponse) => void;
    mockedMatch.mockReturnValue(new Promise((resolve) => (resolveMatch = resolve)));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.setPoint(0, { x: 1, y: 1 });
    store.afterManualPoint(0);
    store.clearPoints();
    expect(store.pointsCount).toBe(0);
    expect(store.lastManual).toBeNull();
    resolveMatch({
      ref: { index: 0, x: 1, y: 1, suggested: false },
      results: [{ index: 1, x: 2, y: 2, score: 0.9 }]
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.pointsCount).toBe(0);
    expect(store.matchStatus).toBeNull();
  });

  it('nudgePoint moves an existing point and does nothing without one', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.clearPoints();
    store.nudgePoint(0, 5, 5);
    expect(store.points[0]).toBeUndefined();
    store.setPoint(0, { x: 10, y: 10 });
    store.nudgePoint(0, -20, 3);
    expect(store.points[0]).toEqual({ x: 0, y: 13 });
  });
});

describe('studio store · adjustments', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedRebuild.mockClear();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies shared sliders to every frame after a debounce', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    const versionBefore = store.bufferVersion;
    store.setAdjust(null, 'brightness', 20);
    store.setAdjust(null, 'contrast', -10);
    expect(mockedRebuild).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ADJUST_DEBOUNCE_MS);
    expect(mockedRebuild).toHaveBeenCalledTimes(4);
    expect(mockedRebuild.mock.calls[0][1]).toEqual({ brightness: 20, contrast: -10, sharpen: 0 });
    expect(store.bufferVersion).toBe(versionBefore + 1);
    expect(store.hasAdjustments).toBe(true);
  });

  it('starts per-frame values from the shared ones and rebuilds only the touched frame', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.setAdjust(null, 'sharpen', 2);
    vi.advanceTimersByTime(ADJUST_DEBOUNCE_MS);
    mockedRebuild.mockClear();
    store.setAdjustGroup(false);
    vi.advanceTimersByTime(ADJUST_DEBOUNCE_MS);
    expect(store.adjust.per[3]).toEqual({ brightness: 0, contrast: 0, sharpen: 2 });
    mockedRebuild.mockClear();
    store.setAdjust(1, 'brightness', 30);
    vi.advanceTimersByTime(ADJUST_DEBOUNCE_MS);
    expect(mockedRebuild).toHaveBeenCalledTimes(1);
    expect(mockedRebuild.mock.calls[0][0]).toMatchObject({ index: 1 });
    expect(store.adjustFor(1).brightness).toBe(30);
    expect(store.adjustFor(0).brightness).toBe(0);
  });

  it('resets one frame or everything', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.setAdjustGroup(false);
    store.setAdjust(2, 'contrast', 50);
    store.resetAdjust(2);
    expect(store.adjustFor(2)).toEqual({ brightness: 0, contrast: 0, sharpen: 0 });
    store.setAdjust(0, 'contrast', 5);
    store.resetAdjust(null);
    expect(store.hasAdjustments).toBe(false);
    expect(store.adjust.per).toEqual({});
  });
});

describe('studio store · adjustments per set', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedRebuild.mockClear();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
  });

  it('remembers the shared switch and the shared sliders for every set', async () => {
    vi.useFakeTimers();
    try {
      const store = useStudioStore();
      await store.upload([file('a.png')]);
      store.setAdjust(null, 'brightness', 20);
      store.addSet();
      expect(store.adjustGrouped).toBe(true);
      expect(store.sharedAdjust.brightness).toBe(20);
      store.setAdjustGroup(false);
      store.setAdjust(5, 'contrast', -15);
      vi.advanceTimersByTime(ADJUST_DEBOUNCE_MS);
      expect(store.adjustFor(5)).toEqual({ brightness: 20, contrast: -15, sharpen: 0 });
      store.selectSet(0);
      expect(store.adjustGrouped).toBe(true);
      store.setAdjust(null, 'sharpen', 1);
      vi.advanceTimersByTime(ADJUST_DEBOUNCE_MS);
      expect(store.adjustFor(0)).toEqual({ brightness: 20, contrast: 0, sharpen: 1 });
      expect(store.adjustFor(4)).toEqual({ brightness: 20, contrast: 0, sharpen: 0 });
      expect(store.adjustFor(5).contrast).toBe(-15);
      store.selectSet(1);
      expect(store.adjustGrouped).toBe(false);
      expect(store.hasAdjustments).toBe(true);
      store.resetAdjust(null);
      expect(store.hasAdjustments).toBe(false);
      expect(store.adjustFor(5)).toEqual({ brightness: 0, contrast: 0, sharpen: 0 });
      expect(store.sets[0].adjust.brightness).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds only the frames of the active set when its shared sliders move', async () => {
    vi.useFakeTimers();
    try {
      const store = useStudioStore();
      await store.upload([file('a.png')]);
      store.addSet();
      await vi.waitFor(() => expect(frameBuffers.indices()).toHaveLength(8));
      mockedRebuild.mockClear();
      store.setAdjust(null, 'brightness', 5);
      vi.advanceTimersByTime(ADJUST_DEBOUNCE_MS);
      expect(mockedRebuild.mock.calls.map((call) => call[0].index).sort()).toEqual([4, 5, 6, 7]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('studio store · anchor and render', () => {
  const points = [
    { x: 170, y: 154 },
    { x: 190, y: 147 },
    { x: 212, y: 155 },
    { x: 228, y: 144 }
  ];

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedMatch.mockReset();
    mockedRender.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
  });

  async function ready() {
    const store = useStudioStore();
    store.autoMatch = false;
    await store.upload([file('a.png')]);
    mockedMatch.mockResolvedValueOnce({
      ref: { index: 0, x: points[0].x, y: points[0].y, suggested: false },
      results: points.slice(1).map((point, k) => ({ index: k + 1, ...point, score: 0.9 }))
    });
    store.setPoint(0, points[0]);
    await store.propagateFrom(0);
    return store;
  }

  it('computes a layout, pans the crop anchor and recentres', async () => {
    const store = await ready();
    expect(store.layout).not.toBeNull();
    expect(store.canRender).toBe(true);
    const before = store.layout!.crop[0];
    store.panAnchor(15, 0);
    expect(store.anchor).not.toBeNull();
    expect(store.layout!.crop[0]).toBeGreaterThan(before);
    store.resetAnchor();
    expect(store.anchor).toBeNull();
    store.settings.preset = 'free';
    store.panAnchor(15, 0);
    expect(store.anchor).toBeNull();
  });

  it('sends the render request and keeps a deduplicated list of results', async () => {
    const response = (name: string): RenderResponse => ({
      video_url: `/v/${name}`,
      download_url: `/d/${name}`,
      poster_url: `/p/${name}`,
      video_name: name,
      width: 1080,
      height: 1350,
      frames: 60,
      fps: 10,
      duration: 6,
      size_bytes: 1000
    });
    mockedRender.mockResolvedValueOnce(response('out_0-1-2-3.mp4'));
    const store = await ready();
    store.setAdjust(null, 'brightness', 12);
    await store.render();
    const request = mockedRender.mock.calls[0][0];
    expect(request).toMatchObject({
      session_id: 's1',
      order: [0, 1, 2, 3],
      set_loops: [{ mode: 'pingpong', pattern: null, cycles: 1 }],
      fps: 10,
      duration: 6,
      max_width: null,
      preset: 'ig_portrait',
      anchor: null
    });
    expect(request).not.toHaveProperty('effects');
    expect(request.points).toEqual(points);
    expect(request.adjustments).toHaveLength(4);
    expect(request.adjustments![0].brightness).toBe(12);
    expect(store.renders).toHaveLength(1);
    expect(store.currentRender?.video_name).toBe('out_0-1-2-3.mp4');
    expect(store.renderStatus).toMatchObject({ key: 'studio.render.done', tone: 'ok' });

    mockedRender.mockResolvedValueOnce(response('out_0-1-2-3.mp4'));
    await store.render();
    expect(store.renders).toHaveLength(1);
    mockedRender.mockResolvedValueOnce(response('out_3-2-1-0.mp4'));
    await store.render();
    expect(store.renders.map((item) => item.video_name)).toEqual([
      'out_3-2-1-0.mp4',
      'out_0-1-2-3.mp4'
    ]);
  });

  it('sends max_width only for the free preset and a normalised anchor otherwise', async () => {
    mockedRender.mockResolvedValue({} as RenderResponse);
    const store = await ready();
    store.panAnchor(10, 5);
    await store.render();
    expect(mockedRender.mock.calls[0][0].anchor).not.toBeNull();
    store.settings.preset = 'free';
    store.settings.maxWidth = 720;
    await store.render();
    expect(mockedRender.mock.calls[1][0]).toMatchObject({ max_width: 720, anchor: null });
  });

  it('reports render errors and blocks rendering with an invalid custom pattern', async () => {
    mockedRender.mockRejectedValue(
      new ApiError('render', 400, { code: 'render.no_overlap', message: 'No overlap', params: {} })
    );
    const store = await ready();
    await store.render();
    expect(store.renderStatus).toMatchObject({
      key: 'errors.render.render.no_overlap',
      tone: 'err'
    });
    store.setLoop(0, 'custom');
    store.setPatternText(0, '1-9');
    expect(store.canRender).toBe(false);
    store.setPatternText(0, '1-4-1-2');
    expect(store.canRender).toBe(true);
    expect(store.sequence.slice(0, 4)).toEqual([0, 3, 0, 1]);
  });
});

describe('studio store · sets of four', () => {
  const twelve = Array.from({ length: 12 }, (_, k) => k);

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedMatch.mockReset();
    mockedRender.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
  });

  it('adds sets from the next free frames without a cap and removes them', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', twelve));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.addSet();
    expect(store.activeSet).toBe(1);
    expect(store.order).toEqual([4, 5, 6, 7]);
    expect(store.flatOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    store.addSet();
    store.addSet();
    expect(store.setCount).toBe(4);
    expect(store.sets[2].frames).toEqual([8, 9, 10, 11]);
    expect(store.sets[3].frames).toEqual([]);
    store.removeSet(3);
    await vi.waitFor(() => expect(mockedDetect).toHaveBeenCalledTimes(3));
    expect(mockedDetect.mock.calls[2][0].order).toEqual([8, 9, 10, 11]);
    store.removeSet(0);
    expect(store.setCount).toBe(2);
    expect(store.activeSet).toBe(1);
    expect(store.order).toEqual([8, 9, 10, 11]);
    store.removeSet(1);
    expect(store.activeSet).toBe(0);
    expect(store.order).toEqual([4, 5, 6, 7]);
    store.removeSet(0);
    expect(store.setCount).toBe(1);
    expect(store.order).toEqual([]);
  });

  it('splits the whole library into sets of four and detects every order', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [...twelve, 12, 13]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11]
    ]);
    expect(store.activeSet).toBe(0);
    await vi.waitFor(() => expect(mockedDetect).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(frameBuffers.indices()).toEqual(twelve));
  });

  it('keeps work canvases only for frames that belong to a set', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    expect(frameBuffers.indices()).toEqual([0, 1, 2, 3]);
    store.toggleSelect(3);
    store.toggleSelect(6);
    await vi.waitFor(() => expect(frameBuffers.indices().sort()).toEqual([0, 1, 2, 6]));
    store.addSet();
    expect(store.order).toEqual([3, 4, 5, 7]);
    await vi.waitFor(() => expect(frameBuffers.indices()).toHaveLength(8));
  });

  it('fills a new set with whatever frames are still free', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.addSet();
    expect(store.order).toEqual([4, 5]);
    expect(store.seriesComplete).toBe(false);
    expect(store.incompleteSet).toBe(1);
    expect(store.layout).toBeNull();
  });

  it('moves a frame to the active set when it is picked from another one', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.addSet();
    store.selectSet(0);
    store.toggleSelect(5);
    expect(store.order).toEqual([0, 1, 2, 5]);
    expect(store.sets[1].frames).toEqual([4, 6, 7]);
    expect(store.setOf(5)).toBe(0);
    store.selectSet(1);
    store.selectNext();
    expect(store.order).toEqual([4, 5, 6, 7]);
    expect(store.sets[0].frames).toEqual([0, 1, 2]);
  });

  it('keeps order detection state per set', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    await vi.waitFor(() => expect(store.orderStatus?.key).toBe('studio.order.confirmed'));
    mockedDetect.mockResolvedValue({ order: [5, 4, 7, 6], confidence: 0.8 });
    store.addSet();
    await vi.waitFor(() => expect(store.orderStatus?.key).toBe('studio.order.looksOrder'));
    expect(store.suggestedOrder).toEqual([5, 4, 7, 6]);
    store.selectSet(0);
    expect(store.orderStatus?.key).toBe('studio.order.confirmed');
    expect(store.suggestedOrder).toBeNull();
    store.selectSet(1);
    store.applySuggestedOrder();
    expect(store.order).toEqual([5, 4, 7, 6]);
    expect(store.sets[0].frames).toEqual([0, 1, 2, 3]);
    expect(store.flatOrder).toEqual([0, 1, 2, 3, 5, 4, 7, 6]);
  });

  it('propagates the first point into every set, keeps later fixes local and renders the series', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
    mockedMatch.mockResolvedValue({
      ref: { index: 0, x: 170, y: 154, suggested: false },
      results: [1, 2, 3, 4, 5, 6, 7].map((index) => ({
        index,
        x: 170 + 5 * index,
        y: 150,
        score: 0.9
      }))
    });
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.addSet();
    store.selectSet(0);
    store.setPoint(0, { x: 170, y: 154 });
    store.afterManualPoint(0);
    await vi.waitFor(() => expect(store.matching).toBe(false));
    expect(mockedMatch.mock.calls.map((call) => call[0].targets)).toEqual([
      [1, 2, 3],
      [4, 5, 6, 7]
    ]);
    expect(store.seriesPointsSet).toBe(true);
    expect(store.matchStatus?.params).toEqual({ n: 14, low: 0 });
    expect(store.layout?.alignment.offsets).toHaveLength(8);
    await vi.waitFor(() => expect(mockedDetect).toHaveBeenCalledTimes(4));

    mockedMatch.mockResolvedValue({ ref: { index: 5, x: 1, y: 1, suggested: false }, results: [] });
    store.selectSet(1);
    store.setPoint(5, { x: 1, y: 1 });
    expect(store.pointMeta[0]).toEqual({ source: 'manual' });
    await store.propagateFrom(5);
    expect(mockedMatch.mock.calls[2][0].targets).toEqual([4, 6, 7]);

    store.settings.setMode = 'pingpong';
    store.setCycles(0, 2);
    store.setCycles(1, 2);
    expect(Math.max(...store.sequence)).toBe(7);
    const sharedCrop = store.layout!.alignment.crop[2];
    store.settings.sharedFocus = false;
    expect(store.layout!.alignment.targets[0]).not.toEqual(store.layout!.alignment.targets[4]);
    expect(store.layout!.alignment.crop[2]).toBeGreaterThanOrEqual(sharedCrop);
    store.settings.sharedFocus = true;
    mockedRender.mockResolvedValue({ video_name: 'out_0-1-2-3-4-5-6-7.mp4' } as RenderResponse);
    await store.render();
    const request = mockedRender.mock.calls[0][0];
    expect(request).toMatchObject({
      order: [0, 1, 2, 3, 4, 5, 6, 7],
      set_mode: 'pingpong',
      set_loops: [
        { mode: 'pingpong', pattern: null, cycles: 2 },
        { mode: 'pingpong', pattern: null, cycles: 2 }
      ],
      shared_focus: true
    });

    expect(request.points).toHaveLength(8);
    expect(request.adjustments).toHaveLength(8);
  });
});

describe('studio store · sets kept out of the animation', () => {
  const twelve = Array.from({ length: 12 }, (_, k) => k);

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedMatch.mockReset();
    mockedRender.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', twelve));
  });

  async function threeSets() {
    const store = useStudioStore();
    store.autoMatch = false;
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    return store;
  }

  it('drops a hidden set from the animation but keeps its frames assigned', async () => {
    const store = await threeSets();
    expect(store.setCount).toBe(3);
    store.toggleSetHidden(1);
    expect(store.sets[1].hidden).toBe(true);
    expect(store.shownSetCount).toBe(2);
    expect(store.setCount).toBe(3);
    expect(store.flatOrder).toEqual([0, 1, 2, 3, 8, 9, 10, 11]);
    expect(store.assignedFrames).toEqual(twelve);
    store.addSet();
    expect(store.sets[3].frames).toEqual([]);
    store.toggleSetHidden(1);
    expect(store.flatOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('keeps one set in the animation', async () => {
    const store = await threeSets();
    store.toggleSetHidden(0);
    store.toggleSetHidden(1);
    expect(store.shownSetCount).toBe(1);
    expect(store.canHideSet(2)).toBe(false);
    store.toggleSetHidden(2);
    expect(store.sets[2].hidden).toBe(false);
    expect(store.shownSetCount).toBe(1);
  });

  it('shows a set again when the last shown one is removed', async () => {
    const store = await threeSets();
    store.toggleSetHidden(1);
    store.toggleSetHidden(2);
    store.removeSet(0);
    expect(store.sets.every((set) => set.hidden)).toBe(false);
    expect(store.shownSetCount).toBe(1);
  });

  it('ignores hidden sets when checking that the animation is ready', async () => {
    const store = await threeSets();
    store.addSet();
    expect(store.seriesComplete).toBe(false);
    expect(store.incompleteSet).toBe(3);
    store.toggleSetHidden(3);
    expect(store.seriesComplete).toBe(true);
    expect(store.incompleteSet).toBe(-1);
  });

  it('renders only the shown sets', async () => {
    const store = await threeSets();
    store.settings.composition = 'mosaic';
    store.toggleSetHidden(1);
    store.toggleSetHidden(2);
    mockedRender.mockResolvedValue({
      video_url: '/v.mp4',
      download_url: '/d.mp4',
      poster_url: '/p.jpg',
      video_name: 'out.mp4',
      width: 1080,
      height: 1350,
      frames: 40,
      fps: 10,
      duration: 4,
      size_bytes: 1000
    });
    expect(store.layout).not.toBeNull();
    expect(store.canRender).toBe(true);
    await store.render();
    const payload = mockedRender.mock.calls[0][0];
    expect(payload.order).toEqual([0, 1, 2, 3]);
    expect(payload.points).toHaveLength(4);
    expect(payload.composition).toBe('single');
  });
});

describe('studio store · one video per set', () => {
  const twelve = Array.from({ length: 12 }, (_, k) => k);
  const mockedStart = vi.mocked(startBatch);
  const mockedFetchBatch = vi.mocked(fetchBatch);
  const mockedCancel = vi.mocked(cancelBatch);

  function rendered(name: string): RenderResponse {
    return {
      video_url: `/v/${name}`,
      download_url: `/d/${name}`,
      poster_url: `/p/${name}`,
      video_name: name,
      width: 1080,
      height: 1350,
      frames: 20,
      fps: 10,
      duration: 2,
      size_bytes: 1000
    };
  }

  function batchState(status: BatchState['status'], done: number): BatchState {
    const names = ['out_0-1-2-3.mp4', 'out_8-9-10-11.mp4'];
    return {
      batch_id: 'b1',
      status,
      total: 2,
      done,
      items: [1, 3].map((set, k) =>
        k < done ? { set, status: 'done', render: rendered(names[k]) } : { set, status: 'pending' }
      ),
      zip_url: status === 'running' ? null : '/zip'
    };
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    localStorage.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedStart.mockReset();
    mockedFetchBatch.mockReset();
    mockedCancel.mockReset();
    mockedRender.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', twelve));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function threeSets() {
    const store = useStudioStore();
    store.autoMatch = false;
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    return store;
  }

  it('previews only the active set as a single animation', async () => {
    const store = await threeSets();
    store.settings.composition = 'mosaic';
    store.setOutputMode('separate');
    store.selectSet(1);
    expect(store.animatedSetCount).toBe(1);
    expect(store.flatOrder).toEqual([4, 5, 6, 7]);
    expect(store.layout).not.toBeNull();
    store.setOutputMode('combined');
    expect(store.flatOrder).toEqual(twelve);
  });

  it('keeps a crop anchor per set while the combined anchor stays apart', async () => {
    const store = await threeSets();
    store.settings.preset = 'ig_square';
    store.setAnchor({ x: 0.3, y: 0.4 });
    store.setOutputMode('separate');
    expect(store.anchor).toBeNull();
    store.setAnchor({ x: 0.6, y: 0.5 });
    store.selectSet(2);
    expect(store.anchor).toBeNull();
    store.selectSet(0);
    expect(store.anchor).toEqual({ x: 0.6, y: 0.5 });
    store.setOutputMode('combined');
    expect(store.anchor).toEqual({ x: 0.3, y: 0.4 });
  });

  it('renders one job per shown set and follows the batch to the end', async () => {
    vi.useFakeTimers();
    const store = await threeSets();
    store.setOutputMode('separate');
    store.toggleSetHidden(1);
    mockedStart.mockResolvedValue(batchState('running', 0));
    mockedFetchBatch
      .mockResolvedValueOnce(batchState('running', 1))
      .mockResolvedValueOnce(batchState('done', 2));
    expect(store.canRender).toBe(true);

    const running = store.render();
    await vi.advanceTimersByTimeAsync(0);
    const request = mockedStart.mock.calls[0][0];
    expect(request.session_id).toBe('s1');
    expect(request.set_numbers).toEqual([1, 3]);
    expect(request.items.map((item) => item.order)).toEqual([
      [0, 1, 2, 3],
      [8, 9, 10, 11]
    ]);
    expect(request.items.every((item) => item.composition === 'single')).toBe(true);
    expect(store.batchRunning).toBe(true);
    expect(store.canRender).toBe(false);

    await vi.advanceTimersByTimeAsync(BATCH_POLL_MS);
    expect(store.renderStatus).toMatchObject({
      key: 'studio.batch.progress',
      params: { done: 1, total: 2 }
    });
    await vi.advanceTimersByTimeAsync(BATCH_POLL_MS);
    await running;
    expect(mockedFetchBatch).toHaveBeenCalledWith('s1', 'b1');
    expect(store.batch?.zip_url).toBe('/zip');
    expect(store.currentRender?.video_name).toBe('out_0-1-2-3.mp4');
    expect(store.renderStatus).toMatchObject({ key: 'studio.batch.done', tone: 'ok' });
    expect(store.rendering).toBe(false);
    expect(mockedRender).not.toHaveBeenCalled();
  });

  it('waits until every shown set has four frames', async () => {
    const store = await threeSets();
    store.setOutputMode('separate');
    store.addSet();
    store.selectSet(0);
    expect(store.layout).not.toBeNull();
    expect(store.batchReady).toBe(false);
    expect(store.canRender).toBe(false);
    store.toggleSetHidden(3);
    expect(store.canRender).toBe(true);
  });

  it('asks the server to stop a running batch', async () => {
    vi.useFakeTimers();
    const store = await threeSets();
    store.setOutputMode('separate');
    mockedStart.mockResolvedValue(batchState('running', 0));
    mockedFetchBatch.mockResolvedValue({ ...batchState('cancelled', 1), zip_url: '/zip' });
    mockedCancel.mockResolvedValue(batchState('running', 0));
    const running = store.render();
    await vi.advanceTimersByTimeAsync(0);
    await store.stopBatch();
    expect(mockedCancel).toHaveBeenCalledWith('s1', 'b1');
    await vi.advanceTimersByTimeAsync(BATCH_POLL_MS);
    await running;
    expect(store.renderStatus).toMatchObject({ key: 'studio.batch.cancelled', params: { n: 1 } });
  });

  it('keeps the mode, set anchors and the batch across a reload', async () => {
    vi.useFakeTimers();
    const store = await threeSets();
    store.settings.preset = 'ig_square';
    store.setOutputMode('separate');
    store.setAnchor({ x: 0.6, y: 0.5 });
    store.batch = batchState('done', 2);
    await vi.waitFor(() => expect(loadLocalSnapshot()?.batch?.status).toBe('done'));

    setActivePinia(createPinia());
    frameBuffers.clear();
    const again = useStudioStore();
    await again.restoreLocal();
    expect(again.settings.output).toBe('separate');
    expect(again.sets[0].anchor).toEqual({ x: 0.6, y: 0.5 });
    expect(again.batch?.items).toHaveLength(2);
    expect(again.askOutput).toBe(false);
    expect(mockedFetchBatch).not.toHaveBeenCalled();
  });

  it('resumes following a batch that was running before the reload', async () => {
    vi.useFakeTimers();
    const store = await threeSets();
    store.setOutputMode('separate');
    store.batch = batchState('running', 1);
    await vi.waitFor(() => expect(loadLocalSnapshot()?.batch?.status).toBe('running'));

    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedFetchBatch.mockResolvedValue(batchState('done', 2));
    const again = useStudioStore();
    await again.restoreLocal();
    await vi.waitFor(() => expect(again.batch?.status).toBe('done'));
    expect(again.rendering).toBe(false);
    expect(again.renderStatus?.key).toBe('studio.batch.done');
  });
});

describe('studio store · loops and repeats per set', () => {
  const twelve = Array.from({ length: 12 }, (_, k) => k);

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    localStorage.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedRender.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', twelve));
  });

  async function threeSets() {
    const store = useStudioStore();
    store.autoMatch = false;
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    return store;
  }

  it('plays every set with its own loop and repeats and splits one pass into clips', async () => {
    const store = await threeSets();
    store.setLoop(0, 'ends');
    store.setCycles(0, 2);
    store.setLoop(1, 'forward');
    store.setLoop(2, 'middle');
    expect(store.pass.map((item) => item.a)).toEqual([0, 3, 0, 3, 4, 5, 6, 7, 9, 10]);
    expect(store.clipVisits.map((visits) => visits.map((visit) => visit.cells))).toEqual([
      [[0, 1, 2, 3]],
      [[4, 5, 6, 7]],
      [[8, 9]]
    ]);
    store.settings.composition = 'mosaic';
    expect(store.clipVisits.map((visits) => visits[0].cells)).toEqual([
      [0, 1],
      [0, 1],
      [0, 1]
    ]);
  });

  it('sends one loop per set with the render and keeps them per job in a batch', async () => {
    const store = await threeSets();
    store.setLoop(1, 'custom');
    store.setPatternText(1, '1-4');
    store.setCycles(2, 3);
    mockedRender.mockResolvedValue({ video_name: 'out.mp4' } as RenderResponse);
    await store.render();
    expect(mockedRender.mock.calls[0][0].set_loops).toEqual([
      { mode: 'pingpong', pattern: null, cycles: 1 },
      { mode: 'custom', pattern: [0, 3], cycles: 1 },
      { mode: 'pingpong', pattern: null, cycles: 3 }
    ]);
  });

  it('fills repeats from a preset and copies the active loop to every set', async () => {
    const store = await threeSets();
    store.applyDwellPreset('edges');
    expect(store.sets.map((set) => set.cycles)).toEqual([3, 1, 3]);
    store.applyDwellPreset('swing');
    expect(store.sets.map((set) => set.cycles)).toEqual([3, 2, 1]);
    expect(store.settings.setMode).toBe('pingpong');
    store.selectSet(1);
    store.setLoop(1, 'ends');
    store.applyLoopToAll();
    expect(store.sets.map((set) => [set.loop, set.cycles])).toEqual([
      ['ends', 2],
      ['ends', 2],
      ['ends', 2]
    ]);
  });

  it('renders only the active set with its own loop', async () => {
    const store = await threeSets();
    store.selectSet(2);
    store.setLoop(2, 'ends');
    mockedRender.mockResolvedValue({ video_name: 'out_8-9-10-11.mp4' } as RenderResponse);
    expect(store.canRenderActive).toBe(true);
    await store.renderActiveSet();
    const request = mockedRender.mock.calls[0][0];
    expect(request.order).toEqual([8, 9, 10, 11]);
    expect(request.set_loops).toEqual([{ mode: 'ends', pattern: null, cycles: 1 }]);
    expect(request.composition).toBe('single');
    expect(store.currentRender?.video_name).toBe('out_8-9-10-11.mp4');
    store.addSet();
    expect(store.canRenderActive).toBe(false);
  });

  it('reorders frames of any set from its clip', async () => {
    const store = await threeSets();
    store.moveFrameInSet(2, 0, 3);
    expect(store.sets[2].frames).toEqual([9, 10, 11, 8]);
    expect(store.activeSet).toBe(0);
  });

  it('turns an old snapshot with a shared loop and eased set order into loops per set', async () => {
    const store = await threeSets();
    const legacy = JSON.parse(JSON.stringify(store.snapshot)) as Record<string, unknown>;
    const settings = legacy.settings as Record<string, unknown>;
    Object.assign(settings, {
      mode: 'ends',
      patternText: '',
      setMode: 'swing',
      cyclesPerSet: 3,
      effects: [{ id: 'z', kind: 'zoom', start: 0, end: 1, amount: 0.1, fade: 0 }]
    });
    (legacy.sets as Record<string, unknown>[]).forEach((set) => {
      delete set.loop;
      delete set.cycles;
    });

    setActivePinia(createPinia());
    const again = useStudioStore();
    again.applySnapshot(legacy as unknown as typeof store.snapshot);
    expect(again.sets.map((set) => [set.loop, set.cycles])).toEqual([
      ['ends', 3],
      ['ends', 2],
      ['ends', 1]
    ]);
    expect(again.settings.setMode).toBe('pingpong');
    expect(again.settings).not.toHaveProperty('effects');
    expect(again.settings).not.toHaveProperty('mode');
  });
});

describe('studio store · sets of another size', () => {
  const nine = Array.from({ length: 9 }, (_, k) => k);

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    localStorage.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedRender.mockReset();
    mockedDetect.mockImplementation(async (req) => ({ order: req.order, confidence: 0.9 }));
    mockedUpload.mockResolvedValue(uploadResponse('s1', nine));
  });

  it('builds sets of three, renders them with their size and remembers the choice', async () => {
    const store = useStudioStore();
    store.chooseSetSize(3);
    expect(localStorage.getItem('lenti.studio.setSize')).toBe('3');
    store.autoMatch = false;
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8]
    ]);
    expect(store.pass.slice(0, 4).map((item) => item.a)).toEqual([0, 1, 2, 1]);
    store.chooseSetSize(5);
    expect(store.setSize).toBe(3);

    mockedRender.mockResolvedValue({ video_name: 'out.mp4' } as RenderResponse);
    await store.render();
    const request = mockedRender.mock.calls[0][0];
    expect(request.frames_per_set).toBe(3);
    expect(request.order).toEqual(nine);
    expect(request.set_loops).toHaveLength(3);

    setActivePinia(createPinia());
    localStorage.removeItem('lenti.studio.setSize');
    const again = useStudioStore();
    expect(again.setSize).toBe(4);
    again.applySnapshot(JSON.parse(JSON.stringify(store.snapshot)));
    expect(again.setSize).toBe(3);
  });
});

describe('studio store · order direction and set order', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
  });

  it('reports the direction of the active set and sorts it on demand', async () => {
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    expect(store.orderDirection).toBe('forward');
    store.reverseOrder();
    expect(store.orderDirection).toBe('backward');
    store.swapFrames(0, 1);
    expect(store.orderDirection).toBeNull();
    store.anchor = { x: 0.2, y: 0.2 };
    store.setOrderDirection('forward');
    expect(store.order).toEqual([0, 1, 2, 3]);
    expect(store.anchor).toBeNull();
    store.setOrderDirection('backward');
    expect(store.order).toEqual([3, 2, 1, 0]);
    expect(orderDirectionOf([2, 0, 3, 1])).toBeNull();
    expect(orderDirectionOf([5])).toBeNull();
  });

  it('moves a set to another position and keeps the active one selected', async () => {
    mockedUpload.mockResolvedValue(
      uploadResponse(
        's1',
        Array.from({ length: 12 }, (_, k) => k)
      )
    );
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    store.selectSet(1);
    store.moveSet(0, 2);
    expect(store.sets.map((set) => set.frames[0])).toEqual([4, 8, 0]);
    expect(store.activeSet).toBe(0);
    expect(store.flatOrder).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2, 3]);
    store.moveSet(2, 0);
    expect(store.sets.map((set) => set.frames[0])).toEqual([0, 4, 8]);
    expect(store.activeSet).toBe(1);
    store.moveSet(1, 5);
    expect(store.activeSet).toBe(1);
  });
});

describe('studio store · persistence', () => {
  const mockedAvailable = vi.mocked(frameAvailable);

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedMatch.mockReset();
    mockedAvailable.mockReset();
    mockedAvailable.mockResolvedValue(true);
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('saves a snapshot locally and restores it into a fresh store', async () => {
    const store = useStudioStore();
    store.autoMatch = false;
    await store.upload([file('a.png')]);
    store.setPoint(1, { x: 10, y: 20 });
    store.settings.fps = 14;
    store.addSet();
    store.setAdjust(null, 'brightness', 7);
    await flush();
    vi.advanceTimersByTime(LOCAL_SAVE_DEBOUNCE_MS);
    const saved = loadLocalSnapshot();
    expect(saved?.sessionId).toBe('s1');
    expect(saved?.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7]
    ]);

    setActivePinia(createPinia());
    frameBuffers.clear();
    const again = useStudioStore();
    expect(again.frameCount).toBe(0);
    await again.restoreLocal();
    expect(again.sessionId).toBe('s1');
    expect(again.frameCount).toBe(8);
    expect(again.points[1]).toEqual({ x: 10, y: 20 });
    expect(again.pointMeta[1]).toEqual({ source: 'manual' });
    expect(again.settings.fps).toBe(14);
    expect(again.activeSet).toBe(1);
    expect(again.sharedAdjust.brightness).toBe(7);
    expect(again.uploadStatus).toMatchObject({ key: 'studio.upload.restored', params: { n: 8 } });
    expect(frameBuffers.indices()).toHaveLength(8);
  });

  it('keeps a set out of the animation across a reload', async () => {
    const store = useStudioStore();
    store.autoMatch = false;
    await store.upload([file('a.png')]);
    store.addSet();
    store.toggleSetHidden(1);
    await flush();
    vi.advanceTimersByTime(LOCAL_SAVE_DEBOUNCE_MS);
    expect(loadLocalSnapshot()?.sets.map((set) => set.hidden)).toEqual([false, true]);

    setActivePinia(createPinia());
    frameBuffers.clear();
    const again = useStudioStore();
    await again.restoreLocal();
    expect(again.sets.map((set) => set.hidden)).toEqual([false, true]);
    expect(again.shownSetCount).toBe(1);
    expect(again.flatOrder).toEqual([0, 1, 2, 3]);
    expect(again.assignedFrames).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('drops a restored session whose frames are gone from the server', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    await flush();
    vi.advanceTimersByTime(LOCAL_SAVE_DEBOUNCE_MS);
    mockedAvailable.mockResolvedValue(false);
    setActivePinia(createPinia());
    const again = useStudioStore();
    await again.restoreLocal();
    expect(again.frameCount).toBe(0);
    expect(again.sessionId).toBeNull();
    expect(again.uploadStatus?.key).toBe('studio.upload.expired');
    expect(loadLocalSnapshot()).toBeNull();
  });

  it('resetAll clears the studio, the settings and the local snapshot', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.settings.preset = 'free';
    store.setPoint(0, { x: 1, y: 1 });
    await flush();
    vi.advanceTimersByTime(LOCAL_SAVE_DEBOUNCE_MS);
    expect(loadLocalSnapshot()).not.toBeNull();
    store.resetAll();
    expect(store.frameCount).toBe(0);
    expect(store.sets).toHaveLength(1);
    expect(store.settings.preset).toBe('ig_portrait');
    expect(store.pointsCount).toBe(0);
    expect(store.sessionId).toBeNull();
    expect(loadLocalSnapshot()).toBeNull();
    await flush();
    vi.advanceTimersByTime(LOCAL_SAVE_DEBOUNCE_MS);
    expect(loadLocalSnapshot()).toBeNull();
  });
});

describe('studio store · one strip', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3, 4, 5, 6, 7]));
  });

  it('runs the loop through every set and ignores a broken custom pattern', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.addSet();
    store.settings.setMode = 'sweep';
    expect(store.sequence.slice(0, 14)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1]);
    store.setLoop(0, 'custom');
    store.setPatternText(0, '1-9');
    expect(store.patternValid).toBe(true);
    store.settings.setMode = 'forward';
    expect(store.patternValid).toBe(false);
  });
});

describe('studio store · repeats', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
  });

  it('plays the whole composition an exact number of times when repeats are set', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    expect(store.sequence).toHaveLength(60);
    store.settings.loops = 2;
    expect(store.sequence).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1]);
    store.settings.loops = null;
    expect(store.sequence).toHaveLength(60);
  });
});

describe('studio store · palette shuffle', () => {
  const mockedPalette = vi.mocked(fetchPalette);

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedPalette.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(
      uploadResponse(
        's1',
        Array.from({ length: 16 }, (_, k) => k)
      )
    );
  });

  it('reorders sets by palette and keeps the active set selected', async () => {
    const tone = (index: number) =>
      Math.floor(index / 4) % 2 === 0 ? [80, 150, 160] : [60, 110, 90];
    mockedPalette.mockImplementation(async (_sid, indices) => ({
      features: indices.map((index) => ({ index, signature: tone(index), structure: [] }))
    }));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    store.selectSet(1);
    await store.shuffleSets('similar');
    expect(mockedPalette).toHaveBeenCalledWith(
      's1',
      Array.from({ length: 16 }, (_, k) => k)
    );
    const firstFrames = store.sets.map((set) => set.frames[0]);
    const warmPositions = firstFrames
      .map((f, k) => (f === 0 || f === 8 ? k : -1))
      .filter((k) => k >= 0);
    expect(Math.abs(warmPositions[0] - warmPositions[1])).toBe(1);
    expect(store.order).toEqual([4, 5, 6, 7]);
    expect(store.shuffleStatus?.key).toBe('studio.sets.shuffled.similar');
    await store.shuffleSets('contrast');
    const after = store.sets.map((set) => Math.floor(set.frames[0] / 4) % 2);
    for (let k = 1; k < after.length; k++) expect(after[k]).not.toBe(after[k - 1]);
  });
});

describe('studio store · grouping by similarity', () => {
  const mockedPalette = vi.mocked(fetchPalette);

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedPalette.mockReset();
    mockedDetect.mockImplementation(async (req) => ({ order: req.order, confidence: 0.9 }));
    mockedUpload.mockResolvedValue(
      uploadResponse(
        's1',
        Array.from({ length: 9 }, (_, k) => k)
      )
    );
  });

  it('builds sets of four from frames that look alike and leaves the rest free', async () => {
    const scene = (index: number) => (index % 2 === 0 ? [1, 0] : [0, 1]);
    mockedPalette.mockImplementation(async (_sid, indices) => ({
      features: indices.map((index) => ({ index, signature: [], structure: scene(index) }))
    }));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    expect(mockedPalette).toHaveBeenCalledTimes(1);
    expect(mockedPalette).toHaveBeenCalledWith(
      's1',
      Array.from({ length: 9 }, (_, k) => k)
    );
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 2, 4, 6],
      [1, 3, 5, 7]
    ]);
    expect(store.setOf(8)).toBe(-1);
    expect(store.activeSet).toBe(0);
    expect(store.prepare).toBeNull();
    expect(store.sets.map((set) => set.orderStatus?.key)).toEqual([
      'studio.order.confirmed',
      'studio.order.confirmed'
    ]);
    expect(store.shuffleStatus?.key).toBe('studio.sets.grouped');
    expect(store.shuffleStatus?.params).toEqual({ n: 2 });
    expect(store.askOutput).toBe(true);
    store.chooseOutput('separate');
    expect(store.askOutput).toBe(false);
    expect(store.settings.output).toBe('separate');
  });
});

describe('studio store · start a set here', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockImplementation(async (req) => ({ order: req.order, confidence: 0.9 }));
    mockedUpload.mockResolvedValue(
      uploadResponse(
        's1',
        Array.from({ length: 9 }, (_, k) => k)
      )
    );
  });

  it('keeps earlier sets, rebuilds quads from the chosen frame and frees the gap', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7]
    ]);
    store.startSetAt(5);
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2, 3],
      [5, 6, 7, 8]
    ]);
    expect(store.setOf(4)).toBe(-1);
    expect(store.activeSet).toBe(1);
    store.startSetAt(0);
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7]
    ]);
    expect(store.activeSet).toBe(0);
  });
});

describe('studio store · direction for every set', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockImplementation(async (req) => ({ order: req.order, confidence: 0.9 }));
    mockedUpload.mockResolvedValue(
      uploadResponse(
        's1',
        Array.from({ length: 12 }, (_, k) => k)
      )
    );
  });

  it('sorts every set forward, backward, alternating or at random', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.splitLibraryIntoSets();
    store.setAllDirections('backward');
    expect(store.sets.map((set) => set.frames)).toEqual([
      [3, 2, 1, 0],
      [7, 6, 5, 4],
      [11, 10, 9, 8]
    ]);
    store.setAllDirections('alternate');
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2, 3],
      [7, 6, 5, 4],
      [8, 9, 10, 11]
    ]);
    const rolls = [0.9, 0.1, 0.9];
    store.setAllDirections('random', () => rolls.shift() ?? 0);
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2, 3],
      [7, 6, 5, 4],
      [8, 9, 10, 11]
    ]);
    store.setAllDirections('forward');
    expect(store.flatOrder).toEqual(Array.from({ length: 12 }, (_, k) => k));
  });
});

describe('studio store · exposure balance', () => {
  const mockedPalette = vi.mocked(fetchPalette);

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedPalette.mockReset();
    mockedDetect.mockImplementation(async (req) => ({ order: req.order, confidence: 0.9 }));
    mockedUpload.mockResolvedValue(
      uploadResponse(
        's1',
        Array.from({ length: 8 }, (_, k) => k)
      )
    );
  });

  it('lifts a darker frame on upload and suggests nothing for even sets', async () => {
    mockedPalette.mockImplementation(async (_sid, indices) => ({
      features: indices.map((index) => ({
        index,
        signature: [],
        structure: [index < 4 ? 1 : 0],
        tone: [index === 2 ? 90 : 120, 50] as [number, number]
      }))
    }));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    expect(store.sets[0].grouped).toBe(false);
    expect(store.adjustFor(2).brightness).toBeGreaterThan(15);
    expect(store.adjustFor(0).brightness).toBe(0);
    expect(store.sets[1].grouped).toBe(true);
    store.selectSet(1);
    expect(store.balanceSuggestion).toBeNull();
    store.selectSet(0);
    store.setAdjustGroup(true);
    expect(store.balanceSuggestion).toEqual({ positions: [2] });
    await store.applyBalance();
    expect(store.sets[0].grouped).toBe(false);
    expect(store.balanceSuggestion).toBeNull();
  });

  it('toggles auto balance off and keeps sharpen shared across the set', async () => {
    mockedPalette.mockImplementation(async (_sid, indices) => ({
      features: indices.map((index) => ({
        index,
        signature: [],
        structure: [index < 4 ? 1 : 0],
        tone: [index === 2 ? 90 : 120, 50] as [number, number]
      }))
    }));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    expect(store.adjustBalanced).toBe(true);
    store.setAdjust(null, 'sharpen', 2);
    expect(store.sets[0].frames.map((index) => store.adjustFor(index).sharpen)).toEqual([
      2, 2, 2, 2
    ]);
    await store.toggleBalance();
    expect(store.adjustBalanced).toBe(false);
    expect(store.adjustGrouped).toBe(true);
    expect(store.adjustFor(2).brightness).toBe(0);
    expect(store.adjustFor(2).sharpen).toBe(2);
    await store.toggleBalance();
    expect(store.adjustBalanced).toBe(true);
    expect(store.adjustFor(2).brightness).toBeGreaterThan(15);
  });

  it('keeps the balance when the shared contrast is changed on top of it', async () => {
    mockedPalette.mockImplementation(async (_sid, indices) => ({
      features: indices.map((index) => ({
        index,
        signature: [],
        structure: [index < 4 ? 1 : 0],
        tone: [index === 2 ? 90 : 120, 50] as [number, number]
      }))
    }));
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    const balanced = store.adjustFor(2).brightness;
    store.setAdjust(null, 'contrast', 25);
    expect(store.adjustBalanced).toBe(true);
    expect(store.sharedAdjust.contrast).toBe(25);
    expect(store.adjustFor(2).brightness).toBe(balanced);
    await store.toggleBalance();
    expect(store.sharedAdjust.contrast).toBe(25);
    expect(store.adjustFor(2).contrast).toBe(25);
  });
});

describe('studio store · centre points by default', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
  });

  it('puts a centre point on every frame after upload and lets a manual point replace it', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    expect(store.pointsCount).toBe(4);
    expect(store.pointMeta[1]).toEqual({ source: 'center' });
    expect(store.points[1]).toEqual({
      x: store.frames[1].width / 2,
      y: store.frames[1].height / 2
    });
    expect(store.layout).not.toBeNull();
    expect(store.isPlacedByUserOrSearch(1)).toBe(false);
    await vi.waitFor(() => expect(mockedDetect).toHaveBeenCalledTimes(1));
    expect(mockedDetect.mock.calls[0][0].points).toBeNull();
    store.setPoint(0, { x: 10, y: 10 });
    expect(store.pointMeta[0]).toEqual({ source: 'manual' });
    expect(store.isPlacedByUserOrSearch(0)).toBe(true);
  });
});

describe('studio store · custom crop frame', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    mockedUpload.mockReset();
    mockedDetect.mockReset();
    mockedRender.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1, 2, 3]));
  });

  it('turns a preset frame into a custom one, keeps it inside the area and sends it to render', async () => {
    const store = useStudioStore();
    await store.upload([file('a.png')]);
    store.settings.preset = 'ig_square';
    const before = store.layout!.crop;
    store.startCustomCrop();
    expect(store.settings.preset).toBe('custom');
    expect(store.layout!.crop).toEqual(before);
    store.setCustomCrop({ x: 0.9, y: 0.2, w: 0.5, h: 0.3 });
    expect(store.customCrop).toEqual({ x: 0.5, y: 0.2, w: 0.5, h: 0.3 });
    const [, , bw] = store.layout!.alignment.crop;
    expect(store.layout!.crop[2]).toBeLessThanOrEqual(bw);
    store.settings.maxWidth = 100;
    expect(store.layout!.out[0]).toBeLessThanOrEqual(100);
    mockedRender.mockResolvedValue({
      video_name: 'out.mp4',
      video_url: '',
      download_url: '',
      poster_url: '',
      width: 100,
      height: 60,
      fps: 10,
      frames: 6,
      duration: 0.6,
      size_bytes: 1
    });
    await store.render();
    expect(mockedRender.mock.calls[0][0]).toMatchObject({
      preset: 'custom',
      crop: { x: 0.5, y: 0.2, w: 0.5, h: 0.3 },
      anchor: null,
      max_width: 100
    });
  });
});

describe('studio store · scans with several frames', () => {
  function scansResponse(sessionId: string, indices: number[]): ScansResponse {
    return {
      session_id: sessionId,
      scans: indices.map((index) => ({
        index,
        name: `scan${index}.tif`,
        width: 8000,
        height: 2400,
        url: `/api/render/scans/${sessionId}/${index}`,
        thumb_url: `/api/render/scans/${sessionId}/${index}/thumb`
      })),
      total: indices.length
    };
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    localStorage.clear();
    mockedUpload.mockReset();
    mockedUploadScans.mockReset();
    mockedSplit.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockImplementation(async (request) => ({
      order: request.order,
      confidence: 0.9,
      direction_confident: true
    }));
    mockedPalette.mockReset();
    mockedPalette.mockImplementation(async (_sid, indices) => ({
      features: indices.map((index) => ({
        index,
        signature: [],
        structure: [],
        tone: [120, 40] as [number, number]
      }))
    }));
  });

  it('remembers the scan mode and opens the cut screen instead of the studio', async () => {
    mockedUploadScans.mockResolvedValue(scansResponse('s9', [0, 1, 2]));
    const store = useStudioStore();
    expect(store.scanMode).toBe(1);
    store.setScanMode(4);
    expect(localStorage.getItem('lenti.studio.scanMode')).toBe('4');
    expect(store.split).toMatchObject({ count: 4, axis: 'x' });

    await store.upload([file('a.tif', ''), file('b.tif', ''), file('c.tif', '')]);
    expect(mockedUploadScans).toHaveBeenCalledTimes(1);
    expect(mockedUpload).not.toHaveBeenCalled();
    expect(store.sessionId).toBe('s9');
    expect(store.scans).toHaveLength(3);
    expect(store.frameCount).toBe(0);
    expect(store.cutting).toBe(true);
    expect(store.uploadStatus?.key).toBe('studio.upload.scansDone');
    expect(store.prepare).toBeNull();
  });

  it('switches the split to three frames and remembers it', () => {
    const store = useStudioStore();
    store.setScanMode(3);
    expect(localStorage.getItem('lenti.studio.scanMode')).toBe('3');
    expect(store.split).toMatchObject({ count: 3, axis: 'x' });
  });

  it('cuts every scan with one geometry and builds a set per scan', async () => {
    mockedUploadScans.mockResolvedValue(scansResponse('s9', [0, 1]));
    mockedSplit.mockResolvedValue(uploadResponse('s9', [0, 1, 2, 3, 4, 5, 6, 7]));
    const store = useStudioStore();
    store.setScanMode(4);
    await store.upload([file('a.tif', ''), file('b.tif', '')]);
    store.setSplit({ count: 4, axis: 'x', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, gap: 0.01 });

    await store.cutScans();
    expect(mockedSplit).toHaveBeenCalledWith({
      session_id: 's9',
      count: 4,
      axis: 'x',
      box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      gap: 0.01
    });
    expect(store.cutting).toBe(false);
    expect(store.frameCount).toBe(8);
    expect(store.sets.map((set) => set.frames)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7]
    ]);
    expect(store.sets.every((set) => set.orderStatus?.key === 'studio.order.confirmed')).toBe(true);
    expect(Object.keys(store.points)).toHaveLength(8);
    expect(store.cutStatus?.key).toBe('studio.cut.done');
    expect(store.scans).toHaveLength(2);
    expect(store.askOutput).toBe(true);
  });

  it('keeps an own frame for each scan and sends them all to the cut', async () => {
    mockedUploadScans.mockResolvedValue(scansResponse('s9', [0, 1]));
    mockedSplit.mockResolvedValue(uploadResponse('s9', [0, 1, 2, 3, 4, 5, 6, 7]));
    const store = useStudioStore();
    store.setScanMode(4);
    await store.upload([file('a.tif', ''), file('b.tif', '')]);
    const shared = {
      count: 4 as const,
      axis: 'x' as const,
      box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      gap: 0.01
    };
    store.setSplit(shared);
    store.setSplitScope('each');
    store.selectScan(1);
    store.setSplit({ ...shared, axis: 'y', box: { x: 0.2, y: 0, w: 0.5, h: 1 } });
    expect(store.splitFor(0)?.axis).toBe('x');
    expect(store.splitFor(1)?.box.x).toBeCloseTo(0.2);

    await store.cutScans();
    expect(mockedSplit.mock.calls[0][0].scans).toEqual([
      { axis: 'x', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, gap: 0.01 },
      { axis: 'y', box: { x: 0.2, y: 0, w: 0.5, h: 1 }, gap: 0.01 }
    ]);

    store.selectScan(1);
    store.applySplitToAll();
    expect(store.splitFor(0)?.axis).toBe('y');
    store.setSplitScope('shared');
    expect(store.split?.axis).toBe('y');
  });

  it('reports cut errors, keeps the cut screen open and can be reopened later', async () => {
    mockedUploadScans.mockResolvedValue(scansResponse('s9', [0]));
    mockedSplit.mockRejectedValueOnce(
      new ApiError('render', 400, {
        code: 'render.split_too_small',
        message: 'too small',
        params: {}
      })
    );
    const store = useStudioStore();
    store.setScanMode(2);
    await store.upload([file('a.tif', '')]);
    await store.cutScans();
    expect(store.cutting).toBe(true);
    expect(store.cutStatus?.key).toBe('errors.render.render.split_too_small');

    mockedSplit.mockResolvedValue(uploadResponse('s9', [0, 1]));
    await store.cutScans();
    expect(store.cutting).toBe(false);
    expect(store.order).toEqual([0, 1]);
    store.openCutting();
    expect(store.cutting).toBe(true);
    store.closeCutting();
    expect(store.cutting).toBe(false);
  });

  it('keeps scans, the geometry and the cut screen in the local snapshot', async () => {
    mockedUploadScans.mockResolvedValue(scansResponse('s9', [0, 1]));
    const store = useStudioStore();
    store.setScanMode(4);
    await store.upload([file('a.tif', ''), file('b.tif', '')]);
    await vi.waitFor(() => expect(loadLocalSnapshot()?.scans).toHaveLength(2), {
      timeout: LOCAL_SAVE_DEBOUNCE_MS * 4
    });
    const saved = loadLocalSnapshot();
    expect(saved?.cutting).toBe(true);
    expect(saved?.split?.count).toBe(4);

    setActivePinia(createPinia());
    const fresh = useStudioStore();
    await fresh.restoreLocal();
    expect(fresh.scans).toHaveLength(2);
    expect(fresh.cutting).toBe(true);
    expect(fresh.split?.count).toBe(4);
    expect(fresh.uploadStatus?.key).toBe('studio.upload.restoredScans');
  });
});

describe('studio store · heavy files', () => {
  function heavy(name: string, mb: number, type = 'image/jpeg'): File {
    return new File([new Uint8Array(mb * MEGABYTE + 1)], name, { type });
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    frameBuffers.clear();
    localStorage.clear();
    mockedUpload.mockReset();
    mockedShrinkAll.mockReset();
    mockedDetect.mockReset();
    mockedDetect.mockResolvedValue({ order: [0, 1, 2, 3], confidence: 0.9 });
  });

  it('asks before compressing heavy files and uploads the compressed copies on confirm', async () => {
    mockedShrinkAll.mockImplementation(async (files, _side, onProgress) => {
      onProgress?.(files.length);
      return files.map((f) => new File(['x'], jpegName(f.name), { type: 'image/jpeg' }));
    });
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0, 1]));
    const store = useStudioStore();
    await store.upload([heavy('Big Scan.JPG', 12), file('small.png')]);
    expect(mockedUpload).not.toHaveBeenCalled();
    expect(store.uploadNotice).toMatchObject({ heavy: 1, total: 2, largestMb: 12, side: 3000 });

    await store.confirmUpload();
    expect(store.uploadNotice).toBeNull();
    expect(mockedShrinkAll).toHaveBeenCalledWith(expect.any(Array), 3000, expect.any(Function));
    const sent = mockedUpload.mock.calls[0][0].map((f) => f.name);
    expect(sent).toEqual(['Big Scan.jpg', 'small.jpg']);
    expect(store.frameCount).toBe(2);
  });

  it('cancels a pending upload without touching the server', async () => {
    const store = useStudioStore();
    await store.upload([heavy('a.jpg', 11)]);
    expect(store.uploadNotice).not.toBeNull();
    store.cancelUpload();
    expect(store.uploadNotice).toBeNull();
    await store.confirmUpload();
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  it('compresses oversized frames silently and skips what stays above the hard limit', async () => {
    mockedShrinkAll.mockImplementation(async (files) => files);
    mockedUpload.mockResolvedValue(uploadResponse('s1', [0]));
    const store = useStudioStore();
    await store.upload([file('ok.png'), heavy('raw.tif', 26, '')]);
    await store.confirmUpload();
    expect(mockedUpload).toHaveBeenCalledTimes(1);
    expect(mockedUpload.mock.calls[0][0].map((f) => f.name)).toEqual(['ok.png']);
    expect(store.uploadStatus).toMatchObject({
      key: 'studio.upload.skippedLarge',
      params: { n: 1, limitMb: 25 },
      tone: 'warn'
    });
  });

  it('reports when nothing can be uploaded', async () => {
    mockedShrinkAll.mockImplementation(async (files) => files);
    const store = useStudioStore();
    await store.upload([heavy('raw.tif', 26, '')]);
    await store.confirmUpload();
    expect(mockedUpload).not.toHaveBeenCalled();
    expect(store.uploadStatus?.key).toBe('studio.upload.allTooLarge');
    expect(store.prepare).toBeNull();
  });

  it('uses the scan side limit for scans', async () => {
    mockedShrinkAll.mockImplementation(async (files) => files);
    mockedUploadScans.mockReset();
    mockedUploadScans.mockResolvedValue({
      session_id: 's2',
      scans: [],
      total: 0
    });
    const store = useStudioStore();
    store.setScanMode(4);
    await store.upload([file('scan.png')]);
    expect(mockedShrinkAll).toHaveBeenCalledWith(expect.any(Array), 8000, expect.any(Function));
  });
});
