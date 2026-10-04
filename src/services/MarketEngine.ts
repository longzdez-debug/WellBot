export type MarketStatus = 'below_market' | 'market' | 'above_market' | null;

export interface MarketSignal {
  market_status: MarketStatus;
  market_percent: number | null;
  market_median: number | null;
  market_sample_size: number;
  market_confidence: 'low' | 'medium' | 'high' | null;
}

export interface ParsedPrice {
  amount: number;
  currency: string;
}

const CURRENCIES = 'BYN|USD|EUR|RUB|UAH|PLN';

export function parseMarketPrice(value: string | null | undefined): ParsedPrice | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, '').trim().toUpperCase();
  const match = text.match(new RegExp('([0-9]+(?:[.,][0-9]+)?)\\s*(' + CURRENCIES + ')\\b'));
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: match[2] };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trimmed(values: number[]): number[] {
  if (values.length < 12) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(sorted.length * 0.1));
  return sorted.slice(cut, sorted.length - cut);
}

function confidence(sampleSize: number): 'low' | 'medium' | 'high' {
  if (sampleSize >= 40) return 'high';
  if (sampleSize >= 15) return 'medium';
  return 'low';
}

export function getMarketSignal(price: string | null | undefined, history: string[], minimumSampleSize = 8): MarketSignal {
  const current = parseMarketPrice(price);
  if (!current) return { market_status: null, market_percent: null, market_median: null, market_sample_size: 0, market_confidence: null };

  const values = history
    .map(parseMarketPrice)
    .filter((item): item is ParsedPrice => item !== null && item.currency === current.currency)
    .map(item => item.amount)
    .filter(Number.isFinite);

  if (values.length < minimumSampleSize) {
    return { market_status: null, market_percent: null, market_median: null, market_sample_size: values.length, market_confidence: null };
  }

  const sample = trimmed(values);
  const marketMedian = median(sample);
  if (!Number.isFinite(marketMedian) || marketMedian <= 0) {
    return { market_status: null, market_percent: null, market_median: null, market_sample_size: values.length, market_confidence: null };
  }

  const percent = Number((((current.amount - marketMedian) / marketMedian) * 100).toFixed(1));
  const status: MarketStatus = percent <= -15 ? 'below_market' : percent >= 15 ? 'above_market' : 'market';

  return {
    market_status: status,
    market_percent: percent,
    market_median: Number(marketMedian.toFixed(2)),
    market_sample_size: values.length,
    market_confidence: confidence(values.length),
  };
}
