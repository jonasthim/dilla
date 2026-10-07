import type { Meta, StoryObj } from '@storybook/react-vite';
import { MentionList } from './MentionList.tsx';

// Every string is L-COPY-03's, quoted (en.ts gains them in task 9); `@everyone` is a protocol token shown verbatim
// (flow 04 § Copy). No `@here` option: the client has no presence (ruling 29 as amended).
const MEMBERS = [
  { id: 'mention-mira', primary: 'mira', secondary: '@mira' },
  { id: 'mention-mike', primary: 'Mike Dahl', secondary: '@mike' },
];

const meta = {
  title: 'Conversation/MentionList', component: MentionList,
  args: { id: 'mentions', label: 'people to mention', options: MEMBERS, activeId: 'mention-mira', onPick: () => {} },
  decorators: [Story => <div style={{ maxWidth: 360 }}><Story /></div>],
} satisfies Meta<typeof MentionList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Members: Story = {};
export const WithBroadcast: Story = {
  args: { options: [...MEMBERS, { id: 'mention-everyone', primary: '@everyone', secondary: 'everyone in this channel' }] },
};
