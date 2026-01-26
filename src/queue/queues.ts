import { Queue, QueueScheduler } from 'bullmq';
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

export const queueSchedulers = [
  new QueueScheduler(QUEUE_NAMES.critical, { connection }),
  new QueueScheduler(QUEUE_NAMES.heavy, { connection }),
  new QueueScheduler(QUEUE_NAMES.outbox, { connection })
];
