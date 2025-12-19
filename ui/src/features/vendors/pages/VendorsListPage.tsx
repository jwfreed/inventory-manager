import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listVendors, createVendor, updateVendor, deleteVendor, type VendorPayload } from '../../../api/endpoints/vendors'
import type { ApiError, Vendor } from '../../../api/types'
import { Section } from '../../../components/Section'
import { Card } from '../../../components/Card'
import { Alert } from '../../../components/Alert'
import { LoadingSpinner } from '../../../components/Loading'
import { Button } from '../../../components/Button'
import { Input } from '../../../components/Inputs'

export default function VendorsListPage() {
  const qc = useQueryClient()
  const [filterActive, setFilterActive] = useState<'all' | 'active'>('active')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const vendorsQuery = useQuery<{ data: Vendor[] }, ApiError>({
    queryKey: ['vendors', filterActive],
    queryFn: () => listVendors({ active: filterActive === 'active' ? true : undefined }),
    staleTime: 60_000,
  })

  const resetForm = () => {
    setCode('')
    setName('')
    setEmail('')
    setPhone('')
    setEditingId(null)
  }

  const createMutation = useMutation({
    mutationFn: (payload: VendorPayload) => createVendor(payload),
    onSuccess: () => {
      resetForm()
      void qc.invalidateQueries({ queryKey: ['vendors'] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: VendorPayload }) => updateVendor(id, payload),
    onSuccess: () => {
      resetForm()
      void qc.invalidateQueries({ queryKey: ['vendors'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteVendor(id),
    onSuccess: () => {
      if (editingId === id) resetForm()
      void qc.invalidateQueries({ queryKey: ['vendors'] })
    },
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!code.trim() || !name.trim()) return
    const payload: VendorPayload = {
      code: code.trim(),
      name: name.trim(),
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  const onEdit = (vendor: Vendor) => {
    setEditingId(vendor.id)
    setCode(vendor.code)
    setName(vendor.name)
    setEmail(vendor.email ?? '')
    setPhone(vendor.phone ?? '')
  }

  const vendors = useMemo(() => vendorsQuery.data?.data ?? [], [vendorsQuery.data])

  const loading = vendorsQuery.isLoading || createMutation.isPending || updateMutation.isPending || deleteMutation.isPending
  const error = vendorsQuery.error || createMutation.error || updateMutation.error || deleteMutation.error

  return (
    <div className="space-y-6">
      <Section title="Vendors" description="Create suppliers and keep them tidy. Active vendors show up in PO and receiving pickers.">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            {loading && <LoadingSpinner label="Processing..." />}
            {error && (
              <Alert
                variant="error"
                title="Error"
                message={(error as ApiError)?.message ?? 'An error occurred'}
              />
            )}
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-slate-800">
                    {editingId ? 'Edit vendor' : 'New vendor'}
                  </div>
                  <p className="text-xs text-slate-500">Code should be short and unique (e.g., SIAMAYA).</p>
                </div>
                {editingId && (
                  <Button type="button" variant="secondary" size="sm" onClick={resetForm}>
                    Cancel
                  </Button>
                )}
              </div>
              <div className="grid gap-3">
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Code</span>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} required />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Name</span>
                  <Input value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Email</span>
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Phone</span>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
                </label>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500">Active by default; deactivate from the list.</p>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {editingId ? 'Update vendor' : 'Create vendor'}
                </Button>
              </div>
            </form>
          </Card>

          <Card className="lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">Vendor list</div>
                <p className="text-xs text-slate-500">Filter to active for day-to-day; show all for audit/reactivation.</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant={filterActive === 'active' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setFilterActive('active')}
                >
                  Active
                </Button>
                <Button
                  variant={filterActive === 'all' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setFilterActive('all')}
                >
                  All
                </Button>
              </div>
            </div>
            {vendorsQuery.isLoading && <LoadingSpinner label="Loading vendors..." />}
            {!vendorsQuery.isLoading && vendors.length === 0 && (
              <div className="py-6 text-sm text-slate-600">No vendors found.</div>
            )}
            {!vendorsQuery.isLoading && vendors.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Code
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Name
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Email
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Phone
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Active
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {vendors.map((vendor) => (
                      <tr key={vendor.id}>
                        <td className="px-3 py-2 text-sm text-slate-800">{vendor.code}</td>
                        <td className="px-3 py-2 text-sm text-slate-800">{vendor.name}</td>
                        <td className="px-3 py-2 text-sm text-slate-800">{vendor.email ?? '—'}</td>
                        <td className="px-3 py-2 text-sm text-slate-800">{vendor.phone ?? '—'}</td>
                        <td className="px-3 py-2 text-sm text-slate-800">{vendor.active ? 'Yes' : 'No'}</td>
                        <td className="px-3 py-2 text-right text-sm text-slate-800">
                          <div className="flex justify-end gap-2">
                            <Button variant="secondary" size="sm" onClick={() => onEdit(vendor)}>
                              Edit
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => deleteMutation.mutate(vendor.id)}>
                              Deactivate
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </Section>
    </div>
  )
}
