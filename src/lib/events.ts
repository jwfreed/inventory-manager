import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { atpCache, cacheKey } from './cache';
import { cacheAdapter } from './redis';
import { publishEvent, startEventSubscriber as startRedisEventSubscriber } from './eventBus';

export type ServerEvent = {
  id: string;
  type: string;
  occurredAt: string;
  data?: Record<string, unknown>;
};

type Client = {
  id: string;
  tenantId: string;
  res: Response;
  heartbeat: NodeJS.Timeout;
};

const clients = new Map<string, Client>();

const HEARTBEAT_MS = 25000;
const RETRY_MS = 3000;

function formatEvent(event: ServerEvent) {
  const payload = JSON.stringify(event);
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${payload}\n\n`;
}

function sendEvent(res: Response, event: ServerEvent) {
  res.write(formatEvent(event));
}

function emitLocalEvent(tenantId: string, event: ServerEvent) {
  for (const client of clients.values()) {
    if (client.tenantId !== tenantId) continue;
    if (client.res.writableEnded) continue;
    sendEvent(client.res, event);
  }
}

function handleInboundEvent(tenantId: string, event: ServerEvent) {
  if (event.type.startsWith('inventory.')) {
    atpCache.invalidate(cacheKey('atp', tenantId));
    cacheAdapter.invalidate(tenantId, '*').catch(() => undefined);
  }
}

export function registerEventStream(req: Request, res: Response, tenantId: string) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`retry: ${RETRY_MS}\n\n`);
  res.flushHeaders?.();

  const clientId = uuidv4();
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`: keep-alive ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);

  clients.set(clientId, { id: clientId, tenantId, res, heartbeat });

  const readyEvent: ServerEvent = {
    id: uuidv4(),
    type: 'system.ready',
    occurredAt: new Date().toISOString(),
    data: { clientId }
  };
  sendEvent(res, readyEvent);

  const cleanup = () => {
    const client = clients.get(clientId);
    if (client) {
      clearInterval(client.heartbeat);
      clients.delete(clientId);
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
}

export function emitEvent(tenantId: string, type: string, data?: Record<string, unknown>) {
  const event: ServerEvent = {
    id: uuidv4(),
    type,
    occurredAt: new Date().toISOString(),
    data
  };

  emitLocalEvent(tenantId, event);
  publishEvent(tenantId, event);

  return event;
}

export function activeEventClientCount(tenantId?: string) {
  if (!tenantId) {
    return clients.size;
  }
  let count = 0;
  for (const client of clients.values()) {
    if (client.tenantId === tenantId) count += 1;
  }
  return count;
}

export function startEventBridge() {
  startRedisEventSubscriber((tenantId, event) => {
    handleInboundEvent(tenantId, event);
    emitLocalEvent(tenantId, event);
  });
}
