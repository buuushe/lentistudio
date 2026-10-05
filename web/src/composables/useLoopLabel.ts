import { useI18n } from 'vue-i18n';

import { formatPattern, loopPattern, type LoopMode } from '@/lib/sequence';
import { useStudioStore } from '@/stores/studio';

export function useLoopLabel(): (mode: LoopMode) => string {
  const { t } = useI18n();
  const studio = useStudioStore();

  return (mode) => {
    const name = t(`studio.output.modes.${mode}`);
    if (mode === 'custom') return name;
    return `${name} · ${formatPattern(loopPattern(studio.setSize, mode))}`;
  };
}
