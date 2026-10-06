import type { Meta, StoryObj } from '@storybook/react-vite';
import { Dialog } from './Dialog.tsx';
import { Button } from '../Button/Button.tsx';
const meta = { title: 'Chrome/Dialog', component: Dialog, args: { open: true, title: 'Leave voice?', onClose: () => {} } } satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Confirm: Story = { args: { children: <p>You can rejoin longhouse any time.</p>, footer: <Button variant="danger" keyHint="↵">Leave</Button> } };
export const Info: Story = { args: { title: 'Compare the code', children: <p>Read the six digits aloud. They must match on every screen.</p> } };
export const CloseLabel: Story = { args: { title: 'Compare the code', closeLabel: 'Done', children: <p>Read the six digits aloud. They must match on every screen.</p> } };
