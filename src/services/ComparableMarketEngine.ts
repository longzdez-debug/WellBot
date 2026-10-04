import { Ad } from '../types';
import { getMarketSignal, parseMarketPrice } from './MarketEngine';

export interface ComparableMarketResult {
  market_status: 'below_market' | 'market' | 'above_market' | null;
  market_percent: number | null;
  market_median: number | null;
  sample_size: number;
  confidence: 'low' | 'medium' | 'high' | null;
  comparable_count: number;
}

const STOP = new Set(['для','из','и','или','в','на','с','по','от','до','как','не','это','the','a','an','pro','новый','новая','новое','б/у','бу']);

function tokens(value: string | null | undefined): Set<string> {
  return new Set((value || '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(x => x.length >= 2 && !STOP.has(x)));
}

function titleSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.max(1, Math.min(left.size, right.size));
}

function comparableScore(current: Ad, candidate: Ad): number {
  const title = titleSimilarity(current.title, candidate.title);
  if (title <= 0) return 0;
  let score = title;
  if (current.location && candidate.location) {
    const a = current.location.toLocaleLowerCase('ru-RU');
    const b = candidate.location.toLocaleLowerCase('ru-RU');
    if (a === b || a.includes(b) || b.includes(a)) score += 0.15;
  }
  if (current.condition && candidate.condition && current.condition === candidate.condition) score += 0.08;
  return Math.min(1, score);
}

export function getComparableMarketSignal(current: Ad, history: Ad[], minimumSampleSize = 8): ComparableMarketResult {
  const currentPrice = parseMarketPrice(current.price);
  if (!currentPrice) return { market_status: null, market_percent: null, market_median: null, sample_size: 0, confidence: null, comparable_count: 0 };

  const ranked = history
    .filter(item => item.external_id !== current.external_id)
    .map(item => ({ item, score: comparableScore(current, item), parsed: parseMarketPrice(item.price) }))
    .filter(x => x.score >= 0.28 && x.parsed?.currency === currentPrice.currency)
    .sort((a, b) => b.score - a.score || ((b.item.published_at?.getTime?.() || 0) - (a.item.published_at?.getTime?.() || 0)));

  let selected = ranked.slice(0, 60);
  if (selected.length < minimumSampleSize) {
    selected = history
      .map(item => ({ item, score: 0, parsed: parseMarketPrice(item.price) }))
      .filter(x => x.parsed?.currency === currentPrice.currency)
      .slice(0, 250);
  }

  const values = selected.map(x => x.parsed?.amount).filter((x): x is number => Number.isFinite(x));
  if (values.length < minimumSampleSize) {
    return { market_status: null, market_percent: null, market_median: null, market_sample_size: values.length, confidence: null, comparable_count: ranked.length } as ComparableMarketResult & { market_sample_size?: number };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const cut = sorted.length >= 12 ? Math.max(1, Math.floor(sorted.length * 0.1)) : 0;
  const trimmed = sorted.slice(cut, sorted.length - cut);
  const middle = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 ? trimmed[middle] : (trimmed[middle - 1] + trimmed[middle]) / 2;
  const percent = Number((((currentPrice.amount - median) / median) * 100).toFixed(1));
  const status = percent <= -15 ? 'below_market' : percent >= 15 ? 'above_market' : 'market';
  const confidence = values.length >= 40 ? 'high' : values.length >= 15 ? 'medium' : 'low';

  return {
    market_status: status,
    market_percent: percent,
    market_median: Number(median.toFixed(2)),
    sample_size: values.length,
    confidence,
    comparable_count: ranked.length,
  };
}
