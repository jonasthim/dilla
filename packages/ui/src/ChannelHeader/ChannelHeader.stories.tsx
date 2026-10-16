import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChannelHeader } from './ChannelHeader.tsx';
import { Button } from '../Button/Button.tsx';

const meta = { title: 'Shell/ChannelHeader', component: ChannelHeader, args: { name: 'general' } } satisfies Meta<typeof ChannelHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Plain: Story = {};
export const WithTopic: Story = { args: { topic: 'evening plans, screenshots and the odd argument' } };
export const Readable: Story = { args: { name: 'lfg', topic: 'looking for group', readable: true } };
export const DirectMessage: Story = { args: { name: 'ada', kind: 'dm' } };
export const Announcement: Story = { args: { name: 'news', kind: 'announcement', topic: 'releases and downtime' } };
// web-2b (L-UI-54): the pins button, `shell.pins.open` of L-COPY-03, quoted.
export const WithPinsButton: Story = { args: { topic: 'say hi', actions: <Button variant="ghost">pinned</Button> } };

// Product walk I2: a long name never widens the page. It is cut with an ellipsis inside the header; the closing bracket
// and the caller's actions stay on screen. The walk's two names: a typed sentence (as its #slug) and 100 bytes in one word.
const LONG_SLUG = 'fika-på-fredag-och-veckans-planering';
const HUNDRED_BYTES = 'midsommar-'.repeat(10);
/** Throws unless the header fits its box, the page does not scroll sideways, and the actions and the closing bracket end inside it. */
function expectHeaderFits(root: HTMLElement, story: string): void {
  const header = root.querySelector<HTMLElement>('.d-channel-header');
  const name = root.querySelector<HTMLElement>('.d-channel-header__name');
  if (header === null || name === null) throw new Error(`${story}: no header`);
  const box = header.getBoundingClientRect();
  const last = header.lastElementChild?.getBoundingClientRect();
  const close = name.lastElementChild?.getBoundingClientRect();
  const slack = 1;
  if (header.scrollWidth > header.clientWidth + slack || document.documentElement.scrollWidth > window.innerWidth + slack
    || (last !== undefined && last.right > box.right + slack) || (close !== undefined && close.right > box.right + slack)) {
    throw new Error(`${story}: the header overflows (box ${String(box.width)}, scroll ${String(header.scrollWidth)}, ` +
      `last child ends at ${String(last?.right)}, closing bracket at ${String(close?.right)}, page ${String(document.documentElement.scrollWidth)})`);
  }
}
// 360 px less the 16 px gutters.
export const LongNamePhone: Story = {
  args: { name: LONG_SLUG, topic: 'say hi', actions: <Button variant="ghost">pinned</Button> },
  decorators: [Story => <div style={{ width: 328 }}><Story /></div>],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'LongNamePhone'); },
};
export const HundredBytesPhone: Story = {
  args: { name: HUNDRED_BYTES, actions: <Button variant="ghost">pinned</Button> },
  decorators: [Story => <div style={{ width: 328 }}><Story /></div>],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'HundredBytesPhone'); },
};
// 1280 px less the rail (60) and the sidebar (240): the main pane's header.
export const HundredBytesWide: Story = {
  args: { name: HUNDRED_BYTES, topic: 'say hi', actions: <Button variant="ghost">pinned</Button> },
  decorators: [Story => <div style={{ width: 980 }}><Story /></div>],
  play: ({ canvasElement }) => { expectHeaderFits(canvasElement, 'HundredBytesWide'); },
};
