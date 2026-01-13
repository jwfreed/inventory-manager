import { query } from '../db';

const DEFAULT_BASE_CURRENCY = process.env.BASE_CURRENCY || 'THB';

export async function getUserBaseCurrency(userId: string): Promise<string> {
  const result = await query('SELECT base_currency FROM users WHERE id = $1', [userId]);
  const baseCurrency = result.rows[0]?.base_currency;
  return baseCurrency || DEFAULT_BASE_CURRENCY;
}
