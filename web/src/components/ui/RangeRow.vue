<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue: number;
    min: number;
    max: number;
    step?: number;
    signed?: boolean;
    resetTitle?: string;
    disabled?: boolean;
    placeholder?: string;
  }>(),
  { step: 1, signed: true, resetTitle: '', disabled: false, placeholder: '' }
);

const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

const display = computed(() => {
  if (props.placeholder) return props.placeholder;
  const value = props.modelValue;
  if (value > 0 && props.signed) return `+${value}`;
  return String(value);
});

function onInput(event: Event): void {
  emit('update:modelValue', parseInt((event.target as HTMLInputElement).value, 10));
}
</script>

<template>
  <label class="grid grid-cols-[96px_minmax(0,1fr)_36px] items-center gap-3 text-[13px]">
    <span class="text-ink-2 truncate">{{ label }}</span>
    <input
      type="range"
      class="accent-ink h-5 w-full min-w-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      :title="resetTitle"
      @input="onInput"
      @dblclick="disabled || emit('update:modelValue', 0)"
    />
    <output
      class="tabular text-right"
      :class="{
        'text-accent font-semibold': modelValue !== 0 && !placeholder,
        'text-ink-2': placeholder
      }"
    >
      {{ display }}
    </output>
  </label>
</template>
