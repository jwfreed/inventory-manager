import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ApiError } from '@api/types'
import { Alert, Button, Card, Input, LoadingSpinner } from '@shared/ui'
import { useAuth } from '@shared/auth'
import { FormField } from '../components/FormField'

function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as ApiError).message || fallback)
  }
  return fallback
}

export default function LoginPage() {
  const { status, login, bootstrap } = useAuth()
  const navigate = useNavigate()

  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginTenantSlug, setLoginTenantSlug] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginPending, setLoginPending] = useState(false)

  const [tenantName, setTenantName] = useState('')
  const [tenantSlug, setTenantSlug] = useState('')
  const [adminName, setAdminName] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [bootstrapPending, setBootstrapPending] = useState(false)

  useEffect(() => {
    if (status === 'authenticated') {
      navigate('/home', { replace: true })
    }
  }, [status, navigate])

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (loginPending) return
    setLoginError(null)
    setLoginPending(true)
    try {
      await login({
        email: loginEmail.trim(),
        password: loginPassword,
        tenantSlug: loginTenantSlug.trim() || undefined,
      })
      navigate('/home', { replace: true })
    } catch (error) {
      setLoginError(getErrorMessage(error, 'Unable to sign in.'))
    } finally {
      setLoginPending(false)
    }
  }

  const handleBootstrap = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (bootstrapPending) return
    setBootstrapError(null)
    setBootstrapPending(true)
    try {
      await bootstrap({
        tenantName: tenantName.trim() || undefined,
        tenantSlug: tenantSlug.trim() || undefined,
        adminEmail: adminEmail.trim(),
        adminPassword,
        adminName: adminName.trim() || undefined,
      })
      navigate('/home', { replace: true })
    } catch (error) {
      setBootstrapError(getErrorMessage(error, 'Unable to bootstrap admin account.'))
    } finally {
      setBootstrapPending(false)
    }
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-25">
        <LoadingSpinner label="Checking session..." />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-25">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-8 px-6 py-10">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold text-slate-900">Inventory Manager</h1>
          <p className="max-w-2xl text-sm text-slate-600">
            Sign in to your tenant workspace. First-time setup requires bootstrapping an admin
            account.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Sign in" description="Use your existing credentials to continue.">
            <form className="space-y-4" onSubmit={handleLogin}>
              {loginError && <Alert variant="error" title="Sign in failed" message={loginError} />}
              <FormField label="Email" required>
                <Input
                  type="email"
                  value={loginEmail}
                  onChange={(event) => setLoginEmail(event.target.value)}
                  autoComplete="email"
                  required
                  disabled={loginPending}
                />
              </FormField>
              <FormField label="Password" required>
                <Input
                  type="password"
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  disabled={loginPending}
                />
              </FormField>
              <FormField label="Tenant slug" helper="Optional if you only belong to one tenant.">
                <Input
                  value={loginTenantSlug}
                  onChange={(event) => setLoginTenantSlug(event.target.value)}
                  placeholder="default"
                  disabled={loginPending}
                />
              </FormField>
              <div className="flex items-center justify-between">
                <Button type="submit" disabled={loginPending}>
                  {loginPending ? 'Signing in...' : 'Sign in'}
                </Button>
              </div>
            </form>
          </Card>

          <Card
            title="Bootstrap admin"
            description="Create the first tenant + admin user when the system is empty."
          >
            <form className="space-y-4" onSubmit={handleBootstrap}>
              {bootstrapError && (
                <Alert variant="error" title="Bootstrap failed" message={bootstrapError} />
              )}
              <FormField label="Tenant name">
                <Input
                  value={tenantName}
                  onChange={(event) => setTenantName(event.target.value)}
                  placeholder="Default Tenant"
                  disabled={bootstrapPending}
                />
              </FormField>
              <FormField label="Tenant slug">
                <Input
                  value={tenantSlug}
                  onChange={(event) => setTenantSlug(event.target.value)}
                  placeholder="default"
                  disabled={bootstrapPending}
                />
              </FormField>
              <FormField label="Admin name">
                <Input
                  value={adminName}
                  onChange={(event) => setAdminName(event.target.value)}
                  placeholder="Optional"
                  disabled={bootstrapPending}
                />
              </FormField>
              <FormField label="Admin email" required>
                <Input
                  type="email"
                  value={adminEmail}
                  onChange={(event) => setAdminEmail(event.target.value)}
                  autoComplete="email"
                  required
                  disabled={bootstrapPending}
                />
              </FormField>
              <FormField label="Admin password" required>
                <Input
                  type="password"
                  value={adminPassword}
                  onChange={(event) => setAdminPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                  disabled={bootstrapPending}
                />
              </FormField>
              <Button type="submit" disabled={bootstrapPending}>
                {bootstrapPending ? 'Bootstrapping...' : 'Create admin'}
              </Button>
            </form>
          </Card>
        </div>
      </div>
    </div>
  )
}
