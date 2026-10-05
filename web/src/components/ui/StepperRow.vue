<script setup lang="ts">
import { Minus, Plus } from '@lucide/vue';

const props = defineProps<{
  label: string;
  modelValue: number;
  min: number;
  max: number;
  lessLabel: string;
  moreLabel: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

function step(delta: number): void {
  const next = Math.min(props.max, Math.max(props.min, props.modelValue + delta));
  if (next !== props.modelValue) emit('update:modelValue', next);
}
</script>

<template>
  <div class="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3 text-[13px]">
    <span class="text-ink-2 truncate">{{ label }}</span>
    <div class="flex items-center gap-1" role="group" :aria-label="label">
      <button
        type="button"
        class="border-line hover:border-ink-2 grid h-7 w-7 place-items-center rounded-md border disabled:opacity-40"
        :disabled="modelValue <= min"
        :title="lessLabel"
        :aria-label="lessLabel"
        @click="step(-1)"
      >
        <Minus class="h-3.5 w-3.5" />
      </button>
      <output
        class="tabular w-8 text-center"
        :class="{ 'text-accent font-semibold': modelValue !== 0 }"
        aria-live="polite"
      >
        {{ modelValue }}
      </output>
      <button
        type="button"
        class="border-line hover:border-ink-2 grid h-7 w-7 place-items-center rounded-md border disabled:opacity-40"
        :disabled="modelValue >= max"
        :title="moreLabel"
        :aria-label="moreLabel"
        @click="step(1)"
      >
        <Plus class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
