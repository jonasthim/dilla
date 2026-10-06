import type { Meta, StoryObj } from '@storybook/react-vite';
import { t } from '../../../web/src/strings/index.ts';
import { Splash } from './Splash.tsx';

const meta = { title: 'Ceremony/Splash', component: Splash, args: { status: t('boot.loading.status') } } satisfies Meta<typeof Splash>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = {};
export const Unsupported: Story = { args: { status: t('boot.unsupported.status'), detail: t('boot.unsupported.detail') } };
export const OtherTab: Story = { args: { status: t('boot.otherTab.status'), detail: t('boot.otherTab.detail') } };
export const StoreLost: Story = { args: { status: t('boot.storeLost.status'), detail: t('boot.storeLost.detail'), action: { label: t('boot.storeLost.action'), onAction: () => {} } } };
export const Revoked: Story = { args: { status: t('boot.revoked.status'), detail: t('boot.revoked.detail') } };
export const Failed: Story = { args: { status: t('boot.error.status'), detail: t('boot.error.detail', { code: 'E_UNAVAILABLE' }), action: { label: t('boot.error.action'), onAction: () => {} } } };
