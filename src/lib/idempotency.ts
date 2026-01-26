import type { Request } from 'express';

export function getIdempotencyKey(req: Request): string | null {
  const header = req.header('Idempotency-Key') || req.header('idempotency-key');
  if (!header) return null;
  const key = header.trim();
  return key.length > 0 ? key : null;
}
