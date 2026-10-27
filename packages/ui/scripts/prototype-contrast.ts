/**
 * Ruling Y (prototype parity, Jonas 2026-10-27), task 7: the conversation's prototype-exact colours below 4.5:1 in signal.
 * `selector` is the element exactly, for scripts/story-a11y.ts, which turns colour-contrast off for it in signal only and
 * still runs every other rule on it. `simple` is a one-class selector Storybook's own a11y pass (.storybook/preview.tsx,
 * every theme) can put in a `:not()`; the runner above keeps light and high-contrast strict. No imports: Storybook bundles it.
 */
export const CONVERSATION_PROTOTYPE_CONTRAST: readonly { selector: string; simple: string; why: string }[] = [
  { selector: '.d-message-row__gutter', simple: '.d-message-row__gutter', why: 'the time gutter in #5C636E on bg (3.28:1)' },
  { selector: '.d-message-row__time', simple: '.d-message-row__time', why: 'a phone row\'s time beside the name in #636A75 (3.65:1)' },
  { selector: '.d-composer[data-empty="true"] .d-composer__send', simple: '.d-composer__send', why: 'the empty composer\'s send in #5C636E on #171B22 (2.84:1)' },
  { selector: '.d-mention-list [aria-selected="true"] .d-mention-list__secondary', simple: '.d-mention-list__secondary', why: 'the picked suggestion\'s handle in #767D89 on #171B22 (4.16:1)' },
  { selector: '.d-code-block__count', simple: '.d-code-block__count', why: 'a code block\'s line count in #636A75 on bg-3 (3.4:1)' },
  { selector: '.d-code-block [data-tok="com"]', simple: '[data-tok="com"]', why: 'a code comment in #6C737E on bg-2 (4.06:1)' },
];

/** The `:not()` chain Storybook's a11y config appends to its color-contrast selector. */
export const CONVERSATION_CONTRAST_NOT = CONVERSATION_PROTOTYPE_CONTRAST.map(e => `:not(${e.simple})`).join('');
