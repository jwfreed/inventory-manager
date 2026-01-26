import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import type { ServerEvent } from './events';

type EventEnvelope = {
  sourceId: string;
  tenantId: string;
  event: ServerEvent;
};

const EVENT_SOURCE_ID = process.env.EVENT_SOURCE_ID ?? uuidv4();
const EVENT_CHANNEL = process.env.EVENTS_CHANNEL ?? 'inventory:events';

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

function getPublisher(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (publisher) return publisher;
  publisher = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true
  });
  publisher.connect().catch(() => undefined);
  return publisher;
}

function getSubscriber(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (subscriber) return subscriber;
  subscriber = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true
  });
  subscriber.connect().catch(() => undefined);
  return subscriber;
}

export async function publishEvent(tenantId: string, event: ServerEvent) {
  const client = getPublisher();
  if (!client) return;
  const payload: EventEnvelope = {
    sourceId: EVENT_SOURCE_ID,
    tenantId,
    event
  };
  try {
    await client.publish(EVENT_CHANNEL, JSON.stringify(payload));
  } catch {
    // Ignore publish errors (events are best-effort)
  }
}

export function startEventSubscriber(
  handler: (tenantId: string, event: ServerEvent) => void
) {
  const client = getSubscriber();
  if (!client) return;
  client.subscribe(EVENT_CHANNEL).catch(() => undefined);
  client.on('message', (_channel, message) => {
    try {
      const payload = JSON.parse(message) as EventEnvelope;
      if (payload.sourceId === EVENT_SOURCE_ID) return;
      handler(payload.tenantId, payload.event);
    } catch {
      // Ignore malformed messages
    }
  });
}
