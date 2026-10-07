import { BaseParser } from './BaseParser';
import { Ad } from '../types';
import { logger } from '../utils/logger';
import * as cheerio from 'cheerio';

export class AvParser extends BaseParser {
  platform = 'av' as const;

  async parseUrl(url: string): Promise<Ad[]> {
    logger.info('AV.by parsing started', { url });
    try {
      const html = await this.fetchWithRetry(url);
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
