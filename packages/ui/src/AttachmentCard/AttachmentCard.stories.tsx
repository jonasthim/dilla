import type { Meta, StoryObj } from '@storybook/react-vite';
import { AttachmentCard, type AttachmentCardProps } from './AttachmentCard.tsx';
import { useDrawnImage } from '../internal/drawn-image.ts';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9).
const meta = {
  title: 'Conversation/AttachmentCard', component: AttachmentCard,
  args: {
    kind: 'image', name: 'drawn.png', size: '48 KB', thumbUrl: null, w: 640, h: 480, openLabel: 'open drawn.png', onOpen: () => {},
    saveLabel: 'save drawn.png', state: 'idle', tabbable: true,
  },
  decorators: [Story => <div style={{ maxWidth: 720 }}><Story /></div>],
} satisfies Meta<typeof AttachmentCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The thumbnail drawn on a canvas at story time, shown through a blob: URL revoked on unmount. */
function Drawn(props: AttachmentCardProps) {
  const thumbUrl = useDrawnImage(320, 240);
  return <AttachmentCard {...props} thumbUrl={thumbUrl} />;
}

export const ImageLoading: Story = { args: { state: 'loading', stateText: 'opening…' } };
export const ImageReady: Story = { args: { w: 320, h: 240 }, render: args => <Drawn {...args} /> };
export const ImageFailed: Story = { args: { state: 'failed', stateText: 'could not open (E_BLOB_OPEN)' } };
export const ImageTooLarge: Story = {
  args: { name: 'harbour-panorama.png', size: '31.5 MB', w: 8000, h: 2000, state: 'too-large', stateText: 'too large to open in a browser' },
};
export const File: Story = {
  args: { kind: 'file', name: 'route.gpx', size: '12.4 KB', w: null, h: null, openLabel: 'open route.gpx', onOpen: undefined,
    saveLabel: 'save route.gpx', onSave: () => {} },
};
export const FileTooLarge: Story = {
  args: { kind: 'file', name: 'harbour-video.mov', size: '31.5 MB', w: null, h: null, openLabel: 'open harbour-video.mov', onOpen: undefined,
    saveLabel: 'save harbour-video.mov', onSave: () => {}, state: 'too-large', stateText: 'too large to open in a browser' },
};
