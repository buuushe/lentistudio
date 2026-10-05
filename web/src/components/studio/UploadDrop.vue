<script setup lang="ts">
import { ImagePlus, Plus, RotateCcw } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import Hint from '@/components/ui/Hint.vue';
import StatusLine from '@/components/ui/StatusLine.vue';
import { useStudioStore } from '@/stores/studio';

withDefaults(defineProps<{ large?: boolean }>(), { large: false });

const { t } = useI18n();
const studio = useStudioStore();
const input = ref<HTMLInputElement | null>(null);
const over = ref(false);
const hasContent = computed(() => studio.frameCount > 0 || studio.scans.length > 0);

function onFiles(list: FileList | null): void {
  if (list && list.length) void studio.upload(list);
  if (input.value) input.value.value = '';
}

function onDrop(event: DragEvent): void {
  over.value = false;
  onFiles(event.dataTransfer?.files ?? null);
}

function resetAll(): void {
  if (window.confirm(t('studio.reset.confirm'))) studio.resetAll();
}
</script>

<template>
  <label
    v-if="large"
    class="border-line hover:border-ink flex h-full min-h-[40vh] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed p-8 text-center transition-colors"
    :class="{ 'border-ink bg-bg-2': over }"
    @dragenter.prevent="over = true"
    @dragover.prevent="over = true"
    @dragleave.prevent="over = false"
    @drop.prevent="onDrop"
  >
    <ImagePlus class="text-ink-2 h-10 w-10" :stroke-width="1.25" />
    <span class="text-[16px] font-semibold">{{ t('studio.upload.dropHere') }}</span>
    <span class="bg-accent rounded-md px-4 py-2 text-[14px] font-semibold text-white">
      {{ t('studio.upload.add') }}
    </span>
    <span class="text-ink-2 max-w-[480px] text-[12px]">{{
      studio.scanMode === 1
        ? t('studio.upload.hint', { n: studio.setSize })
        : t('studio.upload.scansHint')
    }}</span>
    <StatusLine :status="studio.uploadStatus" />
    <input
      ref="input"
      type="file"
      accept="image/*,.tif,.tiff,.webp,.bmp"
      multiple
      class="hidden"
      :disabled="studio.uploading"
      @change="onFiles(($event.target as HTMLInputElement).files)"
    />
  </label>
  <div v-else class="flex flex-nowrap items-center gap-3">
    <label
      class="border-line hover:border-ink flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-1 text-[13px] whitespace-nowrap transition-colors"
      :class="{ 'border-ink bg-bg-2': over }"
      @dragenter.prevent="over = true"
      @dragover.prevent="over = true"
      @dragleave.prevent="over = false"
      @drop.prevent="onDrop"
    >
      <Plus class="h-4 w-4" />
      <span>{{ hasContent ? t('studio.upload.addMore') : t('studio.upload.add') }}</span>
      <input
        ref="input"
        type="file"
        accept="image/*,.tif,.tiff,.webp,.bmp"
        multiple
        class="hidden"
        :disabled="studio.uploading"
        @change="onFiles(($event.target as HTMLInputElement).files)"
      />
    </label>
    <Hint :text="t('studio.upload.hint', { n: studio.setSize })" />
    <button
      v-if="hasContent"
      type="button"
      class="text-ink-2 hover:bg-bg-2 hover:text-ink flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] whitespace-nowrap"
      :title="t('studio.reset.confirm')"
      @click="resetAll"
    >
      <RotateCcw class="h-4 w-4" />
      <span>{{ t('studio.reset.button') }}</span>
    </button>
    <StatusLine :status="studio.uploadStatus" class="min-w-0 flex-1 truncate" />
  </div>
</template>
