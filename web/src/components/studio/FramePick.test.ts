import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FramePick from '@/components/studio/FramePick.vue';
import { i18n } from '@/i18n';
import type { FrameBuffer } from '@/lib/frameBuffers';
import { frameBuffers, useStudioStore } from '@/stores/studio';

vi.mock('@/api/renderApi', () => ({
  uploadFrames: vi.fn(),
  detectOrder: vi.fn(),
  matchPoint: vi.fn(),
  renderVideo: vi.fn()
}));

function fakeBuffer(index: number): FrameBuffer {
  return {
    index,
    image: {} as HTMLImageElement,
    work: { width: 200, height: 150 } as HTMLCanvasElement,
    workScale: 0.5,
    version: 0
  };
}

describe('FramePick', () => {
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    setActivePinia(createPinia());
    frameBuffers.clear();
    frameBuffers.set(fakeBuffer(0));
    const store = useStudioStore();
    store.sessionId = 's1';
    store.frames = [
      { index: 0, name: 'a.png', width: 400, height: 300, url: '/f/0', thumb_url: '/f/0/thumb' }
    ];
    store.order = [0];
    store.autoMatch = false;
  });

  function mountPick() {
    const wrapper = mount(FramePick, {
      props: { index: 0, position: 0 },
      global: { plugins: [i18n] }
    });
    const canvas = wrapper.find('canvas').element as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 }) as DOMRect;
    canvas.setPointerCapture = () => undefined;
    return { wrapper, canvas };
  }

  it('sets a manual point where the pointer lands', async () => {
    const { wrapper, canvas } = mountPick();
    const store = useStudioStore();
    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 100, clientY: 75, button: 0, bubbles: true })
    );
    await wrapper.vm.$nextTick();
    expect(store.points[0]).toEqual({ x: 200, y: 150 });
    expect(store.pointMeta[0]).toEqual({ source: 'manual' });
    expect(wrapper.find('[role="img"]').attributes('aria-label')).toBe('manual');
  });

  it('nudges the point with arrow keys, ten pixels with shift', async () => {
    const { wrapper, canvas } = mountPick();
    const store = useStudioStore();
    store.setPoint(0, { x: 50, y: 50 });
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true })
    );
    await wrapper.vm.$nextTick();
    expect(store.points[0]).toEqual({ x: 51, y: 60 });
  });

  it('shows the confidence for automatic points', async () => {
    const { wrapper } = mountPick();
    const store = useStudioStore();
    store.points[0] = { x: 1, y: 1 };
    store.pointMeta[0] = { source: 'auto', score: 0.42 };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="img"]').attributes('aria-label')).toBe('auto 0.42');
    expect(wrapper.find('[role="img"]').classes()).toContain('bg-err');
  });
});
