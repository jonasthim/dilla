// ESLint 9 flat config for the TypeScript packages of the web wave (ruling C10).
// CommonJS on purpose: the root package.json has no "type", and a CommonJS file needs no
// module-syntax detection. Scope: packages/client-core and packages/web only.
const tseslint = require('typescript-eslint');
const jsxA11y = require('eslint-plugin-jsx-a11y');
const reactHooks = require('eslint-plugin-react-hooks');

const TS = ['packages/client-core/**/*.{ts,tsx}', 'packages/web/**/*.{ts,tsx}'];
const SRC = ['packages/client-core/src/**/*.{ts,tsx}', 'packages/web/src/**/*.{ts,tsx}'];
const WEB = ['packages/web/**/*.{ts,tsx}'];
const STORAGE = 'Keys, tokens and state never go to Web Storage (plan web-1, Global Constraints).';
const HTML = 'No HTML strings: render through React (plan web-1, Global Constraints).';

module.exports = [
  { ignores: ['**/node_modules/**', 'packages/web/dist/**', 'packages/client-core/harness-dist/**'] },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: TS })),
  // Type information comes from an explicit project list. The project service resolves a file
  // through the nearest file named tsconfig.json only, so it would never read tsconfig.worker.json,
  // and tsconfig.json excludes src/worker (DOM and WebWorker libs cannot share one program). Every
  // linted file must be in the include of one of these tsconfigs.
  {
    files: ['packages/client-core/**/*.{ts,tsx}'],
    languageOptions: { parserOptions: {
      project: ['./packages/client-core/tsconfig.json', './packages/client-core/tsconfig.worker.json'],
      tsconfigRootDir: __dirname } },
  },
  {
    files: WEB,
    languageOptions: { parserOptions: { project: ['./packages/web/tsconfig.json'], tsconfigRootDir: __dirname } },
  },
  {
    files: TS,
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      'no-restricted-globals': ['error',
        { name: 'localStorage', message: STORAGE },
        { name: 'sessionStorage', message: STORAGE }],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'localStorage', message: STORAGE },
        { object: 'window', property: 'sessionStorage', message: STORAGE },
        { object: 'self', property: 'localStorage', message: STORAGE },
        { object: 'self', property: 'sessionStorage', message: STORAGE },
        { object: 'globalThis', property: 'localStorage', message: STORAGE },
        { object: 'globalThis', property: 'sessionStorage', message: STORAGE }],
      'no-restricted-syntax': ['error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: HTML },
        { selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]", message: HTML },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: HTML }],
    },
  },
  { files: SRC, ignores: ['**/*.test.ts', '**/*.test.tsx'], rules: { 'no-console': 'error' } },
  { ...jsxA11y.flatConfigs.recommended, files: WEB },
  {
    files: WEB,
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
];
