/* eslint-disable no-console */
import { Client } from 'pg'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set`)
  return value
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase())
}

async function main() {
  const databaseUrl = requiredEnv('DATABASE_URL')
  const confirmed = parseBool(process.env.CONFIRM_DB_RESET)

  if (!confirmed) {
    console.error(
      [
        'Refusing to reset DB without confirmation.',
        'This will DROP SCHEMA public CASCADE and recreate it.',
        '',
        'Run:',
        '  CONFIRM_DB_RESET=1 npm run db:reset',
      ].join('\n'),
    )
    process.exit(1)
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    console.log('[db-reset] Dropping schema public (CASCADE)…')
    await client.query('DROP SCHEMA IF EXISTS public CASCADE;')
    console.log('[db-reset] Recreating schema public…')
    await client.query('CREATE SCHEMA public;')
    console.log('[db-reset] Done. Next: npm run migrate')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('[db-reset] Failed:', err)
  process.exit(1)
})

