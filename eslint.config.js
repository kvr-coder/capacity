import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        ResizeObserver: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        FileReader: 'readonly',
        HTMLElement: 'readonly',
        SVGSVGElement: 'readonly',
        Intl: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The contract forbids these outright — they are how strict mode gets defeated.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The model layer must stay portable: no React, no DOM.
    files: ['src/domain/**/*.ts'],
    ignores: ['src/domain/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/domain must stay pure — no DOM.' },
        { name: 'document', message: 'src/domain must stay pure — no DOM.' },
        { name: 'localStorage', message: 'src/domain must stay pure — no DOM.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'src/domain must be deterministic — no Math.random().',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'src/domain must be deterministic — pass Month values in.',
        },
      ],
    },
  },
)
