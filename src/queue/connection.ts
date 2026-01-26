import Redis from 'ioredis';

const QUEUE_REDIS_URL = process.env.QUEUE_REDIS_URL ?? process.env.REDIS_URL ?? null;

let connection: Redis | null = null;

export function getQueueConnection(): Redis {
  if (!QUEUE_REDIS_URL) {
    throw new Error('QUEUE_REDIS_URL or REDIS_URL must be set to use BullMQ');
  }
  if (connection) return connection;
  connection = new Redis(QUEUE_REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true
  });
  connection.connect().catch(() => undefined);
  return connection;
}
