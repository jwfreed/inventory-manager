import { formatNumber } from '@shared/formatters'
import { useState } from 'react'
import type { Item, UomConversion } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { Input } from '../../../components/Inputs'
import { useCreateUomConversion, useDeleteUomConversion } from '../api/uomConversions'
import { formatConversionEquation } from '../itemDetail.logic'
import type { UnitConversionState } from '../itemDetail.models'
import { DataTable } from './DataTable'

type Props = {
  item: Item
  conversionState: UnitConversionState
  manualConversions: UomConversion[]
}

export function ConversionPanel({ item, conversionState, manualConversions }: Props) {
  const [fromUom, setFromUom] = useState(item.stockingUom ?? '')
  const [toUom, setToUom] = useState(item.canonicalUom ?? item.defaultUom ?? '')
  const [factor, setFactor] = useState('1')

  const createMutation = useCreateUomConversion()
  const deleteMutation = useDeleteUomConversion()

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    createMutation.mutate(
      {
        itemId: item.id,
        fromUom: fromUom.trim(),
        toUom: toUom.trim(),
        factor: Number(factor),
      },
      {
        onSuccess: () => {
          setFactor('1')
        },
      },
    )
  }

  return (
    <Card
      title="Conversion panel"
      description="System conversions are preferred when the unit registry can resolve the item's canonical unit."
      className="rounded-[24px] border-slate-200 shadow-sm shadow-slate-950/5"
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">Canonical Unit: {conversionState.canonicalUom ?? '—'}</Badge>
          <Badge variant={conversionState.mode === 'derived' ? 'success' : 'warning'}>
            {conversionState.mode === 'derived' ? 'Derived conversions' : 'Manual conversions required'}
          </Badge>
        </div>

        {conversionState.mode === 'derived' ? (
          <div className="space-y-4">
            <Alert
              variant="info"
              title="System conversion detected"
              message="Manual conversion editing is hidden because the unit registry can derive the required canonical mappings."
            />
            {conversionState.conversions.length === 0 ? (
              <EmptyState
                title="No alternate units in use"
                description="The item is normalized through the system unit registry. Derived conversions will appear when alternate units are observed or configured."
              />
            ) : (
              <DataTable
                rows={conversionState.conversions}
                rowKey={(row) => row.key}
                columns={[
                  {
                    id: 'equation',
                    header: 'Equation',
                    cell: (row) => formatConversionEquation(row),
                  },
                  {
                    id: 'inverse',
                    header: 'Inverse',
                    cell: (row) => `1 ${row.toUom} = ${formatNumber(row.inverseFactor)} ${row.fromUom}`,
                  },
                  {
                    id: 'path',
                    header: 'Path',
                    cell: (row) => (row.source === 'system' ? 'System registry' : 'Manual override'),
                  },
                ]}
              />
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {conversionState.missingUnits.length > 0 ? (
              <Alert
                variant="warning"
                title="Manual conversions required"
                message={`System conversion could not normalize: ${conversionState.missingUnits.join(', ')}.`}
              />
            ) : null}

            {createMutation.isError ? (
              <Alert
                variant="error"
                title="Failed to create conversion"
                message={createMutation.error.message}
              />
            ) : null}

            {deleteMutation.isError ? (
              <Alert
                variant="error"
                title="Failed to delete conversion"
                message={deleteMutation.error.message}
              />
            ) : null}

            <form
              onSubmit={handleSubmit}
              className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 xl:grid-cols-[90px_minmax(0,1fr)_80px_120px_minmax(0,1fr)_120px]"
            >
              <div className="flex items-center text-sm font-medium text-slate-600">1</div>
              <Input
                value={fromUom}
                onChange={(event) => setFromUom(event.target.value)}
                placeholder="kg"
                aria-label="From UOM"
                required
              />
              <div className="flex items-center justify-center text-sm font-medium text-slate-600">=</div>
              <Input
                value={factor}
                onChange={(event) => setFactor(event.target.value)}
                type="number"
                step="any"
                min="0.000001"
                aria-label="Factor"
                required
              />
              <Input
                value={toUom}
                onChange={(event) => setToUom(event.target.value)}
                placeholder="g"
                aria-label="To UOM"
                required
              />
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Saving...' : 'Add'}
              </Button>
            </form>

            <div className="text-sm text-slate-500">
              Inverse preview: 1 {toUom || 'g'} ={' '}
              {Number(factor) > 0 ? formatNumber(1 / Number(factor)) : '—'} {fromUom || 'kg'}
            </div>

            {manualConversions.length === 0 ? (
              <EmptyState
                title="No manual conversions configured"
                description="Add a manual conversion only when the system unit registry cannot derive the canonical mapping."
              />
            ) : (
              <DataTable
                rows={conversionState.conversions}
                rowKey={(row) => row.key}
                columns={[
                  { id: 'from', header: 'From', cell: (row) => row.fromUom },
                  { id: 'to', header: 'To', cell: (row) => row.toUom },
                  {
                    id: 'factor',
                    header: 'Factor',
                    align: 'right',
                    cell: (row) => formatNumber(row.factor),
                  },
                  {
                    id: 'path',
                    header: 'Path',
                    cell: (row) => (row.source === 'system' ? 'System registry' : 'Item override'),
                  },
                  {
                    id: 'action',
                    header: 'Action',
                    align: 'right',
                    cell: (row) =>
                      row.source === 'manual' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="border-transparent shadow-none hover:bg-rose-50 hover:text-rose-700"
                          onClick={() => {
                            const manualMatch = manualConversions.find(
                              (conversion) =>
                                conversion.fromUom === row.fromUom && conversion.toUom === row.toUom,
                            )
                            if (manualMatch) {
                              deleteMutation.mutate(manualMatch.id)
                            }
                          }}
                        >
                          Delete
                        </Button>
                      ) : (
                        <span className="text-slate-400">System</span>
                      ),
                  },
                ]}
              />
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
