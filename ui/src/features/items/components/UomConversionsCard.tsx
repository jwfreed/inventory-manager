import { formatNumber } from '@shared/formatters'
import { useState } from 'react'
import type { Item, UomConversion } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { EmptyState } from '../../../components/EmptyState'
import { Input } from '../../../components/Inputs'
import { useCreateUomConversion, useDeleteUomConversion } from '../api/uomConversions'

type Props = {
  item: Item
  conversions: UomConversion[]
}

export function UomConversionsCard({ item, conversions }: Props) {
  const [fromUom, setFromUom] = useState('')
  const [toUom, setToUom] = useState('')
  const [factor, setFactor] = useState(1)

  const createMutation = useCreateUomConversion()
  const deleteMutation = useDeleteUomConversion()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createMutation.mutate(
      {
        itemId: item.id,
        fromUom: fromUom.trim(),
        toUom: toUom.trim(),
        factor,
      },
      {
        onSuccess: () => {
          setFromUom('')
          setToUom('')
          setFactor(1)
        },
      },
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-sm text-slate-600">
            Conversions normalize inventory, BOMs, and costing into the item&apos;s canonical unit.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info">Canonical UOM {item.canonicalUom ?? item.defaultUom ?? '—'}</Badge>
            <Badge variant="neutral">{conversions.length} conversion{conversions.length === 1 ? '' : 's'}</Badge>
          </div>
        </div>
        {conversions.length > 0 && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Example: 1 {conversions[0].fromUom} = {formatNumber(conversions[0].factor)} {conversions[0].toUom}
          </div>
        )}
      </div>

      {createMutation.isError && (
        <Alert variant="error" title="Failed to create conversion" message={createMutation.error.message} />
      )}
      {deleteMutation.isError && (
        <Alert
          variant="error"
          title="Failed to delete conversion"
          message={deleteMutation.error.message}
        />
      )}

      <form
        onSubmit={handleSubmit}
        className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px_120px]"
      >
        <Input
          value={fromUom}
          onChange={(e) => setFromUom(e.target.value)}
          placeholder="From UOM"
          aria-label="From unit of measure"
          required
        />
        <Input
          value={toUom}
          onChange={(e) => setToUom(e.target.value)}
          placeholder="To UOM"
          aria-label="To unit of measure"
          required
        />
        <Input
          type="number"
          value={factor}
          onChange={(e) => setFactor(Number(e.target.value))}
          placeholder="Factor"
          aria-label="Conversion factor"
          required
          min="0.000000001"
          step="any"
        />
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Adding...' : 'Add'}
        </Button>
      </form>

      {conversions.length === 0 ? (
        <EmptyState
          title="No conversions configured"
          description="Add conversions when this item is transacted, costed, or planned in multiple units."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  From
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  To
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Factor
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Canonical path
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {conversions.map((conversion) => {
                const isCanonical =
                  conversion.fromUom === item.canonicalUom || conversion.toUom === item.canonicalUom

                return (
                  <tr key={conversion.id} className="align-top">
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{conversion.fromUom}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{conversion.toUom}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-700">
                      {formatNumber(conversion.factor)}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-700">
                      {isCanonical ? (
                        <Badge variant="success">Touches canonical UOM</Badge>
                      ) : (
                        <span className="text-slate-500">Indirect conversion only</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="border-rose-200 text-rose-700 hover:bg-rose-50"
                        onClick={() => deleteMutation.mutate(conversion.id)}
                        disabled={deleteMutation.isPending}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
