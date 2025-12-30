import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createVendor, updateVendor, deleteVendor, type VendorPayload } from '../api/vendors'
import { useVendorsList, vendorsQueryKeys } from '../queries'
import type { ApiError, Vendor } from '../../../api/types'
import { Section } from '../../../components/Section'
import { Card } from '../../../components/Card'
import { Alert } from '../../../components/Alert'
import { LoadingSpinner } from '../../../components/Loading'
import { Button } from '../../../components/Button'
import { Input } from '../../../components/Inputs'
import { Badge } from '../../../components/Badge'

export default function VendorsListPage() {
  const qc = useQueryClient()
  const [filterActive, setFilterActive] = useState<'all' | 'active'>('active')
  const [showForm, setShowForm] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [codeError, setCodeError] = useState(false)
  const [nameError, setNameError] = useState(false)
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null)
  const codeInputRef = useRef<HTMLInputElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const vendorsQuery = useVendorsList(
    { active: filterActive === 'active' ? true : undefined },
    { staleTime: 60_000 },
  )

  const resetForm = () => {
    setCode('')
    setName('')
    setEmail('')
    setPhone('')
    setCodeError(false)
    setNameError(false)
    setEditingId(null)
    setShowForm(false)
  }

  const createMutation = useMutation({
    mutationFn: (payload: VendorPayload) => createVendor(payload),
    onSuccess: () => {
      resetForm()
      void qc.invalidateQueries({ queryKey: vendorsQueryKeys.all })
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: VendorPayload }) => updateVendor(id, payload),
    onSuccess: () => {
      resetForm()
      void qc.invalidateQueries({ queryKey: vendorsQueryKeys.all })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteVendor(id),
    onSuccess: () => {
      if (editingId === id) resetForm()
      void qc.invalidateQueries({ queryKey: vendorsQueryKeys.all })
    },
    onSettled: () => {
      setDeactivatingId(null)
    },
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const codeValue = code.trim()
    const nameValue = name.trim()
    setCodeError(!codeValue)
    setNameError(!nameValue)
    if (!codeValue || !nameValue) return
    const payload: VendorPayload = {
      code: codeValue,
      name: nameValue,
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
    setCodeError(false)
    setNameError(false)
    setShowForm(true)
  }

  const onCreate = () => {
    setEditingId(null)
    setCode('')
    setName('')
    setEmail('')
    setPhone('')
    setCodeError(false)
    setNameError(false)
    setShowForm(true)
  }

  const onCloseForm = () => {
    resetForm()
  }

  const onDeactivate = (vendorId: string) => {
    const confirmed = window.confirm(
      'Deactivate vendor?\n\nInactive vendors won’t appear in PO and receiving pickers. This does not delete history.',
    )
    if (!confirmed) return
    setDeactivatingId(vendorId)
    deleteMutation.mutate(vendorId)
  }

  const vendors = useMemo(() => vendorsQuery.data?.data ?? [], [vendorsQuery.data])
  const filteredVendors = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return vendors
    return vendors.filter((vendor) => {
      const codeValue = vendor.code?.toLowerCase() ?? ''
      const nameValue = vendor.name?.toLowerCase() ?? ''
      return codeValue.includes(term) || nameValue.includes(term)
    })
  }, [vendors, search])

  useEffect(() => {
    if (!showForm) return
    if (editingId) {
      nameInputRef.current?.focus()
    } else {
      codeInputRef.current?.focus()
    }
  }, [showForm, editingId])

  const formSubmitting = createMutation.isPending || updateMutation.isPending
  const error = vendorsQuery.error || createMutation.error || updateMutation.error || deleteMutation.error

  return (
    <div className="space-y-6">
      <Section title="Vendors" description="Create suppliers and keep them tidy. Active vendors show up in PO and receiving pickers.">
        {error && (
          <Alert
            variant="error"
            title="Error"
            message={(error as ApiError)?.message ?? 'An error occurred'}
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-slate-800">Vendor list</div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-full sm:w-56"
              placeholder="Search code or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button variant="secondary" size="sm" onClick={() => (showForm ? onCloseForm() : onCreate())}>
              {showForm ? 'Close' : 'New vendor'}
            </Button>
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

        {showForm && (
          <Card className="mt-4">
            {formSubmitting && <LoadingSpinner label="Processing..." />}
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-slate-800">
                    {editingId ? 'Edit vendor' : 'New vendor'}
                  </div>
                  <p className="text-xs text-slate-500">Code should be short and unique (e.g., SIAMAYA).</p>
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={onCloseForm}>
                  Cancel
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Code</span>
                  <Input
                    ref={codeInputRef}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value)
                      if (codeError) setCodeError(false)
                    }}
                    required
                  />
                  {codeError && <div className="text-xs text-red-600">Code is required.</div>}
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Name</span>
                  <Input
                    ref={nameInputRef}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      if (nameError) setNameError(false)
                    }}
                    required
                  />
                  {nameError && <div className="text-xs text-red-600">Name is required.</div>}
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
                <div className="flex items-center gap-2">
                  {(codeError || nameError) && (
                    <span className="text-xs text-red-600">Code and name are required.</span>
                  )}
                  <Button type="submit" disabled={formSubmitting}>
                  {editingId ? 'Update vendor' : 'Create vendor'}
                  </Button>
                </div>
              </div>
            </form>
          </Card>
        )}

        <Card className="mt-4">
          {vendorsQuery.isLoading && <LoadingSpinner label="Loading vendors..." />}
          {!vendorsQuery.isLoading && vendors.length === 0 && (
            <div className="py-6 text-sm text-slate-600">No vendors found.</div>
          )}
          {!vendorsQuery.isLoading && vendors.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
              <div>
                Showing {filteredVendors.length} vendors{filterActive === 'active' ? ' (Active)' : ''}
              </div>
            </div>
          )}
          {!vendorsQuery.isLoading && filteredVendors.length === 0 && vendors.length > 0 && (
            <div className="py-6 text-sm text-slate-600">No vendors match your search.</div>
          )}
          {!vendorsQuery.isLoading && filteredVendors.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-200">
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
                  {filteredVendors.map((vendor) => (
                    <tr key={vendor.id}>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        <button
                          className="text-brand-700 underline"
                          type="button"
                          onClick={() => onEdit(vendor)}
                        >
                          {vendor.code}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        <button
                          className="text-brand-700 underline"
                          type="button"
                          onClick={() => onEdit(vendor)}
                        >
                          {vendor.name}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">{vendor.email ?? '—'}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{vendor.phone ?? '—'}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        <Badge variant={vendor.active ? 'success' : 'neutral'}>
                          {vendor.active ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right text-sm text-slate-800">
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" size="sm" onClick={() => onEdit(vendor)}>
                            Edit
                          </Button>
                          {vendor.active ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => onDeactivate(vendor.id)}
                              disabled={deactivatingId === vendor.id}
                            >
                              {deactivatingId === vendor.id ? 'Deactivating…' : 'Deactivate'}
                            </Button>
                          ) : (
                            <Button variant="secondary" size="sm" disabled>
                              Inactive
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Section>
    </div>
  )
}
