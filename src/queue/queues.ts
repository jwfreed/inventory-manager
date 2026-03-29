import { Queue } from 'bullmq';
import { getQueueConnection } from './connection';

export const QUEUE_NAMES = {
  critical: 'inventory-critical',
  heavy: 'inventory-heavy',
  outbox: 'inventory-outbox'
};

const connection = getQueueConnection();

export const criticalQueue = new Queue(QUEUE_NAMES.critical, { connection });
export const heavyQueue = new Queue(QUEUE_NAMES.heavy, { connection });
export const outboxQueue = new Queue(QUEUE_NAMES.outbox, { connection });

export const queueSchedulers: Array<{ close: () => Promise<void> }> = [];
