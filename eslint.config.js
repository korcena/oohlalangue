'use strict';

const js = require('@eslint/js');

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  indexedDB: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  SpeechSynthesisUtterance: 'readonly',
  URL: 'readonly',
  Blob: 'readonly',
  globalThis: 'readonly',
  performance: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  HTMLElement: 'readonly'
};

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  URL: 'readonly',
  globalThis: 'readonly',
  fetch: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly'
};

// The sanitize regexes are ported verbatim from the original app; their
// deliberate control-character class and escaped brackets are intentional
// and must not be "cleaned up". Keep them out of lint churn.
const portedRegexRules = {
  'no-control-regex': 'off',
  'no-useless-escape': 'off'
};

module.exports = [
  {
    ignores: ['node_modules/**', 'public/styles.css']
  },
  js.configs.recommended,
  {
    // Browser ESM
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserGlobals
    },
    rules: Object.assign(
      {
        'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
      },
      portedRegexRules
    )
  },
  {
    // Node CommonJS: server + tests + config
    files: ['server.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    rules: Object.assign(
      {
        'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
      },
      portedRegexRules
    )
  }
];
