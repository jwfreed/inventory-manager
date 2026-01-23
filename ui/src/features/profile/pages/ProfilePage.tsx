import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Input, LoadingSpinner, Section } from '@shared/ui'
import { useOnboarding } from '@features/onboarding/hooks'
import { useAuth } from '@shared/auth'
import type { ApiError } from '@api/types'
import { getActiveCurrencies } from '../../../api/currencies'
import { updateProfile } from '../api/profile'
import { useProfile } from '../queries'

const formatError = (err: unknown, fallback: string) => {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (apiErr?.message && typeof apiErr.message === 'string') return apiErr.message
  try {
    return JSON.stringify(err)
  } catch {
    return fallback
  }
}

export default function ProfilePage() {
  const { user, tenant, role, refresh } = useAuth()
  const { reset, progress } = useOnboarding()
  const profileQuery = useProfile()
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [baseCurrency, setBaseCurrency] = useState('THB')
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    const payload = profileQuery.data?.user ?? user
    if (!payload) return
    setEmail(payload.email ?? '')
    setFullName(payload.fullName ?? '')
    setBaseCurrency(payload.baseCurrency ?? 'THB')
  }, [profileQuery.data?.user, user])

  const currenciesQuery = useQuery({
    queryKey: ['currencies', 'active'],
    queryFn: getActiveCurrencies,
    staleTime: 5 * 60_000,
  })

  const canEditEmail = role === 'admin'
  const effectiveRole = profileQuery.data?.role ?? role ?? 'member'
  const effectiveTenant = profileQuery.data?.tenant ?? tenant

  const isDirty = useMemo(() => {
    const current = profileQuery.data?.user ?? user
    if (!current) return false
    return (
      (current.email ?? '') !== email ||
      (current.fullName ?? '') !== fullName ||
      (current.baseCurrency ?? 'THB') !== baseCurrency
    )
  }, [email, fullName, baseCurrency, profileQuery.data?.user, user])

  const saveMutation = useMutation({
    mutationFn: () =>
      updateProfile({
        email: email.trim() || undefined,
        fullName: fullName.trim(),
        baseCurrency: baseCurrency || undefined,
      }),
    onSuccess: (payload) => {
      setSaveError(null)
      setSaveMessage('Profile updated.')
      setEmail(payload.user.email ?? '')
      setFullName(payload.user.fullName ?? '')
      setBaseCurrency(payload.user.baseCurrency ?? 'THB')
      void refresh()
    },
    onError: (err: ApiError | unknown) => {
      setSaveMessage(null)
      setSaveError(formatError(err, 'Update failed. Check values and try again.'))
    },
  })

  return (
    <div className="space-y-6">
      <Section title="Profile" description="Manage your account basics for this workspace.">
        <Card>
          {profileQuery.isLoading && <LoadingSpinner label="Loading profile..." />}
          {profileQuery.isError && (
            <Alert
              variant="error"
              title="Profile unavailable"
              message={(profileQuery.error as ApiError)?.message ?? 'Unable to load profile.'}
            />
          )}
          {!profileQuery.isLoading && !profileQuery.isError && (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Email</span>
                  <Input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={!canEditEmail}
                  />
                  {!canEditEmail && (
                    <div className="text-xs text-slate-500">Email edits are restricted to admins.</div>
                  )}
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Full name</span>
                  <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name" />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Base currency</span>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={baseCurrency}
                    onChange={(e) => setBaseCurrency(e.target.value)}
                    disabled={currenciesQuery.isLoading || saveMutation.isPending}
                  >
                    {currenciesQuery.data?.map((currency) => (
                      <option key={currency.code} value={currency.code}>
                        {currency.code} — {currency.name}
                      </option>
                    ))}
                    {!currenciesQuery.data?.length && <option value="THB">THB — Thai Baht</option>}
                  </select>
                  {currenciesQuery.isError && (
                    <div className="text-xs text-red-600">
                      {(currenciesQuery.error as ApiError)?.message ?? 'Unable to load currencies.'}
                    </div>
                  )}
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-3 text-sm text-slate-600">
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Role</div>
                  <div className="font-semibold text-slate-900">{effectiveRole}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Tenant</div>
                  <div className="font-semibold text-slate-900">
                    {effectiveTenant?.name ?? effectiveTenant?.slug ?? '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">User ID</div>
                  <div className="font-mono text-xs text-slate-600">{user?.id ?? '—'}</div>
                </div>
              </div>

              {saveMessage && <Alert variant="success" title="Saved" message={saveMessage} />}
              {saveError && <Alert variant="error" title="Save failed" message={saveError} />}

              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const current = profileQuery.data?.user ?? user
                    if (!current) return
                    setEmail(current.email ?? '')
                    setFullName(current.fullName ?? '')
                    setBaseCurrency(current.baseCurrency ?? 'THB')
                    setSaveError(null)
                    setSaveMessage(null)
                  }}
                  disabled={!isDirty || saveMutation.isPending}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  disabled={!isDirty || saveMutation.isPending}
                >
                  {saveMutation.isPending ? 'Saving...' : 'Save changes'}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </Section>

      <Section title="Onboarding" description="Revisit setup steps at any time.">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-slate-600">
              Status: <span className="font-semibold text-slate-900">{progress.status}</span>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => reset()}>
                Restart onboarding
              </Button>
              <Button size="sm" onClick={() => window.location.assign('/onboarding/checklist')}>
                Continue
              </Button>
            </div>
          </div>
        </Card>
      </Section>
    </div>
  )
}
