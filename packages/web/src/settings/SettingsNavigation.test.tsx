import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsNavigation } from './SettingsNavigation.tsx';

describe('settings navigation search', () => {
  it('opens a named setting with Enter and consumes Escape before the frame', () => {
    const select = vi.fn(); const escape = vi.fn();
    render(<dialog open onKeyDown={escape}><SettingsNavigation scope="user" activeId="profile" onSelect={select} /></dialog>);
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'display name' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(select).toHaveBeenCalledWith('profile', 'profile-display');
    fireEvent.change(search, { target: { value: 'password' } });
    escape.mockClear();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue(''); expect(escape).not.toHaveBeenCalled();
  });
  it('removes restricted results on permission loss', () => {
    const select = vi.fn();
    const view = render(<SettingsNavigation scope="server" access={{ loaded: true, manageCommunity: true }} activeId="music" onSelect={select} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'spotify' } });
    expect(screen.getAllByRole('button', { name: /Music/ })).toHaveLength(2);
    view.rerender(<SettingsNavigation scope="server" access={{ loaded: true }} activeId="members" onSelect={select} />);
    expect(screen.queryByRole('button', { name: /Music/ })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('No matching settings');
  });
});
