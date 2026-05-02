export type Permission = string

export function hasUiPermission(
  permissions: readonly string[] | null | undefined,
  permission: Permission,
): boolean {
  return Boolean(permission) && Boolean(permissions?.includes(permission))
}

export function hasAnyUiPermission(
  userPermissions: readonly string[] | null | undefined,
  requiredPermissions: readonly Permission[],
): boolean {
  if (requiredPermissions.length === 0) return true
  return requiredPermissions.some((permission) => hasUiPermission(userPermissions, permission))
}

export function hasAllUiPermissions(
  userPermissions: readonly string[] | null | undefined,
  requiredPermissions: readonly Permission[],
): boolean {
  if (requiredPermissions.length === 0) return true
  return requiredPermissions.every((permission) => hasUiPermission(userPermissions, permission))
}
