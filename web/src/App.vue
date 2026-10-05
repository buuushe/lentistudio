<script setup lang="ts">
import AppHeader from '@/components/layout/AppHeader.vue';
import StudioView from '@/views/StudioView.vue';
</script>

<template>
  <div class="flex min-h-screen flex-col" style="--header-h: 33px">
    <AppHeader />
    <main class="w-full flex-1 px-3 py-3 sm:px-4">
      <StudioView />
    </main>
  </div>
</template>
