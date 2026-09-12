import { Platform } from '../types';

export interface AssessmentResult {
  platform: Platform | null;
  ok: boolean;
  reason?: string;
}

const isHost = (hostname: string, domain: string): boolean => hostname === domain || hostname.endsWith(`.${domain}`);

export class LinkAcceptance {
  static assess(url: string): AssessmentResult {
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch {
      return { platform: null, ok: false, reason: 'Некорректный URL' };
    }

    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return { platform: null, ok: false, reason: 'Разрешены только HTTP/HTTPS ссылки' };
    }
    if (urlObj.username || urlObj.password) {
      return { platform: null, ok: false, reason: 'URL с логином или паролем не поддерживается' };
    }

    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = urlObj.pathname;

    if (isHost(hostname, 'kufar.by')) {
      if (pathname.startsWith('/l/') || pathname.startsWith('/re/')) return { platform: 'kufar', ok: true };
      return { platform: 'kufar', ok: false, reason: 'Это ссылка на конкретное объявление. Нужна ссылка на страницу поиска с фильтрами.' };
    }

    if (isHost(hostname, 'onliner.by')) {
      if (hostname === 'baraholka.onliner.by' || hostname === 'ab.onliner.by' || hostname === 'r.onliner.by') {
        return { platform: 'onliner', ok: true };
      }
      return { platform: 'onliner', ok: false, reason: 'Нужна ссылка на Барахолку, Авто или Недвижимость Onliner.' };
    }

    if (isHost(hostname, 'av.by')) {
      if (hostname === 'cars.av.by' || hostname === 'av.by') return { platform: 'av', ok: true };
      return { platform: 'av', ok: false, reason: 'Нужна ссылка на страницу поиска автомобилей (cars.av.by).' };
    }

    return { platform: null, ok: false, reason: 'Неподдерживаемая площадка' };
  }
}
