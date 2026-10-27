import type { Preview } from '@storybook/react-vite';
import '../src/styles/base.css';
import { CONVERSATION_CONTRAST_NOT } from '../scripts/prototype-contrast.ts';

// Ruling Y (task 7): colour-contrast skips the conversation's prototype-exact colours here; scripts/story-a11y.ts checks every
// other rule on them and keeps light and high-contrast strict.
const contrastSelector = `*${CONVERSATION_CONTRAST_NOT}`;

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Theme', toolbar: { title: 'Theme', items: ['signal', 'light', 'high-contrast'], dynamicTitle: true } },
    density: { description: 'Density', toolbar: { title: 'Density', items: ['compact', 'regular', 'cozy'], dynamicTitle: true } },
    motion: { description: 'Motion', toolbar: { title: 'Motion', items: ['full', 'reduced'], dynamicTitle: true } },
  },
  initialGlobals: { theme: 'signal', density: 'regular', motion: 'full', viewport: { value: 'desktop' } },
  decorators: [
    (Story, ctx) => {
      const el = document.documentElement;
      el.dataset.theme = ctx.globals.theme;
      el.dataset.density = ctx.globals.density;
      if (ctx.globals.motion === 'reduced') el.dataset.motion = 'reduced'; else delete el.dataset.motion;
      return (
        <div className="d-root" style={{ padding: 16, minHeight: 120, background: 'var(--bg)', color: 'var(--fg)' }}>
          <Story />
        </div>
      );
    },
  ],
  parameters: {
    a11y: { test: 'error', config: { rules: [{ id: 'color-contrast', selector: contrastSelector }] } },
    backgrounds: { disable: true },
    viewport: {
      options: {
        desktop: { name: 'Desktop 1280×800', styles: { width: '1280px', height: '800px' } },
        phone: { name: 'Phone 390×844', styles: { width: '390px', height: '844px' } },
      },
    },
  },
};
export default preview;
