export function assertNonProductionEnvironment(scriptName, env = process.env) {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    throw new Error(`${scriptName} refused to run with NODE_ENV=production`);
  }
}

