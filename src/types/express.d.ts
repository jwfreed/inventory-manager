import type { AccessTokenPayload } from '../lib/auth';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        tenantId: string;
        role: AccessTokenPayload['role'];
      };
    }
  }
}

export {};
