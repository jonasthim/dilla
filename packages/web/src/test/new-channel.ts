import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

// Wave B (the prototype's sidebar head has no "+"): "new channel" is an item of the server's ⌄ menu ("server settings").
const NAME = 'new channel';

/** Opens the server menu, picks "new channel". */
export async function clickNewChannel(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'server settings' }));
  await user.click(await screen.findByRole('menuitem', { name: NAME }));
}

/** Whether the server menu offers "new channel" (it opens the menu and closes it again). */
export async function hasNewChannel(user: UserEvent): Promise<boolean> {
  await user.click(screen.getByRole('button', { name: 'server settings' }));
  await screen.findByRole('menuitem', { name: 'Server settings' });
  const has = screen.queryByRole('menuitem', { name: NAME }) !== null;
  await user.keyboard('{Escape}');
  return has;
}
