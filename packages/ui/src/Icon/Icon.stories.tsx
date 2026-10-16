import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from './Icon.tsx';
import { ICONS, type IconName } from './icons.ts';

const meta = { title: 'Primitives/Icon', component: Icon, args: { name: 'mic' } } satisfies Meta<typeof Icon>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The vendored set (Lucide, ISC), in the text colour, at 20 px and 16 px. Each name is printed as text beside it. */
export const All: Story = {
  render: () => (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem', color: 'var(--fg)', fontSize: 'var(--text-sm)' }}>
      {(Object.keys(ICONS) as IconName[]).map(name => (
        <li key={name} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Icon name={name} />
          <Icon name={name} size={16} />
          <span>{name}</span>
        </li>
      ))}
    </ul>
  ),
};
