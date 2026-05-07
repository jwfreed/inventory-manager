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
let hasLoggedPublisherFailure = false;
let hasLoggedSubscriberFailure = false;

function getPublisher(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (publisher) return publisher;
  publisher = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: () => null
  });
  publisher.on('error', (error) => {
    if (!hasLoggedPublisherFailure) {
      console.warn(`[eventBus] Redis publisher unavailable: ${error.message}`);
      hasLoggedPublisherFailure = true;
    }
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
    lazyConnect: true,
    retryStrategy: () => null
  });
  subscriber.on('error', (error) => {
    if (!hasLoggedSubscriberFailure) {
      console.warn(`[eventBus] Redis subscriber unavailable: ${error.message}`);
      hasLoggedSubscriberFailure = true;
    }
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
    // power10: intentional-empty-catch -- event delivery is best-effort and must not fail the caller.
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
      // power10: intentional-empty-catch -- malformed peer messages are ignored by design.
    }
  });
}

export async function shutdownEventBus(): Promise<void> {
  const activePublisher = publisher;
  const activeSubscriber = subscriber;
  publisher = null;
  subscriber = null;
  hasLoggedPublisherFailure = false;
  hasLoggedSubscriberFailure = false;

  if (activeSubscriber) {
    try {
      activeSubscriber.removeAllListeners('message');
      if (activeSubscriber.status !== 'end') {
        await activeSubscriber.quit();
      }
    } catch {
      activeSubscriber.disconnect(false);
    }
  }

  if (activePublisher) {
    try {
      if (activePublisher.status !== 'end') {
        await activePublisher.quit();
      }
    } catch {
      activePublisher.disconnect(false);
    }
  }
}
