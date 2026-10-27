import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { t } from '../strings/index.ts';

/**
 * Ruling X (Jonas 2026-10-27, pixel parity): the channel header has no "⋯"; a text channel's pins and edit channel are in its
 * row's context menu. This right-clicks the row in the server's channel list and returns the menu.
 */
export async function openRowMenu(user: UserEvent, channel: string): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: t('shell.channels.label') });
  await user.pointer({ keys: '[MouseRight]', target: within(nav).getByRole('button', { name: channel }) });
  return screen.getByRole('menu', { name: t('nav.channel.menu') });
}

/** Opens the row's context menu and picks one item by its visible label. */
export async function rowMenuItem(user: UserEvent, channel: string, label: string): Promise<void> {
  const menu = await openRowMenu(user, channel);
  await user.click(within(menu).getByRole('menuitem', { name: label }));
}
