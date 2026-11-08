// ESLint flat config. Kept as plain JavaScript (not TypeScript): ESLint would
// need an extra loader (jiti) to read a TS config, and this file has nothing to
// gain from types.
import nodePlugin from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

// Node.js globals. The backend is ESM, so there are no CommonJS globals
// (require/module/exports/__dirname) to declare any more, and node:test's
// describe/it/hooks are imported by each test file rather than injected.
const globals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
};

export default [
  // Ignore build output: dist/ is the frontend build, build/ the bundled
  // backend (scripts/build.ts), and both are minified.
  {
    ignores: ['dist/', 'build/', 'node_modules/', 'test_data_root/', 'test/*.sqlite3'],
  },
  // Main configuration
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals,
    },
    plugins: {
      n: nodePlugin,
    },
    rules: {
      // eslint:recommended base rules
      'no-prototype-builtins': 'off',
      'no-process-exit': 'off',
      'semi': 'error',
      // eslint-plugin-n recommended rules
      ...nodePlugin.configs['flat/recommended'].rules,
      // Overrides after spread
      'n/no-process-exit': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
      'n/no-unsupported-features/es-syntax': 'off',
      // Rules that assume CommonJS or Node's own resolver. The sources are
      // ESM TypeScript: imports carry a `.ts` extension and every package here
      // is a declared dependency of this workspace, so these only misfire.
      'n/no-missing-import': 'off',
      'n/no-missing-require': 'off',
      'n/no-extraneous-import': 'off',
      'n/no-extraneous-require': 'off',
      'n/no-unpublished-require': 'off',
    },
  },
  // The config file itself is the only CommonJS-free plain JS left.
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
];
