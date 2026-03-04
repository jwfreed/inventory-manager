import { query } from '../db';
import { canonicalizeRequiredUom } from './uomCanonical.service';

export type UomDimension = 'mass' | 'length' | 'volume' | 'count';

export type UomDef = {
  code: string;
  name: string;
  dimension: UomDimension;
  baseCode: string;
  toBaseFactor: string;
  precision: number;
  active: boolean;
};

type UomRegistryCache = {
  loadedAtMs: number;
  byCode: Map<string, UomDef>;
  aliasToCanonical: Map<string, string>;
};

export type UomResolutionMeta = {
  inputUomCode: string;
  normalizedInput: string;
  resolvedCanonical: string | null;
  aliasMatched: boolean;
};

export type UomResolutionResult = {
  def: UomDef | null;
  meta: UomResolutionMeta;
};

const UOM_CACHE_TTL_MS = 5 * 60 * 1000;
let cache: UomRegistryCache | null = null;

function asLookupKey(input: string) {
  return canonicalizeRequiredUom(input).toLowerCase();
}

function registryError(code: string, detail?: string, context?: Record<string, unknown>) {
  const error = new Error(detail ?? code) as Error & { code?: string; context?: Record<string, unknown> };
  error.code = code;
  if (context) {
    error.context = context;
  }
  return error;
}

async function loadRegistry(): Promise<UomRegistryCache> {
  const [uomResult, aliasResult] = await Promise.all([
    query<{
      code: string;
      name: string;
      dimension: UomDimension;
      base_code: string;
      to_base_factor: string;
      precision: number;
      active: boolean;
    }>(
      `SELECT code, name, dimension, base_code, to_base_factor::text, precision, active
         FROM uoms`
    ),
    query<{ alias_code: string; canonical_code: string }>(
      `SELECT alias_code, canonical_code
         FROM uom_aliases`
    )
  ]);

  const byCode = new Map<string, UomDef>();
  uomResult.rows.forEach((row) => {
    byCode.set(row.code.toLowerCase(), {
      code: row.code,
      name: row.name,
      dimension: row.dimension,
      baseCode: row.base_code,
      toBaseFactor: row.to_base_factor,
      precision: Number(row.precision),
      active: Boolean(row.active)
    });
  });

  const aliasToCanonical = new Map<string, string>();
  aliasResult.rows.forEach((row) => {
    aliasToCanonical.set(row.alias_code.toLowerCase(), row.canonical_code);
  });

  return {
    loadedAtMs: Date.now(),
    byCode,
    aliasToCanonical
  };
}

async function getCache(): Promise<UomRegistryCache> {
  const now = Date.now();
  if (cache && now - cache.loadedAtMs <= UOM_CACHE_TTL_MS) {
    return cache;
  }
  cache = await loadRegistry();
  return cache;
}

export function invalidateUomRegistryCache() {
  cache = null;
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const matrix = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost
      );
    }
  }
  return matrix[left.length][right.length];
}

export async function suggestUomCodes(input: string, limit = 5): Promise<string[]> {
  const lookupKey = asLookupKey(input);
  const currentCache = await getCache();
  const candidates = new Set<string>([
    ...currentCache.byCode.keys(),
    ...currentCache.aliasToCanonical.keys()
  ]);

  return Array.from(candidates)
    .map((candidate) => ({
      candidate,
      score: levenshteinDistance(lookupKey, candidate)
    }))
    .sort((left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.candidate);
}

export async function resolveUomWithMeta(code: string): Promise<UomResolutionResult> {
  const lookupKey = asLookupKey(code);
  const currentCache = await getCache();
  const direct = currentCache.byCode.get(lookupKey);
  if (direct) {
    return {
      def: direct,
      meta: {
        inputUomCode: code,
        normalizedInput: lookupKey,
        resolvedCanonical: direct.code,
        aliasMatched: false
      }
    };
  }

  const aliasCanonical = currentCache.aliasToCanonical.get(lookupKey);
  if (!aliasCanonical) {
    return {
      def: null,
      meta: {
        inputUomCode: code,
        normalizedInput: lookupKey,
        resolvedCanonical: null,
        aliasMatched: false
      }
    };
  }

  const resolved = currentCache.byCode.get(aliasCanonical.toLowerCase()) ?? null;
  return {
    def: resolved,
    meta: {
      inputUomCode: code,
      normalizedInput: lookupKey,
      resolvedCanonical: resolved?.code ?? aliasCanonical,
      aliasMatched: true
    }
  };
}

export async function resolveUom(code: string): Promise<UomDef | null> {
  const resolved = await resolveUomWithMeta(code);
  return resolved.def;
}

export async function getUom(code: string): Promise<UomDef | null> {
  return resolveUom(code);
}

export async function listUoms(): Promise<UomDef[]> {
  const currentCache = await getCache();
  return Array.from(currentCache.byCode.values())
    .filter((entry) => entry.active)
    .sort((left, right) => left.code.localeCompare(right.code));
}

export async function assertUomActive(code: string): Promise<UomDef> {
  const resolved = await resolveUomWithMeta(code);
  const def = resolved.def;
  if (!def) {
    const suggestions = await suggestUomCodes(code, 3);
    const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
    throw registryError('UOM_UNKNOWN', `Unknown UOM code: ${code}.${suggestionText}`, {
      inputUomCode: code,
      suggestions
    });
  }
  if (!def.active) {
    throw registryError('UOM_INACTIVE', `Inactive UOM code: ${code}`);
  }
  return def;
}
