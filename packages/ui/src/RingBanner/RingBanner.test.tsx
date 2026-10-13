import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { RingBanner, type RingBannerProps } from './RingBanner.tsx';
import meta from './RingBanner.stories.tsx';

const ringLabels: RingBannerProps['labels'] = { region: 'incoming calls', answer: 'answer', decline: 'decline' };

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('RingBanner', () => {
  it('RingBanner announces through an alert and never takes focus', () => {
    const before = document.activeElement;
    render(<RingBanner rings={[{ callId: 'c', text: 'bob is calling', busy: false }]} labels={ringLabels} onAnswer={() => {}} onDecline={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('bob is calling');
    expect(document.activeElement).toBe(before);
    expect(screen.getByRole('button', { name: 'answer' })).toBeInTheDocument();
  });

  it('is a region of one alert per ring; its buttons answer or decline that ring and are described by its text', async () => {
    const onAnswer = vi.fn();
    const onDecline = vi.fn();
    render(<RingBanner rings={[{ callId: 'a', text: 'ada is calling', busy: false },
      { callId: 'b', text: 'bo is calling. Answering leaves harbour.', busy: true }]}
    labels={ringLabels} onAnswer={onAnswer} onDecline={onDecline} />);
    const region = screen.getByRole('region', { name: 'incoming calls' });
    expect(within(region).getAllByRole('alert')).toHaveLength(2);
    const answers = within(region).getAllByRole('button', { name: 'answer' });
    expect(answers[1]).toHaveAccessibleDescription('bo is calling. Answering leaves harbour.');
    await userEvent.click(answers[1]);
    await userEvent.click(within(region).getAllByRole('button', { name: 'decline' })[0]);
    expect(onAnswer).toHaveBeenCalledWith('b');
    expect(onDecline).toHaveBeenCalledWith('a');
    expect(region.querySelector('[data-ring="busy"]')).not.toBeNull();
  });

  it('keeps an alert node across rerenders, so it is announced once, and renders nothing without rings', () => {
    const ring = { callId: 'c', text: 'bob is calling', busy: false };
    const { rerender, container } = render(<RingBanner rings={[ring]} labels={ringLabels} onAnswer={() => {}} onDecline={() => {}} />);
    const alert = screen.getByRole('alert');
    rerender(<RingBanner rings={[{ ...ring }, { callId: 'd', text: 'cy is calling', busy: false }]} labels={ringLabels} onAnswer={() => {}} onDecline={() => {}} />);
    expect(screen.getAllByRole('alert')[0]).toBe(alert);
    rerender(<RingBanner rings={[]} labels={ringLabels} onAnswer={() => {}} onDecline={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['mesh', 'light', 'high-contrast'])('passes axe at its default story args in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><RingBanner {...(meta.args as RingBannerProps)} /></div>);
    // jsdom has no layout or canvas, so contrast is left to the Storybook axe run in a real browser.
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
