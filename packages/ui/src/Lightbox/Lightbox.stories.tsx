import type { Meta, StoryObj } from '@storybook/react-vite';
import { Lightbox, type LightboxProps } from './Lightbox.tsx';
import { useDrawnImage } from '../internal/drawn-image.ts';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9); the previous and next labels are sentence case
// (pre-flight ruling F8).
const meta = {
  title: 'Conversation/Lightbox', component: Lightbox,
  args: { open: true, label: 'drawn.png, 48 KB', src: null, alt: 'drawn.png', closeLabel: 'Close', onClose: () => {}, saveLabel: 'Save', onSave: () => {} },
} satisfies Meta<typeof Lightbox>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The full image drawn on a canvas at story time, shown through a blob: URL revoked on unmount. */
function Drawn(props: LightboxProps) {
  const src = useDrawnImage(1280, 960);
  return <Lightbox {...props} src={src} />;
}

export const Single: Story = { render: args => <Drawn {...args} /> };
export const WithPreviousAndNext: Story = {
  args: { previous: { label: 'Previous image', onPrevious: () => {} }, next: { label: 'Next image', onNext: () => {} } },
  render: args => <Drawn {...args} />,
};
