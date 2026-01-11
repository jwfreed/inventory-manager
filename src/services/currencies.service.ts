import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';

/**
 * Fetch exchange rate for a specific currency pair and date
 * Looks up the most recent rate on or before the given date
 */
export async function getExchangeRate(
  fromCurrency: string,
  toCurrency: string,
  effectiveDate: Date = new Date()
): Promise<number | null> {
  // If same currency, rate is 1.0
  if (fromCurrency === toCurrency) {
    return 1.0;
  }

  const result = await query(
    `SELECT rate
     FROM exchange_rates
     WHERE from_currency = $1
       AND to_currency = $2
       AND effective_date <= $3
     ORDER BY effective_date DESC
     LIMIT 1`,
    [fromCurrency, toCurrency, effectiveDate.toISOString().split('T')[0]]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return Number(result.rows[0].rate);
}

/**
 * Create or update an exchange rate for a specific date
 */
export async function upsertExchangeRate(
  fromCurrency: string,
  toCurrency: string,
  rate: number,
  effectiveDate: Date,
  source: string = 'manual'
): Promise<void> {
  await query(
    `INSERT INTO exchange_rates (id, from_currency, to_currency, rate, effective_date, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (from_currency, to_currency, effective_date)
     DO UPDATE SET rate = $4, source = $6, created_at = NOW()`,
    [uuidv4(), fromCurrency, toCurrency, rate, effectiveDate.toISOString().split('T')[0], source]
  );
}

/**
 * Get all active currencies
 */
export async function getActiveCurrencies(): Promise<Array<{
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
}>> {
  const result = await query(
    `SELECT code, name, symbol, decimal_places
     FROM currencies
     WHERE active = true
     ORDER BY code`
  );

  return result.rows.map(row => ({
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    decimalPlaces: row.decimal_places
  }));
}

/**
 * Convert amount from one currency to another using latest rate
 */
export async function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  effectiveDate: Date = new Date()
): Promise<number | null> {
  const rate = await getExchangeRate(fromCurrency, toCurrency, effectiveDate);
  
  if (rate === null) {
    return null;
  }

  return amount * rate;
}
