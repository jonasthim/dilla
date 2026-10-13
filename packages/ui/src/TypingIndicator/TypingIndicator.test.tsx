import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { expectNoAxeViolations } from '../test/setup.ts';
import { TypingIndicator } from './TypingIndicator.tsx';

it('deduplicates a person and uses one polite status', async () => {
  const labels = { one: '{name} is typing', many: 'Several people are typing' };
  const view = render(<TypingIndicator names={['Ada', 'Ada']} labels={labels} />);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('Ada is typing');
  view.rerender(<TypingIndicator names={['Ada', 'Mira']} labels={labels} />);
  expect(screen.getByRole('status')).toHaveTextContent(labels.many);
  view.rerender(<TypingIndicator names={[]} labels={labels} />);
  expect(screen.queryByRole('status')).toBeNull();
  await expectNoAxeViolations(view.container);
});
