import { Ad } from '../types';
import { LocationService } from './LocationService';
import { analyzeDeal } from './DealScoreEngine';

export interface FormattedAd {
  text: string;
  media: string[];
  url?: string;
  externalId?: string;
  publishedAt?: string;
  createdAt?: string;
  location?: { lat: number; lon: number; title: string; address: string };
}

export class AdPresenter {
  private locationService: LocationService | null;
  private readonly MAX_DESCRIPTION_LENGTH = 430;

  constructor(locationService: LocationService | null = null) {
    this.locationService = locationService;
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private formatPrice(value?: string | null): string {
    return value?.trim() || 'Договорная';
  }

  private formatMarketMedian(price: string | null | undefined, median?: number | null): string | null {
    if (!median || !Number.isFinite(median)) return null;
    const match = price?.match(/(BYN|USD|EUR|RUB|UAH|PLN|р\.?|руб\.?|€|\$)/i);
    const currency = match?.[1] || '';
    return Math.round(median).toLocaleString('ru-RU') + (currency ? ' ' + currency : '');
  }

  private formatFreshness(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return minutes + ' мин назад';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' ч назад';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + ' дн назад';
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Minsk' });
  }

  private formatDescription(description?: string | null): string | null {
    if (!description?.trim()) return null;
    const normalized = description.replace(/\u0000/g, '').replace(/\r?\n/g, '\n').trim();
    if (!normalized) return null;
    const lines = normalized.split('\n').map(line => line.replace(/^[-•*]+\s*/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const important: string[] = [];
    const patterns = [
      /\b(состояни[ея]|состояние|идеальн|хорош|отличн|есть дефект|дефект|царапин|трещин|ремонт|не работает|рабоч)/i,
      /\b(комплект|комплектаци|коробк|зарядк|чек|гаранти|документ)/i,
      /\b(торг|обмен|срочно|забирать|доставка|самовывоз)/i,
    ];
    for (const line of lines) {
      if (patterns.some(pattern => pattern.test(line)) && !important.includes(line)) important.push(line);
    }
    const compact = important.slice(0, 3);
    if (compact.length) return compact.join(' · ');
    const oneLine = lines.join(' ');
    if (oneLine.length <= this.MAX_DESCRIPTION_LENGTH) return oneLine;
    return oneLine.slice(0, this.MAX_DESCRIPTION_LENGTH).trimEnd() + '…';
  }

  private getMarketBlock(ad: Ad): string | null {
    if (ad.market_status === 'below_market' && typeof ad.market_percent === 'number') {
      const percent = Math.abs(Math.round(ad.market_percent));
      const median = this.formatMarketMedian(ad.price, ad.market_median);
      return '🔥 <b>−' + percent + '% от рынка</b>' + (median ? '\n📊 Рынок: ~' + this.escapeHtml(median) : '');
    }
    if (ad.market_status === 'above_market' && typeof ad.market_percent === 'number') {
      const percent = Math.abs(Math.round(ad.market_percent));
      const median = this.formatMarketMedian(ad.price, ad.market_median);
      return '⚠️ <b>+' + percent + '% выше рынка</b>' + (median ? '\n📊 Рынок: ~' + this.escapeHtml(median) : '');
    }
    if (ad.market_status === 'market') {
      const median = this.formatMarketMedian(ad.price, ad.market_median);
      return '🟢 <b>Цена около рынка</b>' + (median ? '\n📊 Рынок: ~' + this.escapeHtml(median) : '');
    }
    return null;
  }

  async format(ad: Ad): Promise<FormattedAd> {
    const lines: string[] = [
      '<b>' + this.escapeHtml(ad.title) + '</b>',
      '<b>💰 ' + this.escapeHtml(this.formatPrice(ad.price)) + '</b>',
    ];

    const marketBlock = this.getMarketBlock(ad);
    if (marketBlock) lines.push(marketBlock);

    const deal = analyzeDeal(ad);
    if (deal.score !== null && deal.score >= 65) {
      lines.push('🎯 <b>Deal Score: ' + deal.score + '/100</b>');
      if (deal.profit !== null && deal.profit > 0 && deal.sellPrice !== null) {
        const currency = deal.currency || '';
        lines.push('💰 Ориентир продажи: ~' + Math.round(deal.sellPrice).toLocaleString('ru-RU') + ' ' + currency + ' · потенциал: <b>+' + Math.round(deal.profit).toLocaleString('ru-RU') + ' ' + currency + '</b>');
      }
      if (deal.reasons.length) lines.push('💡 ' + deal.reasons.map(reason => this.escapeHtml(reason)).join(' · '));
    }

    const meta: string[] = [];
    if (ad.location) meta.push('📍 ' + this.escapeHtml(ad.location));
    if (ad.condition) meta.push('🏷 ' + this.escapeHtml(ad.condition));
    if (ad.is_company === true) meta.push('🏢 Магазин');
    else if (ad.is_company === false) meta.push('👤 Частное лицо');
    if (meta.length) lines.push(meta.join(' · '));

    const freshness = this.formatFreshness(ad.published_at);
    if (freshness) lines.push('🕐 ' + freshness);

    const description = this.formatDescription(ad.description);
    if (description) lines.push('\n<b>Описание</b>\n' + this.escapeHtml(description));

    const addressParts: string[] = [];
    if (ad.location) addressParts.push(ad.location);
    if (ad.address) addressParts.push(ad.address);
    const fullAddress = addressParts.join(', ');

    const media: string[] = [];
    if (ad.image_url) media.push(ad.image_url);

    let location: FormattedAd['location'];
    if (fullAddress && this.locationService) {
      try {
        const coords = await this.locationService.getCoordinates(ad.address, fullAddress, ad.location);
        if (coords) location = { lat: coords.lat, lon: coords.lon, title: ad.title, address: fullAddress };
      } catch {}
    }

    const publishedAt = ad.published_at instanceof Date ? ad.published_at.toISOString() : ad.published_at ? new Date(ad.published_at).toISOString() : undefined;
    const createdAt = ad.created_at instanceof Date ? ad.created_at.toISOString() : ad.created_at ? new Date(ad.created_at).toISOString() : undefined;

    return { text: lines.join('\n'), media, url: ad.ad_url, externalId: ad.external_id, publishedAt, createdAt, location };
  }
}
