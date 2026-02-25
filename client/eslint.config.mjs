// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // ── Global ignores ───────────────────────────────
  {
    ignores: ['dist/', 'node_modules/', '*.config.*'],
  },

  // ── Base: ESLint recommended ─────────────────────
  eslint.configs.recommended,

  // ── TypeScript recommended ───────────────────────
  ...tseslint.configs.recommended,

  // ── React Hooks ──────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // v7 new rules — warn for gradual migration
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },

  // ── Project-wide overrides ───────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Allow explicit any sparingly — warn instead of error
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ── Core Layer Constraints ───────────────────────
  // whiteboard-architecture-spec v1.4 §3 / CORE_RULES.md
  //
  //   1. React 依存禁止
  //   2. Yjs 依存禁止
  //   3. ブラウザ API 使用禁止 (no-restricted-globals)
  //   4. __tests__/ 配下は制約対象外
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'Core layer must not depend on React (CORE_RULES #1).' },
            { name: 'react-dom', message: 'Core layer must not depend on React (CORE_RULES #1).' },
            { name: 'react/jsx-runtime', message: 'Core layer must not depend on React (CORE_RULES #1).' },
            { name: 'yjs', message: 'Core layer must not depend on Yjs (CORE_RULES #2).' },
          ],
          patterns: [
            { group: ['y-*'], message: 'Core layer must not depend on Yjs ecosystem (CORE_RULES #2).' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'Core layer must not use browser APIs (CORE_RULES #3).' },
        { name: 'window', message: 'Core layer must not use browser APIs (CORE_RULES #3).' },
        { name: 'localStorage', message: 'Core layer must not use browser APIs (CORE_RULES #3).' },
        { name: 'sessionStorage', message: 'Core layer must not use browser APIs (CORE_RULES #3).' },
        { name: 'navigator', message: 'Core layer must not use browser APIs (CORE_RULES #3).' },
        { name: 'fetch', message: 'Core layer must not use browser APIs (CORE_RULES #3).' },
        { name: 'setTimeout', message: 'Core layer must not use timers (CORE_RULES #4).' },
        { name: 'setInterval', message: 'Core layer must not use timers (CORE_RULES #4).' },
        { name: 'requestAnimationFrame', message: 'Core layer must not use browser APIs (CORE_RULES #4).' },
      ],
    },
  },

  // ── Test files: relax some rules ─────────────────
  {
    files: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
