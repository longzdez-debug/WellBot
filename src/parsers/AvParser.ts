import { BaseParser } from './BaseParser';
import { Ad } from '../types';
import { logger } from '../utils/logger';
import * as cheerio from 'cheerio';

export class AvParser extends BaseParser {
  platform = 'av' as const;

  private async fetchAvHtml(url: string): Promise<string> {
    const parsed = new URL(url);
    const hosts = [parsed.hostname, 'av.by', 'm.av.by'].filter((host, index, all) => all.indexOf(host) === index);
    let lastError: unknown = null;

    for (const host of hosts) {
      const candidate = new URL(url);
      candidate.hostname = host;
      try {
        const response = await this.axiosInstance.get(candidate.toString(), {
          timeout: 5000,
          headers: {
            'User-Agent': this.getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://av.by/',
            'Host': host,
            'Cache-Control': 'no-cache',
          },
          validateStatus: status => status >= 200 && status < 500,
        });
        if (response.status === 200 && typeof response.data === 'string') {
          if (host !== parsed.hostname) {
            logger.info('AV.by fallback host succeeded', { originalHost: parsed.hostname, host });
          }
          return response.data;
        }
        if (response.status === 403) {
          logger.warn('AV.by host rejected automated request', { host, status: response.status });
          lastError = new Error(`AV.by returned HTTP 403 for ${host}`);
          continue;
        }
        lastError = new Error(`AV.by returned HTTP ${response.status} for ${host}`);
      } catch (error) {
        lastError = error;
        logger.warn('AV.by host request failed', {
          host,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error('AV.by request failed');
  }

  async parseUrl(url: string): Promise<Ad[]> {
    logger.info('AV.by parsing started', { url });
    try {
      const html = await this.fetchAvHtml(url);
      const $ = cheerio.load(html);
      const nextData = $('#__NEXT_DATA__').html();

      if (!nextData) {
        logger.warn('Could not find __NEXT_DATA__ on av.by page', { url });
        return [];
      }

      const data = JSON.parse(nextData);
      
      // Defensive: Next.js state path may vary depending on the page
      const ads = (data.props?.initialState?.filter?.main?.adverts as any[])
        || (data.props?.initialState?.ads as any[])
        || [];

      if (!Array.isArray(ads) || ads.length === 0) {
        logger.warn('Could not find ads in __NEXT_DATA__ on av.by page', { url });
        return [];
      }

      // Сортируем объявления по дате публикации (от новых к старым)
      ads.sort((a: any, b: any) => {
        const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return dateB - dateA;
      });

      const validAds=ads.filter((ad:any)=>ad?.id!=null&&String(ad.id).trim()!=='');
      return validAds.map((ad: any) => {
        // Формируем цену из доступной валюты
        let priceStr = 'Договорная';
        if (ad.price) {
          const amount = ad.price.byn?.amount ?? ad.price.usd?.amount ?? ad.price.rub?.amount ?? ad.price.eur?.amount;
          const currency = ad.price.byn?.currency ?? ad.price.usd?.currency ?? ad.price.rub?.currency ?? ad.price.eur?.currency ?? '';
          if (amount != null) {
            priceStr = `${amount} ${currency}`;
          }
        }

        // Формируем заголовок
        let title = '';
        const brand = ad.properties?.find((p: any) => p.name === 'brand')?.value;
        const model = ad.properties?.find((p: any) => p.name === 'model')?.value;
        const year = ad.properties?.find((p: any) => p.name === 'year')?.value;
        const parts = [year, brand, model].filter(Boolean);
        title = parts.length > 0 ? parts.join(' ') : (ad.metadata?.vinInfo?.vin ? `Автомобиль ${ad.metadata.vinInfo.vin}` : 'Автомобиль');

        // Формируем URL объявления
        const adUrl = ad.publicUrl ? `https://cars.av.by${ad.publicUrl}` : `https://cars.av.by/search/?q=${encodeURIComponent(ad.metadata?.vinInfo?.vin || title || '')}`;

        return {
          external_id: `av_${ad.id}`,
          title,
          description: ad.description || undefined,
          price: priceStr,
          image_url: ad.photos?.[0]?.medium?.url ?? ad.photos?.[0]?.url,
          ad_url: adUrl,
          location: ad.locationName,
          published_at: ad.publishedAt ? new Date(ad.publishedAt) : undefined,
        };
      });
    } catch (error: any) {
      logger.error('av.by parsing failed', { url, error: error.message });
      throw error;
    }
  }
}
