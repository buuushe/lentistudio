<script setup lang="ts">
import { Moon, Sun } from '@lucide/vue';
import { useI18n } from 'vue-i18n';

import { useThemeStore } from '@/stores/theme';

const SITE_URL = 'https://lentistudio.com';

const { t } = useI18n();
const theme = useThemeStore();
</script>

<template>
  <header class="border-line border-b">
    <div class="flex h-8 items-center gap-4 px-3 text-[12px] sm:px-4">
      <span class="flex shrink-0 items-center gap-2 font-semibold">
        <svg viewBox="0 0 32 32" class="h-5 w-5" aria-hidden="true">
          <g fill="currentColor">
            <rect x="6" y="8" width="3" height="16" rx="1" />
            <rect x="12" y="8" width="3" height="16" rx="1" />
            <rect x="18" y="8" width="3" height="16" rx="1" />
          </g>
          <rect x="24" y="8" width="3" height="16" rx="1" class="fill-accent" />
        </svg>
        <span class="hidden md:inline">{{ t('common.appName') }}</span>
      </span>

      <div
        id="page-tools"
        class="border-line flex min-w-0 flex-1 items-center gap-x-4 border-l pl-4"
      />

      <div class="flex shrink-0 items-center gap-3">
        <a
          :href="SITE_URL"
          target="_blank"
          rel="noopener"
          class="text-ink-2 hover:text-ink"
          :title="t('header.siteHint')"
        >
          lentistudio.com
        </a>
        <button
          type="button"
          class="text-ink-2 hover:bg-bg-2 hover:text-ink rounded-md p-1.5"
          :aria-label="t('header.toggleTheme')"
          :title="t('header.toggleTheme')"
          @click="theme.toggle()"
        >
          <Sun v-if="theme.current === 'dark'" class="h-4 w-4" />
          <Moon v-else class="h-4 w-4" />
        </button>
      </div>
    </div>
  </header>
</template>
