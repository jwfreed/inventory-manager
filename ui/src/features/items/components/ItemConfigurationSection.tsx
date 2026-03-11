import type { RefObject } from 'react'
import type { Item, UomConversion } from '../../../api/types'
import { ConfigurationPanels } from './ConfigurationPanels'
import { ConversionPanel } from './ConversionPanel'
import { ItemEditPanel } from './ItemEditPanel'
import type { UnitConversionState } from '../itemDetail.models'

type Props = {
  item: Item
  conversionState: UnitConversionState
  manualConversions: UomConversion[]
  showEdit: boolean
  editFormRef: RefObject<HTMLDivElement | null>
  onSaved: () => void
}

export function ItemConfigurationSection({
  item,
  conversionState,
  manualConversions,
  showEdit,
  editFormRef,
  onSaved,
}: Props) {
  return (
    <section id="configuration" className="space-y-4 scroll-mt-24">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Configuration</h2>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          Unit conversions and master-data editing stay isolated from inventory and production read paths.
        </p>
      </div>
      <ConfigurationPanels>
        <ConversionPanel
          item={item}
          conversionState={conversionState}
          manualConversions={manualConversions}
        />
        {showEdit ? (
          <div ref={editFormRef}>
            <ItemEditPanel item={item} onSaved={onSaved} />
          </div>
        ) : null}
      </ConfigurationPanels>
    </section>
  )
}
