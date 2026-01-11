import { apiGet } from './http'

export type Currency = {
  code: string
  name: string
  symbol: string
  decimalPlaces: number
}

export async function getActiveCurrencies(): Promise<Currency[]> {
  return apiGet<Currency[]>('/api/currencies')
}

export async function getExchangeRate(
  fromCurrency: string,
  toCurrency: string,
  effectiveDate?: string
): Promise<{ rate: number | null }> {
  const params = new URLSearchParams({ fromCurrency, toCurrency })
  if (effectiveDate) params.set('effectiveDate', effectiveDate)
  
  return apiGet<{ rate: number | null }>(`/api/exchange-rates?${params.toString()}`)
}
