import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { getNcr, updateNcrDisposition } from '../api/ncrs'
import type { Ncr, NcrUpdateInput } from '../types'
import { Button } from '../../../components/Button'
import { LoadingSpinner } from '../../../components/Loading'
import { ErrorState } from '../../../components/ErrorState'
import { Badge } from '../../../components/Badge'
import { Card } from '../../../components/Card'
import { Textarea, Select } from '../../../components/Inputs'

export default function NcrDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [ncr, setNcr] = useState<Ncr | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<NcrUpdateInput>()

  useEffect(() => {
    if (id) loadNcr(id)
  }, [id])

  async function loadNcr(ncrId: string) {
    setLoading(true)
    try {
      const data = await getNcr(ncrId)
      setNcr(data)
    } catch {
      setError('Failed to load NCR details')
    } finally {
      setLoading(false)
    }
  }

  async function onSubmit(data: NcrUpdateInput) {
    if (!ncr) return
    try {
      await updateNcrDisposition(ncr.id, data)
      await loadNcr(ncr.id) // Reload to show updated status
    } catch {
      alert('Failed to update disposition')
    }
  }

  if (loading) return <LoadingSpinner />
  if (error || !ncr) return <ErrorState error={{ status: 404, message: error || 'NCR not found' }} />

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{ncr.ncr_number}</h1>
          <p className="text-sm text-gray-500">Created on {new Date(ncr.created_at).toLocaleString()}</p>
        </div>
        <Badge variant={ncr.status === 'open' ? 'warning' : 'success'}>
          {ncr.status.toUpperCase()}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="QC Event Details">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Event Type</dt>
              <dd className="font-medium">{ncr.event_type}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Quantity</dt>
              <dd className="font-medium">{ncr.quantity} {ncr.uom}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Reason Code</dt>
              <dd className="font-medium">{ncr.reason_code || '-'}</dd>
            </div>
            {ncr.purchase_order_receipt_line_id && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Source</dt>
                <dd className="font-medium">PO Receipt</dd>
              </div>
            )}
            {ncr.work_order_id && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Source</dt>
                <dd className="font-medium">Work Order</dd>
              </div>
            )}
          </dl>
        </Card>

        <Card title="Disposition">
          {ncr.status === 'closed' ? (
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Disposition</dt>
                <dd className="font-medium capitalize">{ncr.disposition_type?.replace(/_/g, ' ')}</dd>
              </div>
              <div>
                <dt className="text-gray-500 mb-1">Notes</dt>
                <dd className="bg-gray-50 p-3 rounded text-gray-700">{ncr.disposition_notes || 'No notes'}</dd>
              </div>
              <div className="flex justify-between pt-2 border-t">
                <dt className="text-gray-500">Closed At</dt>
                <dd className="font-medium">{new Date(ncr.updated_at).toLocaleString()}</dd>
              </div>
            </dl>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700">Disposition Action</label>
                <Select
                  {...register('dispositionType', { required: 'Disposition is required' })}
                >
                  <option value="">Select action...</option>
                  <option value="return_to_vendor">Return to Vendor</option>
                  <option value="scrap">Scrap</option>
                  <option value="rework">Rework</option>
                  <option value="use_as_is">Use As Is</option>
                </Select>
                {errors.dispositionType && (
                  <p className="text-sm text-red-600">{errors.dispositionType.message}</p>
                )}
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700">Notes</label>
                <Textarea
                  rows={3}
                  {...register('dispositionNotes')}
                  placeholder="Enter justification or instructions..."
                />
              </div>

              <div className="pt-2">
                <Button type="submit" disabled={isSubmitting} className="w-full">
                  {isSubmitting ? 'Submitting...' : 'Submit Disposition'}
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>
      
      <div className="flex justify-start">
        <Button variant="secondary" onClick={() => navigate('/ncrs')}>
          Back to List
        </Button>
      </div>
    </div>
  )
}
