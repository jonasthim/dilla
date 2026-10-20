import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelHeader } from './ChannelHeader.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';

// R27: pins, threads, search, edit channel and members as 32px toggles; pins and threads fold into the "⋯" menu below 36rem.
const ACTIONS = (
  <>
    <IconButton icon="pin" label="pinned messages" data-foldable="true" />
    <IconButton icon="messages-square" label="threads" data-foldable="true" />
    <IconButton icon="search" label="search" />
    <IconButton icon="square-pen" label="edit channel" />
    <IconButton icon="users" label="members" pressed />
  </>
);
const OVERFLOW = { label: 'more', items: [{ id: 'pins', label: 'pinned messages' }, { id: 'threads', label: 'threads' }], onSelect: () => {} };

const meta = { title: 'Shell/ChannelHeader', component: ChannelHeader, args: { name: 'general', actions: ACTIONS, overflow: OVERFLOW } } satisfies Meta<typeof ChannelHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Plain: Story = {};
export const WithTopic: Story = { args: { topic: 'evening plans, screenshots and the odd argument' } };
export const Readable: Story = { args: { name: 'lfg', topic: 'looking for group', readable: true } };
export const DirectMessage: Story = { args: { name: 'ada', kind: 'dm' } };
/** C3: the megaphone is its own flex item beside the name, never inside it, and shows whole. */
export const Announcement: Story = {
  args: { name: 'news', kind: 'announcement', topic: 'releases and downtime' },
  play: ({ canvasElement }) => {
    const glyph = canvasElement.querySelector<HTMLElement>('.d-channel-header__glyph');
    const name = canvasElement.querySelector<HTMLElement>('.d-channel-header__name');
    if (glyph === null || name === null) throw new Error('Announcement: no megaphone or name');
    if (glyph.parentElement !== name.parentElement || name.contains(glyph)) throw new Error('Announcement: the megaphone is not a sibling of the name');
    const g = glyph.getBoundingClientRect();
    const n = name.getBoundingClientRect();
    if (g.width < 14 || g.right > n.left + 1) throw new Error(`Announcement: the megaphone is ${String(g.width)} wide and ends at ${String(g.right)}, the name starts at ${String(n.left)}`);
  },
};
/** R27: a pressed toggle shows aria-pressed and the 2px bar under its glyph, never colour alone. */
export const PressedToggle: Story = {
  play: ({ canvasElement }) => {
    const b = canvasElement.querySelector<HTMLElement>('button[aria-label="members"]');
    if (b === null || b.getAttribute('aria-pressed') !== 'true') throw new Error('PressedToggle: members is not pressed');
    if (!getComputedStyle(b).boxShadow.includes('inset')) throw new Error('PressedToggle: no 2px bar under the pressed toggle');
  },
};

// Product walk I2: a long name never widens the page. It is cut with an ellipsis inside the header; the closing bracket
// and the caller's actions stay on screen. The walk's two names: a typed sentence (as its #slug) and 100 bytes in one word.
const LONG_SLUG = 'fika-på-fredag-och-veckans-planering';
const HUNDRED_BYTES = 'midsommar-'.repeat(10);
/** B1, R12: the header is the 48 bar, its hairline at y=48. */
function expectBar(root: HTMLElement, story: string): void {
  const header = root.querySelector<HTMLElement>('.d-channel-header');
  if (header === null) throw new Error(`${story}: no header`);
  const h = header.getBoundingClientRect().height;
  if (Math.abs(h - 48) > 0.5) throw new Error(`${story}: the header is ${String(h)} high, not 48`);
}
/** Throws unless the header fits its box, the page does not scroll sideways, and the actions and the closing bracket end inside it. */
function expectHeaderFits(root: HTMLElement, story: string): void {
  const header = root.querySelector<HTMLElement>('.d-channel-header');
  const title = root.querySelector<HTMLElement>('.d-channel-header__title');
  if (header === null || title === null) throw new Error(`${story}: no header`);
  const box = header.getBoundingClientRect();
  const last = header.lastElementChild?.getBoundingClientRect();
  const close = title.lastElementChild?.getBoundingClientRect();
  const slack = 1;
  if (header.scrollWidth > header.clientWidth + slack || document.documentElement.scrollWidth > window.innerWidth + slack
    || (last !== undefined && last.right > box.right + slack) || (close !== undefined && close.right > box.right + slack)) {
    throw new Error(`${story}: the header overflows (box ${String(box.width)}, scroll ${String(header.scrollWidth)}, ` +
      `last child ends at ${String(last?.right)}, closing bracket at ${String(close?.right)}, page ${String(document.documentElement.scrollWidth)})`);
  }
  expectBar(root, story);
}
/** C1: every visible action ends inside the header and the name keeps at least its 8rem. */
function expectNoActionOverflow(root: HTMLElement, story: string): void {
  const header = root.querySelector<HTMLElement>('.d-channel-header')!;
  const box = header.getBoundingClientRect();
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('.d-channel-header__actions button'))) {
    if (b.getClientRects().length === 0) continue;
    const r = b.getBoundingClientRect();
    if (r.left < box.left - 1 || r.right > box.right + 1) throw new Error(`${story}: "${b.getAttribute('aria-label') ?? ''}" overflows the header`);
  }
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const title = root.querySelector<HTMLElement>('.d-channel-header__title')!.getBoundingClientRect();
  if (title.width < 8 * rem - 1) throw new Error(`${story}: the title is ${String(title.width)} wide, under 8rem`);
}
/** Below 36rem the foldable actions are hidden and the "⋯" menu shows; above it, the reverse. */
function expectFold(root: HTMLElement, story: string, folded: boolean): void {
  const more = root.querySelector<HTMLElement>('.d-channel-header__more');
  if (more === null) throw new Error(`${story}: no "more" menu`);
  if ((getComputedStyle(more).display !== 'none') !== folded) throw new Error(`${story}: the "more" menu is ${folded ? 'hidden' : 'shown'}`);
  for (const f of Array.from(root.querySelectorAll<HTMLElement>('[data-foldable]'))) {
    if ((f.getClientRects().length === 0) !== folded) throw new Error(`${story}: "${f.getAttribute('aria-label') ?? ''}" is ${folded ? 'still shown' : 'hidden'}`);
  }
}

// The main pane's width: the viewport less the rail (60) and the sidebar (240), and less the aside (280) while it is open.
const inMain = (width: number) => (Story: () => React.JSX.Element) => <div style={{ width }}><Story /></div>;
export const Desktop1440: Story = {
  args: { topic: 'evening plans, screenshots and the odd argument' }, decorators: [inMain(1140)],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'Desktop1440'); expectNoActionOverflow(canvasElement, 'Desktop1440'); expectFold(canvasElement, 'Desktop1440', false); },
};
export const Desktop1440Aside: Story = {
  args: { topic: 'evening plans, screenshots and the odd argument' }, decorators: [inMain(860)],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'Desktop1440Aside'); expectNoActionOverflow(canvasElement, 'Desktop1440Aside'); expectFold(canvasElement, 'Desktop1440Aside', false); },
};
export const Desktop1024: Story = {
  args: { topic: 'evening plans, screenshots and the odd argument' }, decorators: [inMain(724)],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'Desktop1024'); expectNoActionOverflow(canvasElement, 'Desktop1024'); expectFold(canvasElement, 'Desktop1024', false); },
};
/** C1: 1024 with the aside open leaves main 444px. The name stays visible, no action overflows, and pins and threads fold into "⋯". */
export const Desktop1024Aside: Story = {
  args: { topic: 'evening plans, screenshots and the odd argument' }, decorators: [inMain(444)],
  play: ({ canvasElement }) => {
    expectHeaderFits(canvasElement, 'Desktop1024Aside');
    expectNoActionOverflow(canvasElement, 'Desktop1024Aside');
    expectFold(canvasElement, 'Desktop1024Aside', true);
    const name = canvasElement.querySelector<HTMLElement>('.d-channel-header__name')!;
    if (name.scrollWidth > name.clientWidth + 1) throw new Error('Desktop1024Aside: the name general is cut');
  },
};
/** The folded menu opens with pins and threads. */
export const FoldedMenuOpen: Story = {
  decorators: [inMain(444)],
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('.d-channel-header__more button')?.click();
  },
};

// 360 px less the 16 px gutters.
export const LongNamePhone: Story = {
  args: { name: LONG_SLUG, topic: 'say hi' },
  decorators: [inMain(328)],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'LongNamePhone'); expectNoActionOverflow(canvasElement, 'LongNamePhone'); },
};
export const HundredBytesPhone: Story = {
  args: { name: HUNDRED_BYTES },
  decorators: [inMain(328)],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'HundredBytesPhone'); expectNoActionOverflow(canvasElement, 'HundredBytesPhone'); },
};
// 1280 px less the rail (60) and the sidebar (240): the main pane's header.
export const HundredBytesWide: Story = {
  args: { name: HUNDRED_BYTES, topic: 'say hi' },
  decorators: [inMain(980)],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'HundredBytesWide'); expectNoActionOverflow(canvasElement, 'HundredBytesWide'); },
};

// At a normal desktop width a long topic is cut with its ellipsis and the header stays ONE row of 48.
const LONG_TOPIC = 'evening plans, screenshots, the weekly changelog thread, release notes and the odd argument about tabs and spaces that never ends'.repeat(2);
/** Throws unless every direct child of the header sits on one line and the header is its fixed height. */
function expectOneRow(root: HTMLElement, story: string): void {
  const header = root.querySelector<HTMLElement>('.d-channel-header');
  if (header === null) throw new Error(`${story}: no header`);
  const tops = Array.from(header.children).map(c => Math.round(c.getBoundingClientRect().top));
  const h = header.getBoundingClientRect().height;
  if (Math.max(...tops) - Math.min(...tops) > 20 || h > 52) throw new Error(`${story}: the header wraps (tops ${tops.join(', ')}, height ${String(h)})`);
}
export const LongTopicDesktop: Story = {
  args: { name: 'general', topic: LONG_TOPIC },
  decorators: [inMain(1140)],
  play: ({ canvasElement }) => { expectOneRow(canvasElement, 'LongTopicDesktop'); expectHeaderFits(canvasElement, 'LongTopicDesktop'); },
};
// Main at its 24rem floor: the foldable actions are in "⋯", the topic is gone, nothing is clipped and the header is still 48.
export const NarrowMain: Story = {
  args: { topic: 'say hi' },
  decorators: [inMain(384)],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'NarrowMain'); expectNoActionOverflow(canvasElement, 'NarrowMain'); expectFold(canvasElement, 'NarrowMain', true); },
};
