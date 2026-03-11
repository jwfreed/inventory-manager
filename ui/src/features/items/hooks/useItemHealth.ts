import { useMemo } from 'react'
import type { Item } from '../../../api/types'
import { evaluateItemHealth } from '../itemDetail.logic'
import type { InventorySummary, ItemConfiguration, ItemHealthResult } from '../itemDetail.models'
import { ItemHealthStatus } from '../itemDetail.models'

type Params = {
  item?: Item | null
  inventory: InventorySummary
  configuration: ItemConfiguration
}

export function useItemHealth({ item, inventory, configuration }: Params) {
  return useMemo<ItemHealthResult>(() => {
    if (!item) {
      return {
        status: ItemHealthStatus.CONFIGURATION_REQUIRED,
        reasons: ['Item data unavailable.'],
        actions: [],
      }
    }
    return evaluateItemHealth(item, inventory, configuration)
  }, [configuration, inventory, item])
}
