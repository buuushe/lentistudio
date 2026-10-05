import { defineStore } from 'pinia';
import { ref } from 'vue';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'lenti.theme';

function readStored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function fromSystem(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useThemeStore = defineStore('theme', () => {
  const current = ref<Theme>(readStored() ?? fromSystem());

  function applyToDocument(): void {
    document.documentElement.dataset.theme = current.value;
  }

  function setTheme(theme: Theme): void {
    current.value = theme;
    applyToDocument();
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      return;
    }
  }

  function toggle(): void {
    setTheme(current.value === 'dark' ? 'light' : 'dark');
  }

  return { current, setTheme, toggle, applyToDocument };
});
