type SchedulerStartupOptions = {
  env?: NodeJS.ProcessEnv;
  nodeEnv?: string;
};

type SchedulerStartupMode = {
  runInProcessJobs: boolean;
  schedulerEnabled: boolean;
};

function isTruthyValue(value: string | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function resolveSchedulerStartupMode(options: SchedulerStartupOptions = {}): SchedulerStartupMode {
  const env = options.env ?? process.env;
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV ?? 'development';
  const runInProcessJobs = isTruthyValue(env.RUN_INPROCESS_JOBS);

  if (!runInProcessJobs) {
    return {
      runInProcessJobs,
      schedulerEnabled: false
    };
  }

  if (nodeEnv === 'development') {
    return {
      runInProcessJobs,
      schedulerEnabled: isTruthyValue(env.ENABLE_SCHEDULER)
    };
  }

  return {
    runInProcessJobs,
    schedulerEnabled: true
  };
}
