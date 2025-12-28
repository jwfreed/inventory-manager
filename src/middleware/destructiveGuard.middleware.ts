import type { Request, Response, NextFunction } from 'express';

const guardedPrefixes = ['/purchase-orders', '/purchase-order-receipts'];

export function destructiveGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'DELETE') return next();
  if (process.env.NODE_ENV !== 'production') return next();
  if (process.env.ALLOW_DESTRUCTIVE_OPERATIONS === 'true') return next();

  const matches = guardedPrefixes.some((prefix) => req.path.startsWith(prefix));
  if (!matches) return next();

  return res.status(409).json({
    error: 'Destructive operations are disabled in production. Use void/cancel workflows instead.'
  });
}
