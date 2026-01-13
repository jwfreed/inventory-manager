import { ensureCurrenciesExist, upsertExchangeRate } from '../services/currencies.service';

/**
 * In-memory job lock to prevent overlapping runs
 */
let isRunning = false;
let lastRunTime: Date | null = null;
let lastRunDuration: number | null = null;

interface ExchangeRateApiResponse {
  base: string;
  rates: Record<string, number>;
  date: string;
}

/**
 * Fetch latest exchange rates from a free API
 * 
 * Using exchangerate-api.com free tier (1,500 requests/month)
 * Alternative: frankfurter.app (ECB data, no API key required)
 * 
 * For production with high volume, consider:
 * - Open Exchange Rates (paid)
 * - Currency Layer (paid)
 * - European Central Bank API (free but Euro-based)
 */
async function fetchExchangeRatesFromApi(): Promise<ExchangeRateApiResponse | null> {
  try {
    // Using frankfurter.app (free, no API key, ECB data)
    const response = await fetch('https://api.frankfurter.app/latest?base=USD');
    
    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`);
    }

    const data = await response.json();
    
    return {
      base: data.base,
      rates: data.rates,
      date: data.date
    };
  } catch (error) {
    console.error('Failed to fetch exchange rates from API:', error);
    return null;
  }
}

/**
 * Sync exchange rates from external API
 * 
 * Runs daily at 06:00 UTC
 * 
 * Tasks:
 * 1. Fetch latest rates from API
 * 2. Upsert rates into exchange_rates table
 * 3. Create inverse rates for common conversions
 */
export async function syncExchangeRates(): Promise<void> {
  // Check job lock
  if (isRunning) {
    console.warn('⚠️  Exchange rate sync already running, skipping');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    console.log('📊 Fetching latest exchange rates...');

    const apiData = await fetchExchangeRatesFromApi();

    if (!apiData) {
      console.error('❌ Failed to fetch exchange rates from API');
      return;
    }

    const effectiveDate = new Date(apiData.date);
    const baseCurrency = apiData.base;
    let ratesUpdated = 0;

    console.log(`   Base currency: ${baseCurrency}`);
    console.log(`   Effective date: ${apiData.date}`);
    console.log(`   Rates received: ${Object.keys(apiData.rates).length}`);

    await ensureCurrenciesExist([baseCurrency, ...Object.keys(apiData.rates)]);

    // Upsert rates from base currency to each target
    for (const [targetCurrency, rate] of Object.entries(apiData.rates)) {
      await upsertExchangeRate(
        baseCurrency,
        targetCurrency,
        rate,
        effectiveDate,
        'api:frankfurter'
      );
      ratesUpdated++;

      // Also create inverse rate for convenience
      await upsertExchangeRate(
        targetCurrency,
        baseCurrency,
        1 / rate,
        effectiveDate,
        'api:frankfurter'
      );
      ratesUpdated++;
    }

    lastRunTime = new Date();
    lastRunDuration = Date.now() - startTime;

    console.log(`✅ Synced ${ratesUpdated} exchange rates in ${lastRunDuration}ms`);
  } catch (error) {
    console.error('❌ Exchange rate sync failed:', error);
    throw error;
  } finally {
    isRunning = false;
  }
}

/**
 * Get job status
 */
export function getExchangeRateSyncStatus() {
  return {
    isRunning,
    lastRunTime,
    lastRunDuration
  };
}
