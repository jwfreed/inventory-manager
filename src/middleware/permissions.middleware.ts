import type { NextFunction, Request, Response } from 'express';
import {
  hasPermission,
  type Permission,
  routePermissionRules,
  type RoutePermissionRule
} from '../config/permissions';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePathPattern(path: string): RegExp {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter(Boolean);
  const source = segments
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegex(segment)))
    .join('/');
  return new RegExp(`^/${source}/?$`);
}

function normalizePath(path: string): string {
  if (!path || path === '/') return '/';
  return `/${path.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

const compiledRoutePermissionRules = routePermissionRules.map((rule) => ({
  ...rule,
  methods: new Set(rule.methods.map((method) => method.toUpperCase())),
  pattern: compilePathPattern(rule.path)
}));

export function findRoutePermission(
  method: string,
  path: string,
  rules: readonly RoutePermissionRule[] = routePermissionRules
): Permission | null {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = normalizePath(path);
  const candidates =
    rules === routePermissionRules
      ? compiledRoutePermissionRules
      : rules.map((rule) => ({
          ...rule,
          methods: new Set(rule.methods.map((entry) => entry.toUpperCase())),
          pattern: compilePathPattern(rule.path)
        }));

  const match = candidates.find((rule) => rule.methods.has(normalizedMethod) && rule.pattern.test(normalizedPath));
  return match?.permission ?? null;
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="inventory-manager", error="invalid_token"');
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!hasPermission(auth.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permission.', permission });
    }
    return next();
  };
}

export function requireRoutePermission(req: Request, res: Response, next: NextFunction) {
  const requiredPermission = findRoutePermission(req.method, req.path);
  if (!requiredPermission) {
    if (WRITE_METHODS.has(req.method.toUpperCase())) {
      return res.status(403).json({ error: 'No permission rule registered for this write route.' });
    }
    return next();
  }
  return requirePermission(requiredPermission)(req, res, next);
}
