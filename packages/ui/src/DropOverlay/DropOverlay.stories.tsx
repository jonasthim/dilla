import type { CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DropOverlay } from './DropOverlay.tsx';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9). The overlay covers its positioned parent.
// The story box sets --duration-fast to 0ms (the reduced-motion value), so the review screenshot, taken as soon as
// the story mounts, shows the settled overlay rather than the first frames of its 150 ms fade-in.
const BOX = { position: 'relative', width: 720, height: 360, '--duration-fast': '0ms' } as CSSProperties;
const meta = {
  title: 'Conversation/DropOverlay', component: DropOverlay,
  args: { active: true, title: 'Drop to attach', body: 'Up to 4 files, 25 MB each.' },
  decorators: [Story => <div style={BOX}><Story /></div>],
} satisfies Meta<typeof DropOverlay>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
