import { formatCurrency } from '@shared/formatters'
import type { Item } from '../../../api/types'
import { ConfigurationHealthPill, ContextRail } from './ContextRail'
import type { ItemDetailBomSummary } from '../hooks/useItemDetailPageModel'
import type { UnitConversionState } from '../itemDetail.models'

type Props = {
  item: Item
  baseCurrency: string
  bomSummary: ItemDetailBomSummary
  conversionState: UnitConversionState
  hasManufacturingFlow: boolean
  missingConversionUnits: string[]
  routingCount: number
}

export function ItemContextRail({
  item,
  baseCurrency,
  bomSummary,
  conversionState,
  hasManufacturingFlow,
  missingConversionUnits,
  routingCount,
}: Props) {
  return (
    <ContextRail
      sections={[
        {
          title: 'Entity identity',
          description: 'Stable properties for fast scanning.',
          items: [
            { label: 'Type', value: item.type },
            { label: 'Lifecycle', value: item.lifecycleStatus },
            { label: 'Default UOM', value: item.defaultUom || '—' },
            { label: 'Canonical UOM', value: item.canonicalUom || '—' },
            { label: 'Stocking UOM', value: item.stockingUom || '—' },
            {
              label: 'Default location',
              value: item.defaultLocationCode || item.defaultLocationName || '—',
            },
          ],
        },
        {
          title: 'Configuration health',
          description: 'High-signal readiness checks.',
          items: [
            {
              label: 'UOM normalization',
              value: (
                <ConfigurationHealthPill
                  label={
                    conversionState.mode === 'derived'
                      ? 'System derived'
                      : missingConversionUnits.length > 0
                        ? 'Manual required'
                        : 'Manual configured'
                  }
                  tone={missingConversionUnits.length > 0 ? 'warning' : 'success'}
                />
              ),
            },
            {
              label: 'Active BOM',
              value: (
                <ConfigurationHealthPill
                  label={bomSummary.activeBom ? 'Ready' : hasManufacturingFlow ? 'Missing' : 'Optional'}
                  tone={bomSummary.activeBom || !hasManufacturingFlow ? 'success' : 'warning'}
                />
              ),
            },
            {
              label: 'Routing',
              value: (
                <ConfigurationHealthPill
                  label={routingCount > 0 ? 'Ready' : hasManufacturingFlow ? 'Missing' : 'Optional'}
                  tone={routingCount > 0 || !hasManufacturingFlow ? 'success' : 'warning'}
                />
              ),
            },
          ],
        },
        {
          title: 'Supporting metadata',
          description: 'Secondary details kept out of the main flow.',
          items: [
            { label: 'Item ID', value: item.id },
            { label: 'ABC class', value: item.abcClass || '—' },
            {
              label: 'Standard cost',
              value:
                item.standardCost != null
                  ? formatCurrency(item.standardCost, item.standardCostCurrency ?? baseCurrency)
                  : 'Not set',
            },
            {
              label: `Base cost (${baseCurrency})`,
              value:
                item.standardCostBase != null
                  ? formatCurrency(item.standardCostBase, baseCurrency)
                  : '—',
            },
          ],
        },
      ]}
    />
  )
}
