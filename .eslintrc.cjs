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
  ignorePatterns: ['dist/', 'node_modules/']
};
