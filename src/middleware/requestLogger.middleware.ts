import type { Request, Response, NextFunction } from 'express';

type RequestLogEntry = {
  event: 'http_request';
  requestId?: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  bytesIn: number;
  bytesOut: number;
  tenantId?: string;
  userId?: string;
  userAgent?: string;
  ip?: string;
  timestamp: string;
};

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const bytesIn = Number(req.headers['content-length'] ?? 0);

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const bytesOut = Number(res.getHeader('content-length') ?? 0);

    const entry: RequestLogEntry = {
      event: 'http_request',
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      bytesIn,
      bytesOut,
      tenantId: req.auth?.tenantId,
      userId: req.auth?.userId,
      userAgent: req.header('user-agent') ?? undefined,
      ip: req.ip,
      timestamp: new Date().toISOString()
    };

    console.log(JSON.stringify(entry));
  });

  next();
}
