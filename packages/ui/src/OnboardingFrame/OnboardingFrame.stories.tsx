import type { Meta, StoryObj } from '@storybook/react-vite';
import { OnboardingFrame } from './OnboardingFrame.tsx';
import { TextField } from '../TextField/TextField.tsx';
import { Banner } from '../Banner/Banner.tsx';
import { Button } from '../Button/Button.tsx';

// Every string is L-COPY-01's, with {instance} = dilla.thim.dev.
const connect = (
  <>
    <p>You need an invite from someone on dilla.thim.dev. Paste it below.</p>
    <TextField id="invite" label="Invite" value="k7qm3zrdw0pahv5cj8zem4tbs6" onChange={() => {}} hint="A code or a link, as you received it." />
  </>
);
const meta = {
  title: 'Ceremony/OnboardingFrame', component: OnboardingFrame,
  args: { title: 'Join dilla.thim.dev', stepLabel: 'Step 1 of 5', children: connect, footer: <Button variant="accent" type="submit">Continue</Button> },
} satisfies Meta<typeof OnboardingFrame>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Step: Story = {};
export const WithError: Story = {
  args: {
    title: 'What this browser keeps', stepLabel: 'Step 4 of 5',
    children: (
      <>
        <Banner tone="danger" action={{ label: 'Reload', onAction: () => {} }}>The connection dropped while creating your account. Reload the page to finish.</Banner>
        <p>This browser now holds the key of this device, in its storage for dilla.thim.dev. The key never leaves this browser.</p>
        <p>Clearing this site’s data removes the key and the messages kept here, and this browser stops being your device.</p>
        <p>This version cannot add a second browser or restore an account from the recovery key yet. For now, your account works in this browser only.</p>
        <p>A private window forgets all of this when it closes.</p>
      </>
    ),
    footer: <><Button>Back</Button><Button variant="accent" type="submit">Create account</Button></>,
  },
};
export const Narrow: Story = { decorators: [Story => <div style={{ width: 360 }}><Story /></div>] };
