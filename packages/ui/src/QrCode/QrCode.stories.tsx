import type { Meta, StoryObj } from '@storybook/react-vite';
import { QrCode } from './QrCode.tsx';

const URI = 'otpauth://totp/Dilla:ada@dilla.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Dilla&algorithm=SHA1&digits=6&period=30';

const meta = {
  title: 'Ceremony/QrCode', component: QrCode,
  args: { value: URI, label: 'QR code for the authenticator app' },
} satisfies Meta<typeof QrCode>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Size192: Story = { args: { size: 192 } };
export const Size160: Story = { args: { size: 160 } };
