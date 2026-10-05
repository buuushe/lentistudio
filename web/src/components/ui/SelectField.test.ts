import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import SelectField from '@/components/ui/SelectField.vue';

const options = [
  { value: 'nimslo', label: 'Nimslo' },
  { value: 'nishika', label: 'Nishika' },
  { value: 'sputnik', label: 'Sputnik', disabled: true },
  { value: null, label: 'Any' }
];

const mounted: { unmount: () => void }[] = [];

function open(value: string | number | null = 'nimslo') {
  const wrapper = mount(SelectField, {
    props: { modelValue: value, options, label: 'Camera' },
    attachTo: document.body
  });
  mounted.push(wrapper);
  return wrapper;
}

function listItems(): HTMLElement[] {
  return [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[];
}

afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = '';
});

describe('SelectField', () => {
  it('shows the selected label and no list until opened', () => {
    const wrapper = open();
    expect(wrapper.get('[role="combobox"]').text()).toContain('Nimslo');
    expect(wrapper.get('[role="combobox"]').attributes('aria-expanded')).toBe('false');
    expect(listItems()).toHaveLength(0);
  });

  it('opens on click and marks the selected option', async () => {
    const wrapper = open('nishika');
    await wrapper.get('[role="combobox"]').trigger('click');
    const items = listItems();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Nimslo',
      'Nishika',
      'Sputnik',
      'Any'
    ]);
    expect(items[1]?.getAttribute('aria-selected')).toBe('true');
    expect(wrapper.get('[role="combobox"]').attributes('aria-expanded')).toBe('true');
  });

  it('emits the picked value and closes, including a null option', async () => {
    const wrapper = open();
    await wrapper.get('[role="combobox"]').trigger('click');
    listItems()[3]?.click();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')).toEqual([[null]]);
    expect(listItems()).toHaveLength(0);
  });

  it('ignores a disabled option', async () => {
    const wrapper = open();
    await wrapper.get('[role="combobox"]').trigger('click');
    listItems()[2]?.click();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(listItems()).toHaveLength(4);
  });

  it('opens with the keyboard, skips disabled options and picks with Enter', async () => {
    const wrapper = open();
    const trigger = wrapper.get('[role="combobox"]');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(listItems()).toHaveLength(4);
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(trigger.attributes('aria-activedescendant')).toBe(listItems()[3]?.id);
    await trigger.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')).toEqual([[null]]);
  });

  it('jumps to an option by typing and closes on Escape', async () => {
    const wrapper = open();
    const trigger = wrapper.get('[role="combobox"]');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await trigger.trigger('keydown', { key: 'a' });
    expect(trigger.attributes('aria-activedescendant')).toBe(listItems()[3]?.id);
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(listItems()).toHaveLength(0);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('closes when a pointer goes down outside', async () => {
    const wrapper = open();
    await wrapper.get('[role="combobox"]').trigger('click');
    expect(listItems()).toHaveLength(4);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(listItems()).toHaveLength(0);
  });
});
