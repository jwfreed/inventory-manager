import type { InventorySnapshotRow } from '../../../api/types'
import { formatNumber } from '@shared/formatters'

type Lookup = Map<string, { sku?: string; name?: string }>

type Props = {
  rows: InventorySnapshotRow[]
  itemLookup?: Lookup
  locationLookup?: Lookup
  showItem?: boolean
  showLocation?: boolean
  showInventoryPosition?: boolean
}

function formatItem(row: InventorySnapshotRow, lookup?: Lookup) {
  if (!lookup) return row.itemId
  const meta = lookup.get(row.itemId)
  if (!meta) return row.itemId
  const sku = meta.sku ?? row.itemId
  const name = meta.name
  return name ? `${sku} — ${name}` : sku
}

function formatLocation(row: InventorySnapshotRow, lookup?: Lookup) {
  if (!lookup) return row.locationId
  const meta = lookup.get(row.locationId)
  if (!meta) return row.locationId
  const code = meta.code ?? row.locationId
  const name = meta.name
  return name ? `${code} — ${name}` : code
}

export function InventorySnapshotTable({
  rows,
  itemLookup,
  locationLookup,
  showItem = true,
  showLocation = true,
  showInventoryPosition = true,
}: Props) {
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        No inventory rows to display.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            {showItem ? (
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                Item
              </th>
            ) : null}
            {showLocation ? (
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                Location
              </th>
            ) : null}
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              UOM
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              On hand
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              Reserved
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              Available (on-hand − reserved)
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              Backordered
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              Held
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              Rejected
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              Non-usable
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              On order
            </th>
            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              In transit
            </th>
            {showInventoryPosition ? (
              <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                Inventory position (planning)
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {rows.map((row) => (
            <tr key={`${row.itemId}-${row.locationId}-${row.uom}-${row.isLegacy ? 'legacy' : 'canonical'}`}>
              {showItem ? (
                <td className="px-3 py-2 text-sm text-slate-800">{formatItem(row, itemLookup)}</td>
              ) : null}
              {showLocation ? (
                <td className="px-3 py-2 text-sm text-slate-800">
                  {formatLocation(row, locationLookup)}
                </td>
              ) : null}
              <td className="px-3 py-2 text-sm text-slate-800">
                {row.uom}
                {row.isLegacy ? ' (legacy)' : ''}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.onHand)}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.reserved)}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.available)}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.backordered)}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.held)}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.rejected)}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.nonUsable)}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.onOrder)}
              </td>
              <td className="px-3 py-2 text-right text-sm text-slate-800">
                {formatNumber(row.inTransit)}
              </td>
              {showInventoryPosition ? (
                <td className="px-3 py-2 text-right text-sm text-slate-800">
                  {formatNumber(row.inventoryPosition)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
