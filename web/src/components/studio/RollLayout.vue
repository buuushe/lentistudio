<script setup lang="ts">
import {
  Eye,
  EyeOff,
  LayoutGrid,
  ListOrdered,
  Minus,
  Palette,
  Plus,
  Scissors,
  Shuffle,
  WandSparkles,
  X
} from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import StatusLine from '@/components/ui/StatusLine.vue';
import { useSetVisibilityTitle } from '@/composables/useSetVisibilityTitle';
import { useStudioStore } from '@/stores/studio';

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const studio = useStudioStore();

type LayoutView = 'sets' | 'roll';

const view = ref<LayoutView>('sets');
const freeFrames = computed(() => {
  const used = new Set(studio.assignedFrames);
  return studio.frames.filter((frame) => !used.has(frame.index));
});
const canSplit = computed(() => studio.frameCount >= studio.setSize * 2);
const hasCompleteSet = computed(() =>
  studio.sets.some((set) => set.frames.length === studio.setSize)
);

function setOf(index: number): number {
  return studio.setOf(index);
}

function positionIn(setIndex: number, index: number): number {
  return studio.sets[setIndex].frames.indexOf(index) + 1;
}

function startsRun(rollPosition: number): boolean {
  const index = studio.frames[rollPosition].index;
  const setIndex = setOf(index);
  if (setIndex < 0) return false;
  const previous = studio.frames[rollPosition - 1];
  return !previous || setOf(previous.index) !== setIndex;
}

async function groupBySimilarity(): Promise<void> {
  await studio.groupLibraryBySimilarity();
  view.value = 'sets';
}

function viewClass(candidate: LayoutView): string {
  return view.value === candidate
    ? 'border-ink text-ink'
    : 'border-transparent text-ink-2 hover:text-ink';
}

function onFrameClick(index: number): void {
  const setIndex = setOf(index);
  if (setIndex >= 0) studio.selectSet(setIndex);
  else studio.toggleSelect(index);
}

function barClass(setIndex: number): string {
  if (setIndex < 0) return 'bg-transparent';
  return setIndex === studio.activeSet ? 'bg-accent' : 'bg-ink-2';
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const toolClass =
  'border-line hover:border-ink flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] whitespace-nowrap disabled:opacity-40';
function inHiddenSet(index: number): boolean {
  const setIndex = setOf(index);
  return setIndex >= 0 && Boolean(studio.sets[setIndex]?.hidden);
}

const hideTitle = useSetVisibilityTitle();
</script>

<template>
  <Teleport to="body">
    <div
      class="bg-bg fixed inset-0 z-50 flex flex-col gap-3 overflow-hidden p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="t('studio.layout.title')"
    >
      <header class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 class="text-[16px] font-semibold">{{ t('studio.layout.title') }}</h2>
        <span class="text-ink-2 tabular text-[13px]">
          {{ t('studio.library.info', { n: studio.frameCount }) }} ·
          {{ t('studio.sets.count', { n: studio.setCount }) }}
        </span>
        <button
          type="button"
          class="text-ink-2 hover:bg-bg-2 hover:text-ink ml-auto rounded-md p-1.5"
          :title="t('studio.layout.close')"
          :aria-label="t('studio.layout.close')"
          @click="$emit('close')"
        >
          <X class="h-5 w-5" />
        </button>
      </header>

      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="canSplit"
          type="button"
          :class="toolClass"
          @click="studio.splitLibraryIntoSets()"
        >
          <LayoutGrid class="h-4 w-4" />
          <span>{{ t('studio.sets.splitAll', { n: studio.setSize }) }}</span>
        </button>
        <button
          v-if="canSplit"
          type="button"
          :class="toolClass"
          :disabled="studio.shuffling"
          @click="groupBySimilarity()"
        >
          <WandSparkles class="h-4 w-4" :class="{ 'animate-pulse': studio.shuffling }" />
          <span>{{ t('studio.sets.groupSimilar', { n: studio.setSize }) }}</span>
        </button>
        <button
          v-if="hasCompleteSet"
          type="button"
          :class="toolClass"
          @click="studio.correctAllOrders()"
        >
          <ListOrdered class="h-4 w-4" />
          <span>{{ t('studio.order.correctAll') }}</span>
        </button>
        <template v-if="studio.setCount > 2">
          <button
            type="button"
            :class="toolClass"
            :disabled="studio.shuffling"
            @click="studio.shuffleSets('similar')"
          >
            <Palette class="h-4 w-4" />
            <span>{{ t('studio.sets.shuffleSimilar') }}</span>
          </button>
          <button
            type="button"
            :class="toolClass"
            :disabled="studio.shuffling"
            @click="studio.shuffleSets('contrast')"
          >
            <Shuffle class="h-4 w-4" />
            <span>{{ t('studio.sets.shuffleContrast') }}</span>
          </button>
        </template>
        <span class="border-line mx-1 h-5 border-l" aria-hidden="true" />
        <button type="button" :class="toolClass" @click="studio.addSet()">
          <Plus class="h-4 w-4" />
          <span>{{ t('studio.sets.add', { n: studio.setSize }) }}</span>
        </button>
        <button
          v-if="studio.setCount > 1"
          type="button"
          :class="toolClass"
          @click="studio.removeSet(studio.activeSet)"
        >
          <Minus class="h-4 w-4" />
          <span>{{ t('studio.sets.remove', { n: studio.activeSet + 1 }) }}</span>
        </button>
        <StatusLine :status="studio.shuffleStatus" class="min-w-0 flex-1 truncate text-[12px]" />
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div class="border-line flex gap-3 border-b text-[13px]" role="tablist">
          <button
            type="button"
            role="tab"
            class="-mb-px border-b py-1 font-semibold"
            :class="viewClass('sets')"
            :aria-selected="view === 'sets'"
            @click="view = 'sets'"
          >
            {{ t('studio.layout.bySets') }}
          </button>
          <button
            type="button"
            role="tab"
            class="-mb-px border-b py-1 font-semibold"
            :class="viewClass('roll')"
            :aria-selected="view === 'roll'"
            @click="view = 'roll'"
          >
            {{ t('studio.layout.byRoll') }}
          </button>
        </div>
        <p class="text-ink-2 min-w-0 flex-1 text-[12px]">
          {{
            view === 'sets'
              ? t('studio.layout.hintSets', { n: studio.setSize })
              : t('studio.layout.hint')
          }}
        </p>
      </div>

      <div
        v-if="view === 'sets'"
        class="flex min-h-0 flex-1 flex-wrap content-start gap-3 overflow-y-auto pr-1"
      >
        <section
          v-for="(set, setIndex) in studio.sets"
          :key="setIndex"
          class="flex flex-col gap-2 rounded-md border p-2"
          :class="[
            setIndex === studio.activeSet ? 'border-accent' : 'border-line',
            { 'border-dashed opacity-60': set.hidden }
          ]"
        >
          <div class="flex items-center gap-2 text-[12px] font-semibold">
            <button
              type="button"
              class="flex items-center gap-2 text-left"
              :class="setIndex === studio.activeSet ? 'text-accent' : 'text-ink hover:text-accent'"
              @click="studio.selectSet(setIndex)"
            >
              <span>{{ t('studio.sets.tab', { n: setIndex + 1 }) }}</span>
              <span class="text-ink-2 tabular font-normal">
                {{ studio.pointsInSet(setIndex) }} / {{ studio.setSize }}
              </span>
            </button>
            <span v-if="set.hidden" class="text-ink-2 font-normal">
              {{ studio.separate ? t('studio.sets.notRendered') : t('studio.sets.hiddenState') }}
            </span>
            <button
              type="button"
              class="text-ink-2 hover:bg-bg-2 hover:text-ink ml-auto rounded-sm p-0.5 disabled:opacity-40"
              :disabled="!studio.canHideSet(setIndex)"
              :title="hideTitle(setIndex, set)"
              :aria-label="hideTitle(setIndex, set)"
              :aria-pressed="set.hidden"
              @click="studio.toggleSetHidden(setIndex)"
            >
              <EyeOff v-if="set.hidden" class="h-4 w-4" />
              <Eye v-else class="h-4 w-4" />
            </button>
          </div>
          <ul
            class="flex gap-2"
            role="listbox"
            :aria-label="t('studio.sets.tab', { n: setIndex + 1 })"
          >
            <li
              v-for="index in set.frames"
              :key="index"
              class="relative w-28 shrink-0 select-none"
              role="option"
              :aria-selected="setIndex === studio.activeSet"
              :title="studio.frames[index]?.name"
            >
              <button
                type="button"
                class="block w-full cursor-pointer"
                :aria-label="studio.frames[index]?.name"
                @click="studio.toggleSelect(index)"
              >
                <img
                  :src="studio.frames[index]?.thumb_url ?? studio.frames[index]?.url"
                  alt=""
                  draggable="false"
                  loading="lazy"
                  decoding="async"
                  class="aspect-[3/2] w-full rounded-sm object-cover"
                />
              </button>
              <span
                class="tabular pointer-events-none absolute top-1 right-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-semibold text-white"
                :class="setIndex === studio.activeSet ? 'bg-accent' : 'bg-ink-2'"
              >
                {{ positionIn(setIndex, index) }}
              </span>
              <span
                v-if="studio.points[index]"
                class="bg-warn pointer-events-none absolute right-1.5 bottom-1.5 h-2 w-2 rounded-full ring-2 ring-white"
              />
            </li>
            <li
              v-for="slot in studio.setSize - set.frames.length"
              :key="`empty-${slot}`"
              class="border-line aspect-[3/2] w-28 shrink-0 rounded-sm border border-dashed"
            />
          </ul>
        </section>

        <section v-if="freeFrames.length" class="flex min-w-0 flex-col gap-2 p-2">
          <span class="text-ink-2 text-[12px] font-semibold">{{ t('studio.sets.free') }}</span>
          <ul class="flex flex-wrap gap-2" role="listbox" :aria-label="t('studio.sets.free')">
            <li
              v-for="frame in freeFrames"
              :key="frame.index"
              class="w-28 shrink-0 select-none"
              role="option"
              :aria-selected="false"
              :title="frame.name"
            >
              <button
                type="button"
                class="block w-full cursor-pointer"
                :aria-label="frame.name"
                @click="studio.toggleSelect(frame.index)"
              >
                <img
                  :src="frame.thumb_url ?? frame.url"
                  alt=""
                  draggable="false"
                  loading="lazy"
                  decoding="async"
                  class="aspect-[3/2] w-full rounded-sm object-cover opacity-60"
                />
              </button>
            </li>
          </ul>
        </section>
      </div>

      <ul
        v-else
        class="flex min-h-0 flex-1 flex-wrap content-start gap-x-2 gap-y-6 overflow-y-auto pr-1"
        role="listbox"
        :aria-label="t('studio.library.title')"
      >
        <li
          v-for="(frame, rollPosition) in studio.frames"
          :key="frame.index"
          class="group relative w-28 shrink-0 select-none"
          role="option"
          :aria-selected="setOf(frame.index) === studio.activeSet"
          :title="frame.name"
        >
          <button
            type="button"
            class="block w-full cursor-pointer"
            :aria-label="frame.name"
            @click="onFrameClick(frame.index)"
          >
            <img
              :src="frame.thumb_url ?? frame.url"
              alt=""
              draggable="false"
              loading="lazy"
              decoding="async"
              class="aspect-[3/2] w-full rounded-sm object-cover"
              :class="setOf(frame.index) < 0 || inHiddenSet(frame.index) ? 'opacity-50' : ''"
            />
          </button>
          <span
            v-if="setOf(frame.index) >= 0"
            class="tabular pointer-events-none absolute top-1 right-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-semibold text-white"
            :class="setOf(frame.index) === studio.activeSet ? 'bg-accent' : 'bg-ink-2'"
          >
            {{ positionIn(setOf(frame.index), frame.index) }}
          </span>
          <span
            v-if="studio.points[frame.index]"
            class="bg-warn pointer-events-none absolute right-1.5 bottom-4 h-2 w-2 rounded-full ring-2 ring-white"
          />
          <button
            type="button"
            class="bg-bg border-line hover:border-ink absolute top-1/2 -left-2 -translate-y-1/2 rounded-full border p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            :title="t('studio.layout.startHere')"
            :aria-label="t('studio.layout.startHere')"
            @click.stop="studio.startSetAt(frame.index)"
          >
            <Scissors class="h-3.5 w-3.5" />
          </button>
          <span
            class="absolute right-0 -bottom-3 left-0 h-0.75 rounded-full"
            :class="barClass(setOf(frame.index))"
          />
          <span
            v-if="startsRun(rollPosition)"
            class="tabular absolute -bottom-6 left-0 text-[11px] leading-3 font-semibold"
            :class="setOf(frame.index) === studio.activeSet ? 'text-accent' : 'text-ink-2'"
          >
            {{ setOf(frame.index) + 1 }}
          </span>
        </li>
      </ul>
    </div>
  </Teleport>
</template>
