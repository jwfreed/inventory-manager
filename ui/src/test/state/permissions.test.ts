import { describe, expect, it } from 'vitest'
import { hasAllUiPermissions, hasAnyUiPermission, hasUiPermission } from '../../lib/permissions'

describe('UI permission helpers', () => {
  const adminPermissions = [
    'inventory:read',
    'finance:read',
    'finance:approve',
    'admin:imports',
  ]

  it('checks a single permission from the authenticated session permission list', () => {
    expect(hasUiPermission(adminPermissions, 'finance:read')).toBe(true)
    expect(hasUiPermission(adminPermissions, 'compliance:admin')).toBe(false)
    expect(hasUiPermission(null, 'finance:read')).toBe(false)
  })

  it('checks any/all permission requirements', () => {
    expect(hasAnyUiPermission(adminPermissions, ['compliance:admin', 'finance:approve'])).toBe(true)
    expect(hasAnyUiPermission(adminPermissions, ['compliance:admin', 'users:write'])).toBe(false)
    expect(hasAllUiPermissions(adminPermissions, ['inventory:read', 'admin:imports'])).toBe(true)
    expect(hasAllUiPermissions(adminPermissions, ['inventory:read', 'users:write'])).toBe(false)
  })
})
