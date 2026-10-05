import type { Meta, StoryObj } from '@storybook/react-vite';
import { Splash } from './Splash.tsx';

const meta = { title: 'Ceremony/Splash', component: Splash, args: { status: 'starting' } } satisfies Meta<typeof Splash>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = {};
export const Unsupported: Story = { args: { status: 'This browser cannot run dilla', detail: 'It does not offer the lasting storage dilla needs. Private windows never do: open dilla in a normal window of a current Firefox, Chrome or Safari.' } };
export const OtherTab: Story = { args: { status: 'dilla is open in another tab', detail: 'Close it, or switch to it. This tab takes over when the other one closes.' } };
export const StoreLost: Story = { args: { status: 'This browser lost the data for this device', detail: 'Without it this browser cannot sign in as this device again.', action: { label: 'start over', onAction: () => {} } } };
export const Revoked: Story = { args: { status: 'This device was signed out', detail: 'Your account no longer accepts this browser. Ask the host if you did not expect this. To start over here, clear this site’s data in the browser’s settings.' } };
export const Failed: Story = { args: { status: 'Could not start', detail: 'E_UNAVAILABLE', action: { label: 'try again', onAction: () => {} } } };
