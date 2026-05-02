export type Permission =
  | 'admin:health'
  | 'admin:imports'
  | 'admin:outbox'
  | 'admin:reconcile'
  | 'audit:read'

const rolePermissions: Record<string, readonly Permission[]> = {
  operator: [],
  supervisor: ['audit:read'],
  manager: ['audit:read'],
  admin: ['admin:health', 'admin:imports', 'admin:outbox', 'admin:reconcile', 'audit:read'],
}

export function hasUiPermission(role: string | null | undefined, permission: Permission): boolean {
  if (!role) return false
  return rolePermissions[role]?.includes(permission) ?? false
}

