import { Ad } from '../types';
import { parseMarketPrice } from './MarketEngine';

export interface DealAnalysis {
  score: number | null;
  buyPrice: number | null;
  marketPrice: number | null;
  sellPrice: number | null;
  profit: number | null;
  roi: number | null;
  currency: string | null;
  reasons: string[];
}

export function analyzeDeal(ad: Ad): DealAnalysis {
  const current = parseMarketPrice(ad.price);
  const market = typeof ad.market_median === 'number' && Number.isFinite(ad.market_median) ? ad.market_median : null;
  if (!current) return { score: null, buyPrice: null, marketPrice: market, sellPrice: null, profit: null, roi: null, currency: null, reasons: [] };

  let score = 50;
  const reasons: string[] = [];

  if (typeof ad.market_percent === 'number' && ad.market_status) {
    const discount = -ad.market_percent;
    if (discount >= 35) { score += 35; reasons.push('сильно ниже рынка'); }
    else if (discount >= 25) { score += 28; reasons.push('существенно ниже рынка'); }
    else if (discount >= 15) { score += 20; reasons.push('ниже рынка'); }
    else if (ad.market_status === 'above_market') { score -= 25; reasons.push('выше рынка'); }
    else reasons.push('цена около рынка');
  }

  if (ad.is_company === false) { score += 5; reasons.push('частный продавец'); }
  if (ad.condition === 'used') score += 2;
  if (ad.condition === 'new') score += 4;

  if (ad.published_at) {
    const published = ad.published_at instanceof Date ? ad.published_at.getTime() : Date.parse(String(ad.published_at));
    if (Number.isFinite(published)) {
      const ageMinutes = Math.max(0, (Date.now() - published) / 60000);
      if (ageMinutes <= 5) { score += 8; reasons.push('только что опубликовано'); }
      else if (ageMinutes <= 30) score += 5;
      else if (ageMinutes <= 120) score += 2;
    }
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const sellPrice = market != null ? Number((market * 0.97).toFixed(2)) : null;
  const profit = sellPrice != null ? Number((sellPrice - current.amount).toFixed(2)) : null;
  const roi = profit != null && current.amount > 0 ? Number(((profit / current.amount) * 100).toFixed(1)) : null;

  return { score: finalScore, buyPrice: current.amount, marketPrice: market, sellPrice, profit, roi, currency: current.currency, reasons: reasons.slice(0, 3) };
}
