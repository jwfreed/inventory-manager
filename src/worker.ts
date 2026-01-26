import './telemetry';
import { queueSchedulers } from './queue/queues';
import { registerRepeatableJobs, startWorkers } from './queue/workers';

const REGISTER_JOBS = process.env.WORKER_REGISTER_JOBS !== 'false';

console.log('\n🧵 Starting worker process...');

if (REGISTER_JOBS) {
  console.log('📅 Registering repeatable jobs...');
  registerRepeatableJobs();
}

const workers = startWorkers();

process.on('SIGTERM', () => {
  console.log('\n🛑 Worker SIGTERM received, shutting down...');
  queueSchedulers.forEach((scheduler) => scheduler.close());
  workers.criticalWorker.close();
  workers.heavyWorker.close();
  workers.outboxWorker.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Worker SIGINT received, shutting down...');
  queueSchedulers.forEach((scheduler) => scheduler.close());
  workers.criticalWorker.close();
  workers.heavyWorker.close();
  workers.outboxWorker.close();
  process.exit(0);
});
