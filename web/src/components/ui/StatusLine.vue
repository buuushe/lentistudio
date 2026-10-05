<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { StatusMessage } from '@/lib/status';

const props = defineProps<{ status: StatusMessage | null }>();

const { t, te } = useI18n();

const text = computed(() => {
  const s = props.status;
  if (!s) return '';
  if (te(s.key)) return t(s.key, s.params ?? {});
  return s.fallback ?? s.key;
});

const toneClass = computed(() => {
  switch (props.status?.tone) {
    case 'ok':
      return 'text-ok';
    case 'warn':
      return 'text-warn';
    case 'err':
      return 'text-err';
    default:
      return 'text-ink-2';
  }
});
</script>

<template>
  <p class="min-h-5 text-[13px]" :class="toneClass" role="status">{{ text }}</p>
</template>
