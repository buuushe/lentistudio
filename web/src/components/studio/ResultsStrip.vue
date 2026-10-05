<script setup lang="ts">
import { Archive, Download } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import type { BatchItem, RenderResponse } from '@/api/types';
import { useStudioStore } from '@/stores/studio';

const FRESH_HIGHLIGHT_MS = 2500;

const { t } = useI18n();
const studio = useStudioStore();
const section = ref<HTMLElement | null>(null);
const fresh = ref(false);
let freshTimer: ReturnType<typeof setTimeout> | null = null;

function label(item: RenderResponse): string {
  const numbers = item.video_name
    .replace(/^out_/, '')
    .replace(/\.mp4$/, '')
    .split('-')
    .map((index) => Number(index) + 1);
  const sets: string[] = [];
  for (let start = 0; start < numbers.length; start += studio.setSize) {
    sets.push(numbers.slice(start, start + studio.setSize).join('-'));
  }
  return sets.join(' · ');
}

const current = computed(() => studio.currentRender);
const batch = computed(() => (studio.separate ? studio.batch : null));

function batchItemTitle(item: BatchItem): string {
  const name = t('studio.sets.tab', { n: item.set });
  if (item.status === 'failed') return `${name} · ${item.error?.message ?? ''}`;
  if (item.status === 'pending') return `${name} · ${t('studio.batch.pending')}`;
  return name;
}

const info = computed(() => {
  const item = current.value;
  if (!item) return '';
  return t('studio.render.resultInfo', {
    frames: label(item),
    size: `${item.width}×${item.height}`,
    count: item.frames,
    fps: item.fps,
    seconds: item.duration.toFixed(1),
    mb: (item.size_bytes / (1024 * 1024)).toFixed(1)
  });
});

async function announceFreshResult(): Promise<void> {
  await nextTick();
  section.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  fresh.value = true;
  if (freshTimer) clearTimeout(freshTimer);
  freshTimer = setTimeout(() => {
    fresh.value = false;
  }, FRESH_HIGHLIGHT_MS);
}

watch(
  () => studio.renders[0],
  (latest, previous) => {
    if (latest && latest !== previous) void announceFreshResult();
  }
);

onBeforeUnmount(() => {
  if (freshTimer) clearTimeout(freshTimer);
});
</script>

<template>
  <section v-if="current" ref="section" class="flex min-h-0 flex-col gap-2">
    <header class="flex items-center gap-2 text-[13px]">
      <span
        class="bg-accent inline-block h-1.5 w-1.5 shrink-0 rounded-full transition-opacity duration-1000"
        :class="fresh ? 'opacity-100' : 'opacity-0'"
        aria-hidden="true"
      />
      <p class="text-ink-2 tabular min-w-0 truncate text-[11px]" :title="info">{{ info }}</p>
      <a
        :href="current.download_url"
        class="hover:border-ink ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors duration-1000"
        :class="fresh ? 'border-accent' : 'border-line'"
        download
      >
        <Download class="h-3.5 w-3.5" />
        <span>{{ t('studio.render.download') }}</span>
      </a>
    </header>
    <video
      :key="current.video_url"
      :src="current.video_url"
      :poster="current.poster_url"
      class="max-h-[38vh] max-w-full self-center rounded-sm bg-black"
      controls
      autoplay
      loop
      muted
      playsinline
    />
    <div v-if="batch" class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2 text-[12px]">
        <span class="text-ink-2 tabular">
          {{ t('studio.batch.summary', { done: batch.done, total: batch.total }) }}
        </span>
        <a
          v-if="batch.zip_url"
          :href="batch.zip_url"
          class="border-line hover:border-ink ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1"
          download
        >
          <Archive class="h-3.5 w-3.5" />
          <span>{{ t('studio.batch.downloadAll') }}</span>
        </a>
      </div>
      <ul class="flex max-h-[20vh] flex-wrap gap-1.5 overflow-y-auto">
        <li v-for="item in batch.items" :key="item.set">
          <button
            v-if="item.render"
            type="button"
            class="flex items-center gap-1.5 rounded-sm border p-0.5 text-[11px]"
            :class="
              item.render.video_name === current.video_name
                ? 'border-accent'
                : 'border-line hover:border-ink'
            "
            :title="batchItemTitle(item)"
            @click="item.render && studio.showRender(item.render)"
          >
            <img :src="item.render.poster_url" alt="" class="h-9 w-9 rounded-sm object-cover" />
            <span class="tabular pr-1">{{ t('studio.sets.tab', { n: item.set }) }}</span>
          </button>
          <span
            v-else
            class="flex h-10 items-center rounded-sm border px-2 text-[11px]"
            :class="
              item.status === 'failed'
                ? 'border-err text-err'
                : 'border-line text-ink-2 border-dashed'
            "
            :title="batchItemTitle(item)"
          >
            {{ t('studio.sets.tab', { n: item.set }) }}
          </span>
        </li>
      </ul>
    </div>
    <ul v-else-if="studio.renders.length > 1" class="flex flex-wrap gap-1.5">
      <li v-for="item in studio.renders" :key="item.video_name">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-sm border p-0.5 text-[11px]"
          :class="item === current ? 'border-accent' : 'border-line hover:border-ink'"
          @click="studio.showRender(item)"
        >
          <img :src="item.poster_url" alt="" class="h-9 w-9 rounded-sm object-cover" />
          <span class="tabular pr-1">{{ label(item) }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>
