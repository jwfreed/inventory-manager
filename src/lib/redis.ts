import Redis from 'ioredis'
import { QueryCache } from './cache'
import crypto from 'crypto'

/**
 * Redis-backed cache adapter with automatic fallback to in-memory cache.
 * 
 * If REDIS_URL is configured, uses Redis for distributed caching across instances.
 * If not configured, falls back to in-memory QueryCache for single-instance deployments.
 * 
 * All cache keys are tenant-scoped: tenant:{tenantId}:metrics:{metricType}:{paramHash}
 */
class CacheAdapter {
  private redis: Redis | null = null
  private fallbackCache: QueryCache<string> | null = null
  private isRedisAvailable = false

  constructor() {
    if (process.env.REDIS_URL) {
      try {
        this.redis = new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          enableOfflineQueue: false,
          lazyConnect: true,
        })

        this.redis.on('connect', () => {
          console.log('✅ Redis connected successfully')
          this.isRedisAvailable = true
        })

        this.redis.on('error', (err) => {
          console.error('❌ Redis connection error:', err.message)
          this.isRedisAvailable = false
        })

        this.redis.on('close', () => {
          console.warn('⚠️  Redis connection closed, falling back to in-memory cache')
          this.isRedisAvailable = false
        })

        // Attempt initial connection
        this.redis.connect().catch((err) => {
          console.error('Failed to connect to Redis:', err.message)
          this.isRedisAvailable = false
        })
      } catch (error) {
        console.error('Failed to initialize Redis:', error)
        this.redis = null
        this.isRedisAvailable = false
      }
    } else {
      console.warn('⚠️  REDIS_URL not configured - using in-memory cache (not shared across instances)')
    }

    // Always create fallback cache for when Redis is unavailable
    this.fallbackCache = new QueryCache<string>(300_000, 5000) // 5 min default, up to 5000 entries
  }

  /**
   * Generate a consistent, tenant-scoped cache key
   * Pattern: tenant:{tenantId}:metrics:{metricType}:{paramHash}
   */
  buildKey(tenantId: string, metricType: string, params: Record<string, unknown> = {}): string {
    const paramHash = this.hashParams(params)
    return `tenant:${tenantId}:metrics:${metricType}:${paramHash}`
  }

  /**
   * Hash parameters to create short, consistent cache key suffix
   */
  private hashParams(params: Record<string, unknown>): string {
    if (Object.keys(params).length === 0) return 'default'
    
    const sortedParams = Object.keys(params)
      .sort()
      .reduce((acc, key) => {
        acc[key] = params[key]
        return acc
      }, {} as Record<string, unknown>)
    
    const paramString = JSON.stringify(sortedParams)
    return crypto.createHash('md5').update(paramString).digest('hex').substring(0, 12)
  }

  /**
   * Get cached value (tries Redis first, falls back to in-memory)
   */
  async get<T>(tenantId: string, metricType: string, params: Record<string, unknown> = {}): Promise<T | null> {
    const key = this.buildKey(tenantId, metricType, params)

    // Try Redis first if available
    if (this.redis && this.isRedisAvailable) {
      try {
        const value = await this.redis.get(key)
        if (value) {
          return JSON.parse(value) as T
        }
      } catch (error) {
        console.error('Redis GET error:', error)
        // Fall through to in-memory cache
      }
    }

    // Fall back to in-memory cache
    const cached = this.fallbackCache?.get(key)
    if (cached) {
      return JSON.parse(cached) as T
    }

    return null
  }

  /**
   * Set cached value (writes to both Redis and in-memory)
   */
  async set<T>(
    tenantId: string,
    metricType: string,
    value: T,
    ttlSeconds: number,
    params: Record<string, unknown> = {}
  ): Promise<void> {
    const key = this.buildKey(tenantId, metricType, params)
    const serialized = JSON.stringify(value)

    // Write to Redis if available
    if (this.redis && this.isRedisAvailable) {
      try {
        await this.redis.setex(key, ttlSeconds, serialized)
      } catch (error) {
        console.error('Redis SET error:', error)
        // Continue to write to in-memory cache
      }
    }

    // Always write to in-memory cache as backup
    this.fallbackCache?.set(key, serialized, ttlSeconds * 1000)
  }

  /**
   * Invalidate cache entries matching pattern (tenant-scoped)
   * Pattern matching: Use '*' wildcard in metricType
   * Examples:
   *   - invalidate(tenantId, 'abc_class') - invalidates specific metric
   *   - invalidate(tenantId, '*') - invalidates all metrics for tenant
   */
  async invalidate(tenantId: string, metricTypePattern: string = '*'): Promise<number> {
    const pattern = `tenant:${tenantId}:metrics:${metricTypePattern}:*`
    let deletedCount = 0

    // Invalidate in Redis if available
    if (this.redis && this.isRedisAvailable) {
      try {
        const keys = await this.redis.keys(pattern)
        if (keys.length > 0) {
          deletedCount = await this.redis.del(...keys)
        }
      } catch (error) {
        console.error('Redis invalidation error:', error)
      }
    }

    // Invalidate in in-memory cache
    const searchPattern = `tenant:${tenantId}:metrics:${metricTypePattern}`
    this.fallbackCache?.invalidate(searchPattern)

    return deletedCount
  }

  /**
   * Invalidate all caches (use with caution)
   */
  async invalidateAll(): Promise<void> {
    if (this.redis && this.isRedisAvailable) {
      try {
        const keys = await this.redis.keys('tenant:*:metrics:*')
        if (keys.length > 0) {
          await this.redis.del(...keys)
        }
      } catch (error) {
        console.error('Redis flush error:', error)
      }
    }

    this.fallbackCache?.invalidate()
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    backend: 'redis' | 'memory'
    redisConnected: boolean
    memoryEntries: number
    redisKeys?: number
  }> {
    let redisKeys = 0
    if (this.redis && this.isRedisAvailable) {
      try {
        const keys = await this.redis.keys('tenant:*:metrics:*')
        redisKeys = keys.length
      } catch (error) {
        console.error('Redis stats error:', error)
      }
    }

    return {
      backend: this.isRedisAvailable ? 'redis' : 'memory',
      redisConnected: this.isRedisAvailable,
      memoryEntries: this.fallbackCache?.size || 0,
      ...(this.isRedisAvailable && { redisKeys }),
    }
  }

  /**
   * Graceful shutdown
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit()
    }
    this.fallbackCache?.destroy()
  }
}

// Singleton instance
export const cacheAdapter = new CacheAdapter()

// Export for graceful shutdown in server
export async function shutdownCache(): Promise<void> {
  await cacheAdapter.disconnect()
}
