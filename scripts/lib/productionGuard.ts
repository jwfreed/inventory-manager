export function assertNonProductionEnvironment(scriptName: string, env: NodeJS.ProcessEnv = process.env): void {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    throw new Error(`${scriptName} refused to run with NODE_ENV=production`);
  }
}

