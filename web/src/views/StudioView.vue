<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import CompositionSection from '@/components/studio/CompositionSection.vue';
import FileSection from '@/components/studio/FileSection.vue';
import FrameGrid from '@/components/studio/FrameGrid.vue';
import OutputChoice from '@/components/studio/OutputChoice.vue';
import PrepareScreen from '@/components/studio/PrepareScreen.vue';
import PreviewCanvas from '@/components/studio/PreviewCanvas.vue';
import RenderBar from '@/components/studio/RenderBar.vue';
import ResultsStrip from '@/components/studio/ResultsStrip.vue';
import RollLayout from '@/components/studio/RollLayout.vue';
import ScanCutScreen from '@/components/studio/ScanCutScreen.vue';
import ScanModePicker from '@/components/studio/ScanModePicker.vue';
import SetPanel from '@/components/studio/SetPanel.vue';
import SetSizePicker from '@/components/studio/SetSizePicker.vue';
import UploadDrop from '@/components/studio/UploadDrop.vue';
import UploadNotice from '@/components/studio/UploadNotice.vue';
import StudioTimeline from '@/components/studio/StudioTimeline.vue';
import { usePlaybackStore } from '@/stores/playback';
import { useStudioStore } from '@/stores/studio';

type SideView = 'preview' | 'result';

const { t } = useI18n();
const studio = useStudioStore();
const playback = usePlaybackStore();
const sideView = ref<SideView>('preview');
const layoutOpen = ref(false);

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

function onKeydown(event: KeyboardEvent): void {
  if (layoutOpen.value) return;
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
  if (event.key === '[') studio.selectSet(studio.activeSet - 1);
  else if (event.key === ']') studio.selectSet(studio.activeSet + 1);
  else if (event.code === 'Space' && !(event.target instanceof HTMLButtonElement)) {
    playback.playing = !playback.playing;
    sideView.value = 'preview';
  } else return;
  event.preventDefault();
}

onMounted(() => {
  void studio.restoreLocal();
  window.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

watch(
  () => studio.renders[0],
  (latest, previous) => {
    if (latest && latest !== previous) sideView.value = 'result';
  }
);
watch(
  () => studio.batch?.status,
  (current, previous) => {
    if (previous === 'running' && current !== 'running' && studio.currentRender) {
      sideView.value = 'result';
    }
  }
);
watch(
  () => studio.currentRender,
  (current) => {
    if (!current) sideView.value = 'preview';
  }
);

const showingResult = computed(() => sideView.value === 'result' && studio.currentRender);

function tabClass(view: SideView): string {
  return sideView.value === view
    ? 'border-ink text-ink'
    : 'border-transparent text-ink-2 hover:text-ink';
}

const hint = computed(() => {
  if (!studio.frameCount) return t('studio.hint.addFrames');
  const several = studio.setCount > 1;
  if (studio.incompleteSet >= 0) {
    const set = studio.incompleteSet;
    const params = { n: studio.sets[set].frames.length, set: set + 1, max: studio.setSize };
    return t(several ? 'studio.hint.selectFourInSet' : 'studio.hint.selectFour', params);
  }
  if (studio.unmarkedSet >= 0) {
    const set = studio.unmarkedSet;
    const params = { n: studio.pointsInSet(set), set: set + 1, max: studio.setSize };
    return t(several ? 'studio.hint.markPointInSet' : 'studio.hint.markPoint', params);
  }
  if (!studio.layout) return t('studio.hint.noOverlap');
  return t('studio.hint.ready');
});
</script>

<template>
  <RollLayout v-if="layoutOpen" @close="layoutOpen = false" />
  <UploadNotice v-if="studio.uploadNotice" />

  <Teleport to="#page-tools" defer>
    <UploadDrop
      v-if="(studio.frameCount || studio.scans.length) && !studio.prepare"
      class="min-w-0 flex-1"
    />
  </Teleport>

  <div v-if="studio.prepare" class="flex w-full flex-col lg:h-[calc(100vh-var(--header-h)-1.5rem)]">
    <PrepareScreen />
  </div>

  <div
    v-else-if="studio.askOutput"
    class="flex w-full flex-col lg:h-[calc(100vh-var(--header-h)-1.5rem)]"
  >
    <OutputChoice />
  </div>

  <div
    v-else-if="studio.cutting && studio.scans.length"
    class="flex w-full flex-col lg:h-[calc(100vh-var(--header-h)-1.5rem)]"
  >
    <ScanCutScreen />
  </div>

  <div
    v-else-if="!studio.frameCount"
    class="mx-auto flex w-full max-w-[880px] flex-col gap-3 lg:h-[calc(100vh-var(--header-h)-1.5rem)]"
  >
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-2">
      <span class="text-ink-2 text-[13px]">{{ t('studio.setSize.title') }}</span>
      <SetSizePicker :model-value="studio.setSize" @update:model-value="studio.chooseSetSize" />
    </div>
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <span class="text-ink-2 text-[13px]">{{ t('studio.scanMode.title') }}</span>
      <ScanModePicker :model-value="studio.scanMode" @update:model-value="studio.setScanMode" />
    </div>
    <UploadDrop large class="min-h-0 flex-1" />
  </div>

  <div
    v-else
    class="grid gap-4 lg:h-[calc(100vh-var(--header-h)-1.5rem)] lg:grid-cols-[minmax(0,1fr)_minmax(380px,420px)]"
  >
    <section class="flex min-h-0 min-w-0 flex-col gap-3 lg:overflow-y-auto">
      <StudioTimeline @interact="sideView = 'preview'" @open-layout="layoutOpen = true" />
      <SetPanel />

      <div class="flex min-h-80 flex-1 flex-col gap-2">
        <FrameGrid />
        <p class="border-line text-ink-2 border-t pt-2 text-[13px]">{{ hint }}</p>
      </div>
    </section>

    <aside class="border-line flex min-h-0 flex-col gap-3 lg:border-l lg:pl-4">
      <div
        v-if="studio.currentRender"
        class="border-line flex gap-4 border-b text-[13px]"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          class="-mb-px border-b py-1 font-semibold"
          :class="tabClass('preview')"
          :aria-selected="sideView === 'preview'"
          @click="sideView = 'preview'"
        >
          {{ t('studio.preview.tab') }}
        </button>
        <button
          type="button"
          role="tab"
          class="-mb-px border-b py-1 font-semibold"
          :class="tabClass('result')"
          :aria-selected="sideView === 'result'"
          @click="sideView = 'result'"
        >
          {{ t('studio.render.tab') }}
        </button>
      </div>
      <ResultsStrip v-if="showingResult" />
      <PreviewCanvas v-else />

      <div class="border-line flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto border-t pt-3">
        <CompositionSection />
        <FileSection />
      </div>

      <div class="bg-bg max-lg:sticky max-lg:bottom-0 max-lg:z-10 max-lg:pb-1">
        <RenderBar />
      </div>
    </aside>
  </div>
</template>
