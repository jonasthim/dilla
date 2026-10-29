import type { StorybookConfig } from '@storybook/react-vite';
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  // Task 11 (rule 3d): whole-screen stories render the web's own screens, which reach @dilla/client-core and its worker module;
  // a code-split build needs the worker as an ES module (the web app's own Vite config does the same).
  viteFinal: config => ({ ...config, worker: { ...config.worker, format: 'es' } }),
};
export default config;
