import type { Meta, StoryObj } from '@storybook/react-vite';
import { t } from '../../../web/src/strings/index.ts';
import { Splash } from './Splash.tsx';

const meta = { title: 'Screens/Boot', component: Splash } satisfies Meta<typeof Splash>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { status: t('boot.loading.status') } };
export const Unsupported: Story = { args: { status: t('boot.unsupported.status'), detail: t('boot.unsupported.detail') } };
export const OtherTab: Story = { args: { status: t('boot.otherTab.status'), detail: t('boot.otherTab.detail') } };
export const StoreLost: Story = { args: { status: t('boot.storeLost.status'), detail: t('boot.storeLost.detail'), action: { label: t('boot.storeLost.action'), onAction: () => {} } } };
export const Resetting: Story = { args: { status: t('boot.resetting.status') } };
export const Revoked: Story = { args: { status: t('boot.revoked.status'), detail: t('boot.revoked.detail'), action: { label: t('boot.revoked.action'), onAction: () => {} } } };
export const Error: Story = { args: { status: t('boot.error.status'), detail: t('boot.error.detail', { code: 'E_UNKNOWN' }), action: { label: t('boot.error.action'), onAction: () => {} } } };
