import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const includeRoots = [
  'src/features/items/pages',
  'src/features/ledger/pages',
  'src/features/ledger/components',
  'src/features/locations/pages',
  'src/features/workOrders/pages',
  'src/features/workOrders/components',
  'src/features/reports/pages',
]

const excludedFiles = new Set([
  'src/features/reports/pages/InventoryValuationPage.tsx',
  'src/features/reports/pages/OpenPOAgingPage.tsx',
  'src/features/reports/pages/ProductionRunFrequencyPage.tsx',
  'src/features/reports/pages/InventoryVelocityPage.tsx',
  'src/features/reports/pages/SupplierPerformancePage.tsx',
  'src/features/reports/pages/ReceiptCostAnalysisPage.tsx',
  'src/features/reports/pages/CostVariancePage.tsx',
  'src/features/reports/pages/SalesOrderFillPage.tsx',
  'src/features/reports/pages/MovementTransactionsPage.tsx',
  'src/features/workOrders/pages/ProductionOverviewPage.tsx',
  'src/features/workOrders/pages/WorkOrderCreatePage.tsx',
  'src/features/workOrders/components/LotAllocationsCard.tsx',
  'src/features/items/components/UomConversionsCard.tsx',
])

function walk(directory) {
  const absoluteDirectory = join(root, directory)
  const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const absolutePath = join(absoluteDirectory, entry.name)
    const relativePath = relative(root, absolutePath)
    if (entry.isDirectory()) {
      return walk(relativePath)
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      return [relativePath]
    }
    return []
  })
}

const files = includeRoots.flatMap((directory) => walk(directory)).filter((file) => !excludedFiles.has(file))

const rawTableOffenders = []
const statusCellOffenders = []

for (const file of files) {
  const source = readFileSync(join(root, file), 'utf8')
  if (source.includes('<table')) {
    rawTableOffenders.push(file)
  }

  const hasOperationalStatusHeader = /header:\s*['"](Status|State)['"]/.test(source)
  if (hasOperationalStatusHeader && !source.includes('StatusCell')) {
    statusCellOffenders.push(file)
  }
}

if (rawTableOffenders.length > 0 || statusCellOffenders.length > 0) {
  if (rawTableOffenders.length > 0) {
    console.error('Operational pages/components must use DataTable instead of raw <table> markup:')
    rawTableOffenders.forEach((file) => console.error(`- ${file}`))
  }
  if (statusCellOffenders.length > 0) {
    console.error('Operational status columns must use StatusCell:')
    statusCellOffenders.forEach((file) => console.error(`- ${file}`))
  }
  process.exit(1)
}

console.log('Operational UI guardrails passed.')
