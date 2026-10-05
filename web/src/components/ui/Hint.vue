<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ text: string }>();

const open = ref(false);
</script>

<template>
  <span class="relative inline-flex">
    <button
      type="button"
      class="border-ink-2 text-ink-2 hover:border-ink hover:text-ink inline-grid h-4 w-4 place-items-center rounded-full border text-[10px] leading-none"
      :aria-expanded="open"
      aria-label="?"
      @click="open = !open"
      @blur="open = false"
      @mouseenter="open = true"
      @mouseleave="open = false"
    >
      ?
    </button>
    <span
      v-if="open"
      class="bg-ink text-bg absolute top-6 left-0 z-20 w-64 rounded-md px-3 py-2 text-[12px] leading-snug shadow-none"
      role="tooltip"
    >
      {{ text }}
    </span>
  </span>
</template>
