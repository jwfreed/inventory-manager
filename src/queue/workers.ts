import { Worker } from 'bullmq';
import { criticalQueue, heavyQueue, outboxQueue, QUEUE_NAMES } from './queues';
import { getQueueConnection } from './connection';
import { recalculateMetrics } from '../jobs/metricsRecalculation.job';
import { syncExchangeRates } from '../jobs/exchangeRateSync.job';
import { runInventoryHealthCheck } from '../jobs/inventoryHealth.job';
import { processOutboxBatch } from '../outbox/processor';

const connection = getQueueConnection();

export function registerRepeatableJobs() {
  const inventoryHealthCron = process.env.INVENTORY_HEALTH_CRON ?? '0 * * * *';
  const metricsCron = process.env.METRICS_RECALC_CRON ?? '0 2 * * *';
  const exchangeRateCron = process.env.EXCHANGE_RATE_CRON ?? '0 6 * * *';
  const outboxEveryMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 5000);
  const attempts = Number(process.env.JOB_RETRY_ATTEMPTS ?? 3);
  const backoffDelay = Number(process.env.JOB_RETRY_BACKOFF_MS ?? 5000);
  const jobOptions = { attempts, backoff: { type: 'exponential', delay: backoffDelay } };

  criticalQueue.add(
    'inventory-health-check',
    {},
    { repeat: { cron: inventoryHealthCron }, removeOnComplete: true, removeOnFail: 100, ...jobOptions }
  );

  heavyQueue.add(
    'metrics-recalculation',
    {},
    { repeat: { cron: metricsCron }, removeOnComplete: true, removeOnFail: 100, ...jobOptions }
  );

  heavyQueue.add(
    'exchange-rate-sync',
    {},
    { repeat: { cron: exchangeRateCron }, removeOnComplete: true, removeOnFail: 100, ...jobOptions }
  );

  outboxQueue.add(
    'outbox-process',
    {},
    { repeat: { every: outboxEveryMs }, removeOnComplete: true, removeOnFail: 100, ...jobOptions }
  );
}

export function startWorkers() {
  const criticalConcurrency = Number(process.env.WORKER_CONCURRENCY_CRITICAL ?? 2);
  const heavyConcurrency = Number(process.env.WORKER_CONCURRENCY_HEAVY ?? 1);
  const outboxConcurrency = Number(process.env.WORKER_CONCURRENCY_OUTBOX ?? 4);

  const criticalWorker = new Worker(
    QUEUE_NAMES.critical,
    async (job) => {
      if (job.name === 'inventory-health-check') {
        await runInventoryHealthCheck();
        return;
      }
      throw new Error(`Unknown critical job: ${job.name}`);
    },
    { connection, concurrency: criticalConcurrency }
  );

  const heavyWorker = new Worker(
    QUEUE_NAMES.heavy,
    async (job) => {
      if (job.name === 'metrics-recalculation') {
        await recalculateMetrics();
        return;
      }
      if (job.name === 'exchange-rate-sync') {
        await syncExchangeRates();
        return;
      }
      throw new Error(`Unknown heavy job: ${job.name}`);
    },
    { connection, concurrency: heavyConcurrency }
  );

  const outboxWorker = new Worker(
    QUEUE_NAMES.outbox,
    async () => {
      await processOutboxBatch();
    },
    { connection, concurrency: outboxConcurrency }
  );

  return { criticalWorker, heavyWorker, outboxWorker };
}
