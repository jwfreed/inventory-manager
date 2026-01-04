/**
 * Simple in-memory cache with TTL for expensive query results.
 * Used to reduce database load for frequently-accessed aggregate data.
 * 
 * Usage:
 *   const cache = new QueryCache<AtpResult[]>(30_000); // 30 second TTL
 *   const cached = cache.get(cacheKey);
 *   if (cached) return cached;
 *   const result = await expensiveQuery();
 *   cache.set(cacheKey, result);
 *   return result;
 */
export class QueryCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private ttlMs: number = 30_000, // Default 30 seconds
    private maxEntries: number = 1000
  ) {
    // Periodic cleanup of expired entries
    this.cleanupInterval = setInterval(() => this.cleanup(), Math.max(ttlMs, 60_000));
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    
    return entry.value;
  }

  set(key: string, value: T, customTtlMs?: number): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (customTtlMs ?? this.ttlMs),
    });
  }

  invalidate(keyPattern?: string): void {
    if (!keyPattern) {
      this.cache.clear();
      return;
    }

    // Delete all keys matching pattern
    for (const key of this.cache.keys()) {
      if (key.includes(keyPattern)) {
        this.cache.delete(key);
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// Pre-configured caches for common use cases
export const atpCache = new QueryCache<unknown>(30_000, 500);       // 30s TTL for ATP
export const valuationCache = new QueryCache<unknown>(60_000, 200); // 60s TTL for valuation summaries
export const masterDataCache = new QueryCache<unknown>(300_000, 1000); // 5min TTL for master data

/**
 * Helper to generate consistent cache keys
 */
export function cacheKey(prefix: string, tenantId: string, params: Record<string, unknown> = {}): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return `${prefix}:${tenantId}:${sortedParams}`;
}
