import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const files = [
  'src/features/ledger/pages/MovementDetailPage.tsx',
  'src/features/ledger/components/MovementLinesTable.tsx',
  'src/features/ledger/components/MovementsTable.tsx',
  'src/features/workOrders/pages/WorkOrderDetailPage.tsx',
  'src/features/workOrders/components/WorkOrdersTable.tsx',
  'src/features/reports/pages/WorkOrderProgressPage.tsx',
]

const root = process.cwd()
const offenders = files.filter((file) => readFileSync(join(root, file), 'utf8').includes('<table'))

if (offenders.length > 0) {
  console.error('Operational pages must use DataTable instead of raw <table> markup:')
  offenders.forEach((file) => console.error(`- ${file}`))
  process.exit(1)
}

console.log('Operational table guardrails passed.')
