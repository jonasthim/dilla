import type { Meta, StoryObj } from '@storybook/react-vite';
import { KeyHint } from './KeyHint.tsx';
const meta = { title: 'Primitives/KeyHint', component: KeyHint } satisfies Meta<typeof KeyHint>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Palette: Story = { args: { keys: ['⌘', 'K'], label: 'cmd' } };
export const Search: Story = { args: { keys: ['/'], label: 'search' } };
export const Help: Story = { args: { keys: ['?'], label: 'help' } };
