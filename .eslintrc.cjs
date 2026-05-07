module.exports = {
  root: true,
  env: {
    node: true,
    es2020: true
  },
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'import'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  settings: {
    'import/resolver': {
      typescript: {
        project: './tsconfig.json'
      }
    }
  },
  rules: {
    '@typescript-eslint/ban-ts-comment': [
      'error',
      {
        'ts-expect-error': 'allow-with-description',
        'ts-ignore': 'allow-with-description',
        'ts-nocheck': true,
        'ts-check': false,
        minimumDescriptionLength: 16
      }
    ],
    'no-async-promise-executor': 'error',
    'no-empty': ['error', { allowEmptyCatch: false }],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-promise-executor-return': 'error',
    'no-unsafe-finally': 'error',
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          {
            target: './src',
            from: './src/domains/inventory/internal',
            except: ['./src/domains/inventory/**'],
            message: 'Inventory internal modules are write-owned by the Inventory domain only.'
          }
        ]
      }
    ]
  },
  overrides: [
    {
      files: [
        'scripts/check-*.ts',
        'scripts/check-*.mjs',
        'src/modules/platform/application/inventoryEventRegistry.ts',
        'src/modules/platform/application/inventoryMovementDeterminism.ts',
        'src/modules/platform/application/inventoryMutationSupport.ts',
        'src/modules/platform/application/withInventoryTransaction.ts'
      ],
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        'prefer-const': 'error'
      }
    }
  ],
  ignorePatterns: ['dist/', 'node_modules/']
};
