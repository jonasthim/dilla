import type { Meta, StoryObj } from '@storybook/react-vite';
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx';
const labels = { title: 'Diagnostics', copy: 'Copy codes' };
const data = { connection: 'online', generation: '4', instance: 'home', devices: 2, errors: Array.from({ length: 21 }, (_, at) => ({ code: `E_${at}`, at })) };
const meta: Meta<typeof DiagnosticsPanel> = { title: 'Settings/DiagnosticsPanel', component: DiagnosticsPanel };
export default meta;
type Story = StoryObj<typeof DiagnosticsPanel>;
export const Empty: Story = { args: { data: { ...data, errors: [] }, labels, onCopy: () => {} } };
export const Codes: Story = { args: { data, labels, onCopy: () => {} } };
