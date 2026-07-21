'use strict';
const gts = require('gts');
const {defineConfig} = require('eslint/config');

module.exports = defineConfig([
  {
    ignores: [
      '.claude/',
      'node_modules/',
      'dist/',
      'main.js',
      // Committed bundler outputs, not sources.
      'tests/e2e_runner.js',
      'tests/component_runner.js',
      'tests/component_harness.js',
      'dumps/',
      'dumps-component/',
      'test_vault/',
      'docker-artifacts/',
      'squashfs-root/',
      'esbuild.config.mjs',
      'jest.config.js',
    ],
  },
  ...gts,
  {
    // The test harnesses drive puppeteer's page.evaluate / in-page globals,
    // which are untyped by nature, and use empty catch blocks for best-effort
    // cleanup. Keep src/ strict; relax only these rules here (the reference
    // setup disables no-explicit-any globally).
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', {allowEmptyCatch: true}],
      '@typescript-eslint/no-unused-vars': ['error', {caughtErrors: 'none'}],
    },
  },
]);
