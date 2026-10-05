<script setup lang="ts">
import Hint from '@/components/ui/Hint.vue';

withDefaults(defineProps<{ title: string; hint?: string; disabled?: boolean; dense?: boolean }>(), {
  hint: '',
  disabled: false,
  dense: false
});
</script>

<template>
  <section
    class="flex min-w-0 flex-col transition-opacity"
    :class="[dense ? 'gap-1.5' : 'gap-3', { 'pointer-events-none opacity-40': disabled }]"
  >
    <header class="flex items-center gap-2" :class="dense ? 'min-h-7' : 'min-h-8'">
      <h2 class="truncate font-semibold" :class="dense ? 'text-[13px]' : 'text-[15px]'">
        {{ title }}
      </h2>
      <Hint v-if="hint" :text="hint" />
      <span class="ml-auto flex shrink-0 items-center gap-1">
        <slot name="actions" />
      </span>
    </header>
    <div class="flex min-w-0 flex-col" :class="dense ? 'gap-1.5' : 'gap-2.5'">
      <slot />
    </div>
  </section>
</template>
