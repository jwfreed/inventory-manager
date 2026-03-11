import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    files: [
      'src/features/ledger/pages/MovementDetailPage.tsx',
      'src/features/workOrders/pages/WorkOrderDetailPage.tsx',
      'src/features/reports/pages/WorkOrderProgressPage.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@shared/ui',
              importNames: ['Card', 'Section'],
              message: 'Use EntityPageLayout, Panel, DataTable, and SectionNav on migrated operational pages.',
            },
            {
              name: '../../../components/Card',
              message: 'Use Panel instead of Card on migrated operational pages.',
            },
            {
              name: '../../../components/Section',
              message: 'Use Panel and SectionNav instead of Section on migrated operational pages.',
            },
          ],
        },
      ],
    },
  },
])
