import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { PersonContextMenu } from './PersonContextMenu.tsx';
import { tileMenu } from '../CallStage/stage.fixture.tsx';

const base = { open: true, at: { x: 10, y: 10 }, onOpenChange: () => {}, returnFocus: () => null };
const names = () => [...document.querySelectorAll('[role^="menuitem"]')].map(i => i.textContent);

describe('PersonContextMenu (fix round 1)', () => {
  it('shows who, where, the volume, Profile, Message, Mute for me and Copy username; the range leads the arrow order', () => {
    render(<PersonContextMenu {...tileMenu('Ole')} {...base} />);
    expect(screen.getByText('Ole')).toBeInTheDocument();
    expect(screen.getByText('in harbour')).toBeInTheDocument();
    const range = screen.getByRole('slider', { name: 'User volume' });
    expect(range).toHaveFocus();
    expect(names()).toEqual(['Profile', 'Message', 'Mute for me', 'Copy username']);
    for (const wave of ['Server mute', 'Disconnect', 'Move to']) expect(screen.queryByText(wave)).toBeNull();
    fireEvent.keyDown(range, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus();
  });

  it('Mention and Edit roles are there when the caller gives them, in the prototype\'s order', () => {
    render(<PersonContextMenu {...tileMenu('Ole', { mention: true, roles: true })} {...base} />);
    expect(names()).toEqual(['Profile', 'Message', 'Mention', 'Mute for me', 'Copy username', 'Edit roles']);
  });

  it('a bot keeps Mute for me and Copy username only', () => {
    render(<PersonContextMenu {...tileMenu('Glenn', { bot: true })} {...base} />);
    expect(names()).toEqual(['Mute for me', 'Copy username']);
  });

  it('Mute for me is an on/off item that keeps the menu open; Copy username closes it', () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(<PersonContextMenu {...tileMenu('Ole', { muted: true })} {...base} onSelect={onSelect} onOpenChange={onOpenChange} />);
    const mute = screen.getByRole('menuitemcheckbox', { name: 'Mute for me' });
    expect(mute).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(mute);
    expect(onSelect).toHaveBeenLastCalledWith('mute');
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy username' }));
    expect(onSelect).toHaveBeenLastCalledWith('copy');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('yourself: no volume, no Mute for me and no Copy username; Mute and Deafen carry their keys, Leave voice is the danger item', () => {
    render(<PersonContextMenu {...tileMenu('Mira', { own: true, title: 'Mira (you)' })} {...base} />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(names()).toEqual(['MuteCtrl+Shift+M', 'DeafenCtrl+Shift+D', 'Profile', 'lounge2', 'raid0', 'Leave voice']);
    expect(screen.getByRole('menuitem', { name: 'Leave voice' })).toHaveAttribute('data-danger', 'true');
  });

  it('Move to: a labelled group of rooms with the head count, after Profile and before Leave voice; one choice moves and closes', () => {
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    const menu = tileMenu('Mira', { own: true, title: 'Mira (you)' });
    render(<PersonContextMenu {...menu} move={{ ...menu.move!, onMove }} {...base} onSelect={onSelect} onOpenChange={onOpenChange} />);
    const group = screen.getByRole('group', { name: 'Move to' });
    expect(within(group).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['lounge2', 'raid0']);
    expect(document.querySelector('.d-action-menu__heading')?.textContent).toBe('Move to');
    fireEvent.click(within(group).getByRole('menuitem', { name: /^lounge/ }));
    expect(onMove).toHaveBeenCalledWith('lounge');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('with no other voice channel, Move to is not drawn and Leave voice keeps its rule above it', () => {
    const menu = tileMenu('Mira', { own: true });
    render(<PersonContextMenu {...menu} move={{ label: 'Move to', rooms: [], onMove: () => {} }} {...base} />);
    expect(screen.queryByText('Move to')).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Leave voice' }).previousElementSibling).toHaveAttribute('role', 'separator');
  });

  it('passes axe', async () => {
    const { baseElement } = render(<PersonContextMenu {...tileMenu('Ole', { mention: true, roles: true })} {...base} />);
    expect((await axe(baseElement, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
  });

  it('passes axe on your own menu', async () => {
    const { baseElement } = render(<PersonContextMenu {...tileMenu('Mira', { own: true })} {...base} />);
    expect((await axe(baseElement, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
  });
});
