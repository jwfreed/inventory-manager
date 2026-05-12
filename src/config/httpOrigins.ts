const DEFAULT_LOCAL_UI_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
] as const;

type HttpOriginOptions = {
  env?: NodeJS.ProcessEnv;
};

function parseOriginList(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

export function resolveAllowedHttpOrigins(options: HttpOriginOptions = {}): string[] {
  const env = options.env ?? process.env;
  const configured = dedupePreservingOrder([
    ...parseOriginList(env.CORS_ORIGIN),
    ...parseOriginList(env.CORS_ORIGINS)
  ]);
  if (configured.length > 0) return configured;

  const nodeEnv = String(env.NODE_ENV ?? 'development').trim().toLowerCase();
  if (nodeEnv === 'production') return [];

  return [...DEFAULT_LOCAL_UI_ORIGINS];
}

export function resolveCorsAllowedOrigin(origin: string, allowedOrigins: readonly string[]): string | null {
  if (allowedOrigins.length === 0) return null;
  return allowedOrigins.includes(origin) ? origin : null;
}

export function isTrustedHttpOrigin(
  origin: string | null,
  requestOrigin: string,
  allowedOrigins: readonly string[]
): boolean {
  if (!origin) return true;
  const normalizedOrigin = origin.toLowerCase();
  const normalizedRequestOrigin = requestOrigin.toLowerCase();
  const normalizedAllowedOrigins = new Set(allowedOrigins.map((entry) => entry.toLowerCase()));
  return normalizedOrigin === normalizedRequestOrigin || normalizedAllowedOrigins.has(normalizedOrigin);
}
