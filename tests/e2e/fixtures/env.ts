export type E2ECredentials = {
  email: string;
  password: string;
};

export type E2EEnv = {
  baseURL: string;
  apiBaseURL: string;
  tenantSlug?: string;
  tenantName?: string;
  dbCleanup: boolean;
  credentials: E2ECredentials;
};

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanEnv(name: string, fallback = false): boolean {
  const value = readOptionalEnv(name);
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error(`Invalid boolean env var ${name}: ${value}`);
}

function resolveCredentialPair(primaryUser: string, primaryPass: string): E2ECredentials | null {
  const user = readOptionalEnv(primaryUser);
  const pass = readOptionalEnv(primaryPass);

  if (!user && !pass) {
    return null;
  }

  if (!user || !pass) {
    throw new Error(
      `Both ${primaryUser} and ${primaryPass} must be set together when either one is provided.`
    );
  }

  return {
    email: user,
    password: pass
  };
}

export function resolveCredentials(): E2ECredentials {
  const direct = resolveCredentialPair('E2E_USER', 'E2E_PASS');
  if (direct) {
    return direct;
  }

  const seeded = resolveCredentialPair('SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD');
  if (seeded) {
    return seeded;
  }

  throw new Error(
    [
      'Missing E2E credentials.',
      'Set E2E_USER + E2E_PASS, or set SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD.',
      'No personal credential defaults are allowed.'
    ].join(' ')
  );
}

export function requireDatabaseUrl(): string {
  const url = readOptionalEnv('DATABASE_URL');
  if (!url) {
    throw new Error('DATABASE_URL is required for E2E DB helper usage.');
  }
  return url;
}

export function loadE2EEnv(): E2EEnv {
  return {
    baseURL: readOptionalEnv('E2E_BASE_URL') ?? 'http://127.0.0.1:4173',
    apiBaseURL:
      readOptionalEnv('E2E_API_BASE_URL') ??
      readOptionalEnv('API_BASE_URL') ??
      'http://127.0.0.1:3000',
    tenantSlug: readOptionalEnv('E2E_TENANT_SLUG'),
    tenantName: readOptionalEnv('E2E_TENANT_NAME'),
    dbCleanup: parseBooleanEnv('E2E_DB_CLEANUP', false),
    credentials: resolveCredentials()
  };
}
