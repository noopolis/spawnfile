import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { generatedFilePatterns } from './paths.js';
import { structurePlugin } from './plugin.js';

// Consumed only by training's Vitest gate, never by Spawnfile-wide linting.
export const trainingLintConfig = tseslint.config(
  { ignores: generatedFilePatterns },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    plugins: { structure: structurePlugin },
    rules: {
      'max-lines': ['error', { max: 600, skipBlankLines: false, skipComments: false }],
      'structure/line-target': 'warn',
      'structure/directory-structure': 'error',
      'structure/module-boundaries': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', {
        selector: 'ExportDefaultDeclaration', message: 'Use named exports in product modules.',
      }],
    },
  },
  { files: ['**/*.config.ts'], rules: { 'no-restricted-syntax': 'off' } },
);
