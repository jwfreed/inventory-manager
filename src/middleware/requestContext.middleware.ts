import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithRequestContext } from '../lib/requestContext';

function extractRequestId(req: Request): string {
  const header = req.header('x-request-id') || req.header('x-correlation-id');
  if (typeof header === 'string' && header.trim()) {
    return header.trim();
  }
  return uuidv4();
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = extractRequestId(req);
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  runWithRequestContext({ requestId }, () => next());
}
