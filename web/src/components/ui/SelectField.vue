<script setup lang="ts">
import { Check, ChevronDown } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import type { SelectOption, SelectValue } from '@/lib/select';

const props = withDefaults(
  defineProps<{
    modelValue: SelectValue;
    options: SelectOption[];
    size?: 'xs' | 'sm' | 'md' | 'lg';
    variant?: 'field' | 'plain';
    align?: 'start' | 'end';
    label?: string;
    title?: string;
    disabled?: boolean;
    triggerText?: string;
    placeholder?: string;
  }>(),
  {
    size: 'md',
    variant: 'field',
    align: 'start',
    disabled: false,
    label: undefined,
    title: undefined,
    triggerText: undefined,
    placeholder: undefined
  }
);

const emit = defineEmits<{ 'update:modelValue': [value: SelectValue] }>();

defineOptions({ inheritAttrs: false });

const uid = Math.random().toString(36).slice(2, 8);
const listId = `select-${uid}-list`;
const optionId = (index: number): string => `select-${uid}-option-${index}`;

const open = ref(false);
const active = ref(-1);
const trigger = ref<HTMLButtonElement | null>(null);
const list = ref<HTMLUListElement | null>(null);
const box = ref({ top: 'auto', bottom: 'auto', left: 0, minWidth: 0, maxHeight: 280 });

const selectedIndex = computed(() => props.options.findIndex((o) => o.value === props.modelValue));
const selectedLabel = computed(
  () => props.options[selectedIndex.value]?.label ?? props.placeholder ?? ''
);
const text = computed(() => props.triggerText ?? selectedLabel.value);

const sizeClass = computed(
  () =>
    ({
      xs: 'h-7 gap-1 px-1.5 text-[12px]',
      sm: 'h-6 gap-1 px-2 text-[12px]',
      md: 'h-8 gap-1.5 px-2 text-[13px]',
      lg: 'gap-1.5 px-2 py-1.5 text-[14px]'
    })[props.size]
);
const triggerClass = computed(() =>
  props.variant === 'plain'
    ? 'text-ink-2 hover:text-ink flex cursor-pointer items-center bg-transparent outline-none'
    : [
        'bg-bg-2 border-line hover:border-ink-2 flex min-w-0 cursor-pointer items-center justify-between rounded-sm border-b text-left outline-none disabled:cursor-default disabled:opacity-50',
        open.value ? 'border-ink' : '',
        sizeClass.value
      ]
);
const iconSize = computed(() => (props.size === 'md' || props.size === 'lg' ? 16 : 14));

function place(): void {
  const el = trigger.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 8;
  const abovePx = rect.top - 8;
  const above = below < 180 && abovePx > below;
  const minWidth = props.variant === 'plain' ? Math.max(rect.width, 160) : rect.width;
  const width = Math.max(minWidth, list.value?.offsetWidth ?? 0);
  box.value = {
    top: above ? 'auto' : `${rect.bottom + 4}px`,
    bottom: above ? `${window.innerHeight - rect.top + 4}px` : 'auto',
    left:
      props.align === 'end'
        ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
        : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    minWidth,
    maxHeight: Math.max(120, Math.min(280, above ? abovePx : below))
  };
}

function scrollActiveIntoView(): void {
  const option = list.value?.children[active.value];
  if (option instanceof HTMLElement) option.scrollIntoView?.({ block: 'nearest' });
}

async function openList(): Promise<void> {
  if (props.disabled || open.value) return;
  active.value = selectedIndex.value >= 0 ? selectedIndex.value : 0;
  place();
  open.value = true;
  await nextTick();
  place();
  scrollActiveIntoView();
}

function close(): void {
  open.value = false;
  active.value = -1;
}

function pick(index: number): void {
  const option = props.options[index];
  if (!option || option.disabled) return;
  if (option.value !== props.modelValue) emit('update:modelValue', option.value);
  close();
  trigger.value?.focus();
}

function step(delta: number): void {
  const total = props.options.length;
  if (!total) return;
  let next = active.value;
  for (let i = 0; i < total; i += 1) {
    next = (next + delta + total) % total;
    if (!props.options[next]?.disabled) break;
  }
  active.value = next;
  void nextTick(scrollActiveIntoView);
}

let typed = '';
let typedAt = 0;
function typeAhead(key: string): boolean {
  if (key.length !== 1 || key === ' ') return false;
  const now = Date.now();
  typed = now - typedAt > 700 ? key : typed + key;
  typedAt = now;
  const start = typed.length > 1 ? active.value : active.value + 1;
  const total = props.options.length;
  for (let i = 0; i < total; i += 1) {
    const index = (start + i + total) % total;
    const option = props.options[index];
    if (!option?.disabled && option?.label.toLowerCase().startsWith(typed.toLowerCase())) {
      active.value = index;
      void nextTick(scrollActiveIntoView);
      return true;
    }
  }
  return false;
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (!open.value) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      void openList();
    }
    return;
  }
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      close();
      break;
    case 'Tab':
      close();
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      pick(active.value);
      break;
    case 'ArrowDown':
      event.preventDefault();
      step(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      step(-1);
      break;
    case 'Home':
      event.preventDefault();
      active.value = -1;
      step(1);
      break;
    case 'End':
      event.preventDefault();
      active.value = 0;
      step(-1);
      break;
    default:
      if (typeAhead(event.key)) event.preventDefault();
  }
}

function onPointerDown(event: Event): void {
  const target = event.target;
  const inside =
    target instanceof Node && (trigger.value?.contains(target) || list.value?.contains(target));
  if (!inside) close();
}

function hover(index: number): void {
  if (!props.options[index]?.disabled) active.value = index;
}

function listen(on: boolean): void {
  if (on) {
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return;
  }
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
}

watch(open, listen);

onBeforeUnmount(() => listen(false));
</script>

<template>
  <button
    ref="trigger"
    type="button"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? listId : undefined"
    :aria-activedescendant="open && active >= 0 ? optionId(active) : undefined"
    :aria-label="label"
    :title="title"
    :disabled="disabled"
    :class="triggerClass"
    v-bind="$attrs"
    @click="open ? close() : openList()"
    @keydown="onKeydown"
  >
    <span class="truncate">{{ text }}</span>
    <ChevronDown
      :size="iconSize"
      :stroke-width="1.5"
      class="shrink-0 transition-transform"
      :class="open ? 'rotate-180' : ''"
      aria-hidden="true"
    />
  </button>

  <Teleport to="body">
    <ul
      v-if="open"
      :id="listId"
      ref="list"
      role="listbox"
      :aria-label="label"
      class="bg-bg border-line fixed z-50 w-max max-w-[min(90vw,420px)] overflow-x-hidden overflow-y-auto rounded-md border py-1"
      :style="{
        top: box.top,
        bottom: box.bottom,
        left: `${box.left}px`,
        minWidth: `${box.minWidth}px`,
        maxHeight: `${box.maxHeight}px`
      }"
    >
      <li
        v-for="(option, index) in options"
        :id="optionId(index)"
        :key="String(option.value)"
        role="option"
        :aria-selected="option.value === modelValue"
        :aria-disabled="option.disabled"
        class="flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-[13px]"
        :class="[
          index === active ? 'bg-bg-2' : '',
          option.disabled ? 'text-ink-2 cursor-default opacity-50' : ''
        ]"
        @pointerenter="hover(index)"
        @click="pick(index)"
      >
        <span class="truncate">{{ option.label }}</span>
        <Check
          v-if="option.value === modelValue"
          :size="14"
          :stroke-width="1.5"
          class="text-accent shrink-0"
          aria-hidden="true"
        />
      </li>
    </ul>
  </Teleport>
</template>
