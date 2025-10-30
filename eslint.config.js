// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/data/**', '**/coverage/**'],
  },
  eslint.configs.recommended,
  {
    extends: [...tseslint.configs.recommended],
    files: ['**/*.ts', '**/*.mts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.json',
      },
    },
  },
);
