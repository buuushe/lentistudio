<script setup lang="ts">
defineProps<{ title: string; text?: string }>();
</script>

<template>
  <section class="mx-auto flex max-w-[680px] flex-col gap-4 py-10">
    <h1 class="text-xl font-semibold">{{ title }}</h1>
    <p v-if="text" class="text-ink-2">{{ text }}</p>
    <div v-if="$slots.default" class="pt-2">
      <slot />
    </div>
  </section>
</template>
