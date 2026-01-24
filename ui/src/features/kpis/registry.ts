export type KpiDimension = 'SERVICE' | 'COST' | 'RISK' | 'FLOW' | 'OTHER'

export type KpiDefinition = {
  name: string
  displayName: string
  description: string
  dimension: KpiDimension
}

export const KPI_REGISTRY: KpiDefinition[] = [
  {
    name: 'fill_rate',
    displayName: 'Fill rate',
    description: 'Share of ordered quantity shipped within the window.',
    dimension: 'SERVICE',
  },
  {
    name: 'service_level',
    displayName: 'Service level',
    description: 'Share of demand met without delay.',
    dimension: 'SERVICE',
  },
  {
    name: 'otif',
    displayName: 'OTIF',
    description: 'On-time, in-full delivery performance.',
    dimension: 'SERVICE',
  },
  {
    name: 'turns',
    displayName: 'Inventory turns',
    description: 'Annualized usage relative to average on-hand.',
    dimension: 'COST',
  },
  {
    name: 'inventory_value',
    displayName: 'Inventory value',
    description: 'Total inventory value on hand.',
    dimension: 'COST',
  },
  {
    name: 'carrying_cost',
    displayName: 'Carrying cost',
    description: 'Estimated cost to hold inventory.',
    dimension: 'COST',
  },
  {
    name: 'abc_a_share',
    displayName: 'ABC A share',
    description: 'Share of items classified as A.',
    dimension: 'COST',
  },
  {
    name: 'abc_b_share',
    displayName: 'ABC B share',
    description: 'Share of items classified as B.',
    dimension: 'COST',
  },
  {
    name: 'abc_c_share',
    displayName: 'ABC C share',
    description: 'Share of items classified as C.',
    dimension: 'COST',
  },
  {
    name: 'stockout_rate',
    displayName: 'Stockout rate',
    description: 'Frequency of stockouts within the window.',
    dimension: 'RISK',
  },
  {
    name: 'slow_stock_share',
    displayName: 'Slow stock share',
    description: 'Share of on-hand items flagged slow moving.',
    dimension: 'RISK',
  },
  {
    name: 'dead_stock_share',
    displayName: 'Dead stock share',
    description: 'Share of on-hand items flagged as dead stock.',
    dimension: 'RISK',
  },
  {
    name: 'backorder_rate',
    displayName: 'Backorder rate',
    description: 'Share of demand pushed to backorder.',
    dimension: 'RISK',
  },
  {
    name: 'doi_days',
    displayName: 'Days of inventory',
    description: 'Average days of inventory on hand.',
    dimension: 'FLOW',
  },
  {
    name: 'throughput',
    displayName: 'Throughput',
    description: 'Units moved through the system per period.',
    dimension: 'FLOW',
  },
  {
    name: 'cycle_time',
    displayName: 'Cycle time',
    description: 'Time from release to completion.',
    dimension: 'FLOW',
  },
]

export function getKpiDefinition(name: string) {
  return KPI_REGISTRY.find((kpi) => kpi.name === name)
}
