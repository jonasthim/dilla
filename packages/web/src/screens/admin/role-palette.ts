// Flow 09: the twelve colours a role can take, named so a colour is never told by sight alone.
import { t, type StringKey } from '../../strings/index.ts';

const COLORS: readonly { value: number; key: string }[] = [
  { value: 0xE5484D, key: 'red' }, { value: 0xF76B15, key: 'orange' }, { value: 0xFFC53D, key: 'amber' }, { value: 0x30A46C, key: 'green' },
  { value: 0x12A594, key: 'teal' }, { value: 0x00A2C7, key: 'cyan' }, { value: 0x0090FF, key: 'blue' }, { value: 0x3E63DD, key: 'indigo' },
  { value: 0x8E4EC6, key: 'purple' }, { value: 0xD6409F, key: 'pink' }, { value: 0xAD7F58, key: 'brown' }, { value: 0x8B8D98, key: 'grey' },
];

/** The twelve named colours, plus the role's own colour as a 13th ("current colour") when it is set and not among them. */
export function paletteFor(current: number): { value: number; name: string }[] {
  const out: { value: number; name: string }[] = COLORS.map(c => ({ value: c.value, name: t(`roles.color.${c.key}` as StringKey) }));
  if (current !== 0 && !COLORS.some(c => c.value === current)) out.push({ value: current, name: t('roles.color.custom') });
  return out;
}
