import cron, { ScheduledTask } from 'node-cron';

/**
 * Job scheduler for automated tasks
 * Uses node-cron for in-process scheduling (no external dependencies)
 * 
 * Note: Jobs run in UTC timezone
 * For horizontal scaling across multiple instances, migrate to bullmq with Redis-backed queue
 */

type JobDefinition = {
  name: string;
  schedule: string; // Cron expression
  task: () => Promise<void>;
  enabled: boolean;
};

const jobs = new Map<string, ScheduledTask>();
const jobDefinitions: JobDefinition[] = [];

/**
 * Register a scheduled job
 * 
 * @param name - Unique job identifier
 * @param schedule - Cron expression (runs in UTC)
 * @param task - Async function to execute
 * @param enabled - Whether to start the job immediately (default: true)
 */
export function registerJob(
  name: string,
  schedule: string,
  task: () => Promise<void>,
  enabled: boolean = true
): void {
  if (jobs.has(name)) {
    console.warn(`⚠️  Job "${name}" already registered, skipping`);
    return;
  }

  jobDefinitions.push({ name, schedule, enabled, task });

  if (!enabled) {
    console.log(`📅 Job "${name}" registered but disabled`);
    return;
  }

  const scheduledTask = cron.schedule(
    schedule,
    async () => {
      console.log(`🚀 Starting job: ${name}`);
      const startTime = Date.now();

      try {
        await task();
        const duration = Date.now() - startTime;
        console.log(`✅ Job "${name}" completed in ${duration}ms`);
      } catch (error) {
        console.error(`❌ Job "${name}" failed:`, error);
      }
    },
    {
      timezone: 'UTC'
    }
  );

  jobs.set(name, scheduledTask);
  console.log(`📅 Job "${name}" scheduled: ${schedule} (UTC)`);
}

/**
 * Start all registered jobs
 */
export function startScheduler(): void {
  console.log(`\n🕐 Starting job scheduler (${jobs.size} jobs)`);
  
  for (const [name, task] of jobs.entries()) {
    task.start();
  }

  if (jobs.size === 0) {
    console.log('   No jobs registered');
  }
}

/**
 * Stop all scheduled jobs
 */
export function stopScheduler(): void {
  console.log('\n🛑 Stopping job scheduler');
  
  for (const [name, task] of jobs.entries()) {
    task.stop();
    console.log(`   Stopped: ${name}`);
  }

  jobs.clear();
}

/**
 * Get all registered job definitions
 */
export function getJobDefinitions(): JobDefinition[] {
  return jobDefinitions;
}

/**
 * Manually trigger a job (useful for testing/admin)
 */
export async function triggerJob(name: string): Promise<void> {
  const def = jobDefinitions.find(j => j.name === name);
  
  if (!def) {
    throw new Error(`Job "${name}" not found`);
  }

  console.log(`🔧 Manually triggering job: ${name}`);
  const startTime = Date.now();

  try {
    await def.task();
    const duration = Date.now() - startTime;
    console.log(`✅ Manual job "${name}" completed in ${duration}ms`);
  } catch (error) {
    console.error(`❌ Manual job "${name}" failed:`, error);
    throw error;
  }
}
