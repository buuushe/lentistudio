import { useI18n } from 'vue-i18n';

import { useStudioStore, type FrameSet } from '@/stores/studio';

export function useSetVisibilityTitle(): (setIndex: number, set: FrameSet) => string {
  const { t } = useI18n();
  const studio = useStudioStore();

  return (setIndex, set) => {
    const n = setIndex + 1;
    if (studio.separate) {
      if (!studio.canHideSet(setIndex)) return t('studio.sets.keepOneRendered');
      return t(set.hidden ? 'studio.sets.showInBatch' : 'studio.sets.hideFromBatch', { n });
    }
    if (!studio.canHideSet(setIndex)) return t('studio.sets.keepOneShown');
    return t(set.hidden ? 'studio.sets.show' : 'studio.sets.hide', { n });
  };
}
