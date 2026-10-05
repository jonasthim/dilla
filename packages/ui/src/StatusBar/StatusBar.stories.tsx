import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusBar, StatusChunk, Meter, BrandMark } from './StatusBar.tsx';
const meta = { title: 'Chrome/StatusBar', component: StatusBar } satisfies Meta<typeof StatusBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Top: Story = {
  args: { position: 'top', label: 'Session', children: null },
  render: args => (
    <StatusBar {...args}>
      <BrandMark />
      <StatusChunk label="server">Midgard Crew</StatusChunk>
      <StatusChunk label="node">home-1</StatusChunk>
      <StatusChunk label="state" tone="ok">ready</StatusChunk>
    </StatusBar>
  ),
};
export const Bottom: Story = {
  args: { position: 'bottom', label: 'Connection', children: null },
  render: args => (
    <StatusBar {...args}>
      <StatusChunk label="node">dilla.thim.dev</StatusChunk>
      <StatusChunk label="latency" tone="warn">210ms p50</StatusChunk>
      <StatusChunk label="sync" tone="danger">stalled</StatusChunk>
      <StatusChunk label="voice" tone="ok" onClick={() => {}}>OPUS 48kHz @ 96kbps<Meter levels={[1, 3, 5, 2, 0, 4, 6, 2, 1, 3, 2, 1]} /></StatusChunk>
      <StatusChunk label="v">0.1.0-dev</StatusChunk>
    </StatusBar>
  ),
};
