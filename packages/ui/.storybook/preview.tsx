import type { Preview } from '@storybook/react-vite';
import '../src/styles/base.css';

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Theme', toolbar: { title: 'Theme', items: ['mesh', 'light', 'high-contrast'], dynamicTitle: true } },
    density: { description: 'Density', toolbar: { title: 'Density', items: ['compact', 'regular', 'cozy'], dynamicTitle: true } },
  },
  initialGlobals: { theme: 'mesh', density: 'regular' },
  decorators: [
    (Story, ctx) => {
      document.documentElement.dataset.theme = ctx.globals.theme;
      document.documentElement.dataset.density = ctx.globals.density;
      return <div className="d-root" style={{ padding: 16, minHeight: 120 }}><Story /></div>;
    },
  ],
  parameters: { a11y: { test: 'error' }, backgrounds: { disable: true } },
};
export default preview;
