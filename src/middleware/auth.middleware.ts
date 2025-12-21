import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/auth';

function extractBearerToken(header?: string) {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  return token ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const bearer = extractBearerToken(req.headers.authorization);
  const queryToken = typeof req.query.access_token === 'string' ? req.query.access_token : null;
  const token = bearer ?? queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Missing access token.' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.auth = {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired access token.' });
  }
}
