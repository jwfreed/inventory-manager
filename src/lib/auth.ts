import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? '';
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL ?? '15m';
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET must be set before starting the API');
}

export type AccessTokenPayload = {
  sub: string;
  tenantId: string;
  role: string;
};

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function signAccessToken(payload: AccessTokenPayload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, JWT_SECRET) as AccessTokenPayload;
}

export function buildRefreshToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { raw, hash, expiresAt };
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshCookieOptions(path: string = '/', includeMaxAge: boolean = true) {
  const secure = process.env.NODE_ENV === 'production';
  const options: any = {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path
  };
  if (includeMaxAge) {
    options.maxAge = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  }
  return options;
}
