// ESLint flat config. Kept as plain JavaScript (not TypeScript): ESLint would
// need an extra loader (jiti) to read a TS config, and this file has nothing to
// gain from types.
import nodePlugin from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

// Node.js + Mocha globals. The backend is ESM, so there are no CommonJS
// globals (require/module/exports/__dirname) to declare any more.
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
  describe: 'readonly',
  it: 'readonly',
  before: 'readonly',
  after: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
};

export default [
  // Ignore dist directory
  {
    ignores: ['dist/', 'node_modules/', 'test_data_root/', 'test/*.sqlite3'],
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
