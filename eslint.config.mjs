import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: [
      '**/dist',
      '.github/copilot-instructions.md',
    ],
  },
  {
    rules: {
      'node/prefer-global/process': 'off',
      'no-console': ['error', { allow: ['warn', 'error', 'log', 'info'] }],
      'ts/ban-ts-comment': 'warn', // Downgrade to warning
    },
  },
  {
    files: ['**/*.md'],
    rules: {
      'no-console': 'off', // Allow console.log in markdown files
      'jsdoc/require-jsdoc': 'off', // Disable JSDoc requirement in markdown files
      'unused-imports/no-unused-vars': 'off', // Disable unused imports in markdown files
      'jsdoc/require-returns-check': 'off', // Disable JSDoc require returns check in markdown files
    },
  },
)
