<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { useStudioStore } from '@/stores/studio';

const { t } = useI18n();
const studio = useStudioStore();
const confirmButton = ref<HTMLButtonElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    studio.cancelUpload();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  confirmButton.value?.focus();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="studio.uploadNotice"
      class="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4"
      @click.self="studio.cancelUpload()"
    >
      <div
        class="bg-bg border-line flex w-full max-w-[440px] flex-col gap-3 rounded-md border p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-notice-title"
      >
        <h2 id="upload-notice-title" class="text-[16px] font-semibold">
          {{ t('studio.upload.notice.title', { limitMb: studio.uploadNotice.softMb }) }}
        </h2>
        <p class="text-[13px] leading-relaxed">
          {{
            t('studio.upload.notice.body', {
              n: studio.uploadNotice.heavy,
              total: studio.uploadNotice.total,
              largestMb: studio.uploadNotice.largestMb,
              side: studio.uploadNotice.side
            })
          }}
        </p>
        <p class="text-ink-2 text-[12px] leading-relaxed">
          {{ t('studio.upload.notice.tiff', { hardMb: studio.uploadNotice.hardMb }) }}
        </p>
        <div class="mt-1 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="text-ink-2 hover:text-ink h-9 rounded-md px-3 text-[13px]"
            @click="studio.cancelUpload()"
          >
            {{ t('studio.upload.notice.cancel') }}
          </button>
          <button
            ref="confirmButton"
            type="button"
            class="bg-accent h-9 rounded-md px-4 text-[13px] font-semibold text-white"
            @click="studio.confirmUpload()"
          >
            {{ t('studio.upload.notice.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
