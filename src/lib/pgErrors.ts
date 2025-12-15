type PgError = {
  code?: string;
  constraint?: string;
  detail?: string;
};

export type PgErrorMapping = {
  unique?: (err: PgError) => { status: number; body: any } | null;
  foreignKey?: (err: PgError) => { status: number; body: any } | null;
  check?: (err: PgError) => { status: number; body: any } | null;
  notNull?: (err: PgError) => { status: number; body: any } | null;
};

/**
 * Maps Postgres errors to HTTP responses while preserving per-route semantics.
 *
 * This helper intentionally does NOT provide default messages. Callers supply
 * message bodies via the optional mapping callbacks to avoid "normalizing"
 * behavior across endpoints.
 */
export function mapPgErrorToHttp(err: unknown, mapping: PgErrorMapping): { status: number; body: any } | null {
  const pgErr = err as PgError;
  if (!pgErr || typeof pgErr !== 'object') {
    return null;
  }
  switch (pgErr.code) {
    case '23505':
      return mapping.unique?.(pgErr) ?? null;
    case '23503':
      return mapping.foreignKey?.(pgErr) ?? null;
    case '23514':
      return mapping.check?.(pgErr) ?? null;
    case '23502':
      return mapping.notNull?.(pgErr) ?? null;
    default:
      return null;
  }
}
