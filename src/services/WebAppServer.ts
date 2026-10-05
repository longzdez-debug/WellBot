import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { DatabaseService } from '../database/DatabaseService';
import { logger } from '../utils/logger';
import { KUFAR_CATALOG, MonitorConfig, buildKufarSearchUrl, findCatalogNode, findCatalogCategory } from '../catalog/KufarCatalog';
import { MARKETPLACE_CATALOGS, MARKETPLACES, MarketplaceSource, buildMarketplaceSearchUrl, findMarketplaceNode, findMarketplaceCategory } from '../catalog/MarketplaceCatalog';
import { KUFAR_PHONE_BRANDS, KUFAR_PHONE_FILTERS, isKufarPhoneCategory } from '../catalog/KufarPhoneCatalog';

const isCatalogDescendant=(id:string,root:{children?:Array<{id:string;children?:any[]}>}):boolean=>{const walk=(nodes:any[]):boolean=>nodes.some(n=>n.id===id||(n.children&&walk(n.children)));return walk(root.children||[])};

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const MAX_BODY = 16 * 1024;
const MAX_INIT_DATA = 16 * 1024;
const MAX_LINKS = 50;
const AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;
const PHONE_MODEL_CACHE=new Map<string,{expires:number;models:{id:string;title:string;slug:string}[]}>();
const PHONE_MODEL_TTL=30*60*1000;

async function getKufarPhoneModels(brand:string){
  const key=brand.toLowerCase();
  const cached=PHONE_MODEL_CACHE.get(key);
  if(cached&&cached.expires>Date.now()) return cached.models;
  const response=await fetch('https://www.kufar.by/l/mobilnye-telefony/mt~'+encodeURIComponent(key),{headers:{'User-Agent':'WellBOT/2.0 catalog'}});
  if(!response.ok) throw new Error('kufar_catalog_unavailable');
  const html=await response.text();
  const found=new Map<string,{id:string;title:string;slug:string}>();
  const re=new RegExp("href=[\"'](?:https?:\\/\\/www\\.kufar\\.by)?\\/l\\/mobilnye-telefony\\/mt~([^\"'?#]+)[\"'][^>]*>([^<]{2,100})<\\/a>","gi");
  let match;
  while((match=re.exec(html))){
    const raw=decodeURIComponent(match[1]).trim();
    if(!raw.toLowerCase().startsWith(key+'-')) continue;
    const slug=raw.slice(key.length+1);
    const title=match[2].replace(/\s+/g,' ').trim();
    if(slug&&title) found.set(slug,{id:key+'-'+slug,title,slug});
  }
  const models=[...found.values()].sort((a,b)=>a.title.localeCompare(b.title,'ru'));
  PHONE_MODEL_CACHE.set(key,{expires:Date.now()+PHONE_MODEL_TTL,models});
  return models;
}

type AuthUser = { id: number; username?: string; first_name?: string; last_name?: string };
type TelegramInitData = { user: AuthUser; authDate: number };

export function parseTelegramInitData(raw: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): TelegramInitData | null {
  if (!raw || !botToken || raw.length > MAX_INIT_DATA) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    const userRaw = params.get('user');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
    if (!Number.isSafeInteger(authDate) || authDate <= 0 || !userRaw) return null;
    const age = nowSeconds - authDate;
    if (age < -300 || age > AUTH_MAX_AGE_SECONDS) return null;
    const dataCheckString = [...params.entries()].filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
    const actual = Buffer.from(hash, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) return null;
    const user = JSON.parse(userRaw) as AuthUser;
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return { user, authDate };
  } catch { return null; }
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  applySecurityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function prometheus(metrics: any): string {
  const lines = [
    '# HELP wellbot_scheduler_running Whether the parser scheduler is running.',
    '# TYPE wellbot_scheduler_running gauge',
    `wellbot_scheduler_running ${metrics?.scheduler?.running ? 1 : 0}`,
    '# HELP wellbot_scheduler_cycles_total Completed parser cycles.',
    '# TYPE wellbot_scheduler_cycles_total counter',
    `wellbot_scheduler_cycles_total ${Number(metrics?.scheduler?.cycles || 0)}`,
    '# HELP wellbot_scheduler_cycle_failures_total Parser cycle failures.',
    '# TYPE wellbot_scheduler_cycle_failures_total counter',
    `wellbot_scheduler_cycle_failures_total ${Number(metrics?.scheduler?.failures || 0)}`,
    '# HELP wellbot_scheduler_active_links Active monitors.',
    '# TYPE wellbot_scheduler_active_links gauge',
    `wellbot_scheduler_active_links ${Number(metrics?.scheduler?.activeLinks || 0)}`,
    '# HELP wellbot_scheduler_freshness_oldest_ms Age of the oldest active monitor checkpoint.',
    '# TYPE wellbot_scheduler_freshness_oldest_ms gauge',
    `wellbot_scheduler_freshness_oldest_ms ${Number(metrics?.scheduler?.freshnessLagMs?.oldest || 0)}`,
    '# HELP wellbot_notifications_pending Pending notification jobs.',
    '# TYPE wellbot_notifications_pending gauge',
    `wellbot_notifications_pending ${Number(metrics?.notifications?.pending || 0)}`,
    '# HELP wellbot_notifications_sent_total Notifications delivered.',
    '# TYPE wellbot_notifications_sent_total counter',
    `wellbot_notifications_sent_total ${Number(metrics?.notifications?.sent || 0)}`,
    '# HELP wellbot_notifications_failed_total Notification delivery failures.',
    '# TYPE wellbot_notifications_failed_total counter',
    `wellbot_notifications_failed_total ${Number(metrics?.notifications?.failed || 0)}`,
    '# HELP wellbot_new_ads_total New ads detected.',
    '# TYPE wellbot_new_ads_total counter',
    `wellbot_new_ads_total ${Number(metrics?.newAds || 0)}`,
    '# HELP wellbot_price_drops_total Price drops detected.',
    '# TYPE wellbot_price_drops_total counter',
    `wellbot_price_drops_total ${Number(metrics?.priceDrops || 0)}`,
  ];
  return lines.join('\\n') + '\\n';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  let body = '';
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY) throw new Error('body_too_large');
    body += part.toString('utf8');
  }
  const parsed: unknown = JSON.parse(body || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
  return parsed as Record<string, unknown>;
}

export async function startWebAppServer(port: number, db: DatabaseService, botToken: string, webRoot = join(process.cwd(), 'web'), metricsProvider?: () => unknown | Promise<unknown>): Promise<{ close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    let requestPath = '';
    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      requestPath = decodeURIComponent(requestUrl.pathname);

      if (requestPath === '/health' || requestPath === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); json(res, 405, { error: 'method_not_allowed' }); return; }
        if (req.method === 'HEAD') { applySecurityHeaders(res); res.statusCode = 200; res.setHeader('Cache-Control', 'no-store'); res.end(); return; }
        json(res, 200, { status: 'ok', service: 'wellbot-web' }); return;
      }

      if (requestPath === '/metrics' && req.method === 'GET') {
        const metrics = metricsProvider ? await metricsProvider() : {};
        applySecurityHeaders(res);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(prometheus(metrics));
        return;
      }

      if (requestPath.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
          res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
          json(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const initData = req.headers['x-telegram-init-data'];
        const auth = parseTelegramInitData(typeof initData === 'string' ? initData : '', botToken);
        if (!auth) { logger.warn('WellBOT API unauthorized request', { requestPath, method: req.method }); json(res, 401, { error: 'unauthorized' }); return; }
        const user = await db.getUser(auth.user.id);
        if (!user) { logger.warn('WellBOT API user not registered', { telegramId: auth.user.id, requestPath }); json(res, 403, { error: 'user_not_registered' }); return; }

        if (requestPath === '/api/metrics' && req.method === 'GET') { json(res, 200, metricsProvider ? await metricsProvider() : { scheduler: { running: false }, notifications: {}, generatedAt: new Date().toISOString() }); return; }

        if (requestPath === '/api/bootstrap' && req.method === 'GET') {
          const [links, ads, priceDrops, stats, statsByLink] = await Promise.all([
            db.getUserLinks(user.id), db.getDashboardAds(user.id, 50), db.getDashboardPriceDrops(user.id, 30),
            db.getDashboardStats(user.id), db.getUserAdsCount(user.id),
          ]);
          logger.info('WellBOT bootstrap', { telegramId: auth.user.id, dbUserId: user.id, links: links.length, activeLinksFromLinks: links.filter(link => link.is_active).length, inactiveLinksFromLinks: links.filter(link => !link.is_active).length, ads: ads.length, priceDrops: priceDrops.length, totalLinks: stats.totalLinks, activeLinks: stats.activeLinks });
          json(res, 200, { user: { id: user.id, telegramId: user.telegram_id, username: user.username }, links, ads, priceDrops, stats, statsByLink, serverTime: new Date().toISOString() });
          return;
        }

        if (requestPath === '/api/catalog/phone-models' && req.method === 'GET') {
          const brand=String(requestUrl.searchParams.get('brand')||'').toLowerCase();
          if(!KUFAR_PHONE_BRANDS.some(x=>x.id===brand)){json(res,400,{error:'invalid_brand',message:'Выберите производителя из каталога Kufar.'});return;}
          try { json(res,200,{brand,models:await getKufarPhoneModels(brand)}); }
          catch(error){ logger.warn('Kufar phone model catalog unavailable',{brand,error:error instanceof Error?error.message:String(error)}); json(res,200,{brand,models:[]}); }
          return;
        }

        if (requestPath === '/api/catalog' && req.method === 'GET') {
          json(res, 200, { marketplaces: MARKETPLACES, catalogs: { kufar: KUFAR_CATALOG, onliner: MARKETPLACE_CATALOGS.onliner, av: MARKETPLACE_CATALOGS.av }, phoneBrands: KUFAR_PHONE_BRANDS, phoneFilters: KUFAR_PHONE_FILTERS });
          return;
        }

        if (requestPath === '/api/monitors' && req.method === 'POST') {
          let body: Record<string, unknown>;
          try { body = await readJson(req); }
          catch (error: unknown) { json(res, error instanceof Error && error.message === 'body_too_large' ? 413 : 400, { error: 'invalid_json' }); return; }
          const config = body as unknown as MonitorConfig;
          const source = config.source as MarketplaceSource;
          if (!['kufar','onliner','av'].includes(source)) { json(res,400,{error:'invalid_source',message:'Выберите площадку.'}); return; }
          const node = source==='kufar' ? findCatalogNode(config.categoryId) : findMarketplaceNode(source,config.categoryId);
          if (typeof config.categoryId!=='string' || !node || node.searchable===false) { json(res,400,{error:'invalid_category',message:'Выберите категорию из каталога WellBOT.'}); return; }
          const category = source==='kufar' ? findCatalogCategory(config.categoryId) : findMarketplaceCategory(source,config.categoryId);
          if (node.children?.length && !config.subcategoryId) { json(res,400,{error:'subcategory_required',message:'Выберите подкатегорию.'}); return; }
          if (config.subcategoryId) {
            const child = source==='kufar' ? findCatalogNode(config.subcategoryId) : findMarketplaceNode(source,config.subcategoryId);
            if (!child || child.searchable===false || !category || category.id!==config.categoryId || isCatalogDescendant(child.id, category)) { json(res,400,{error:'invalid_subcategory',message:'Выберите подкатегорию из выбранной категории.'}); return; }
          }
          if (config.condition && config.condition!=='new' && config.condition!=='used') { json(res,400,{error:'invalid_condition'}); return; }
          if (config.seller && config.seller!=='private' && config.seller!=='company') { json(res,400,{error:'invalid_seller'}); return; }
          if (config.minMarketDiscount!=null && (!Number.isFinite(Number(config.minMarketDiscount)) || Number(config.minMarketDiscount)<0 || Number(config.minMarketDiscount)>90)) { json(res,400,{error:'invalid_market_discount',message:'Минимальная скидка от рынка должна быть от 0 до 90%.'}); return; }
          if (config.skipSlots!=null && (!Number.isSafeInteger(Number(config.skipSlots)) || Number(config.skipSlots)<0 || Number(config.skipSlots)>100)) { json(res,400,{error:'invalid_skip_slots',message:'Пропуск слотов должен быть от 0 до 100.'}); return; }
          if (config.mode && config.mode!=='normal' && config.mode!=='sniper') { json(res,400,{error:'invalid_mode'}); return; }
          if (config.brand!=null && (typeof config.brand!=='string' || config.brand.length>60 || !KUFAR_PHONE_BRANDS.some(x=>x.id===String(config.brand).toLowerCase()))) { json(res,400,{error:'invalid_brand',message:'Производитель не найден в каталоге Kufar.'}); return; }
          if (config.model!=null && (typeof config.model!=='string' || config.model.length>100)) { json(res,400,{error:'invalid_model',message:'Модель слишком длинная.'}); return; }
          if ((config.brand||config.model||config.phoneFilters) && source!=='kufar') { json(res,400,{error:'phone_filters_only_kufar'}); return; }
          if ((config.brand||config.model||config.phoneFilters) && !isKufarPhoneCategory(config.categoryId,config.subcategoryId)) { json(res,400,{error:'phone_filters_wrong_category',message:'Фильтры телефона доступны только для мобильных телефонов Kufar.'}); return; }
          if (config.query!=null && (typeof config.query!=='string' || config.query.length>120)) { json(res,400,{error:'invalid_query'}); return; }
          if (config.minPrice!=null && (!Number.isFinite(Number(config.minPrice)) || Number(config.minPrice)<0)) { json(res,400,{error:'invalid_min_price'}); return; }
          if (config.maxPrice!=null && (!Number.isFinite(Number(config.maxPrice)) || Number(config.maxPrice)<0)) { json(res,400,{error:'invalid_max_price'}); return; }
          if (config.minPrice!=null && config.maxPrice!=null && Number(config.minPrice)>Number(config.maxPrice)) { json(res,400,{error:'invalid_price_range'}); return; }
          const links=await db.getUserLinks(user.id);
          const url=source==='kufar' ? buildKufarSearchUrl(config) : buildMarketplaceSearchUrl(source,config);
          const existing=links.find(link=>link.url===url);
          if(existing){
            if(!existing.is_active){
              const activeLinks=links.filter(link=>link.is_active);
              if(activeLinks.length>=MAX_LINKS){json(res,409,{error:'limit_reached',message:`Достигнут лимит в ${MAX_LINKS} активных поисков.`});return;}
              const reactivated=await db.createLink(user.id,url,source,config);
              json(res,200,{link:reactivated,reactivated:true});return;
            }
            json(res,409,{error:'duplicate',message:'Такой поиск уже добавлен.'});return;
          }
          const activeLinks=links.filter(link=>link.is_active);
          if(activeLinks.length>=MAX_LINKS){json(res,409,{error:'limit_reached',message:`Достигнут лимит в ${MAX_LINKS} активных поисков.`});return;}
          const link=await db.createLink(user.id,url,source,config);
          logger.info('WellBOT marketplace monitor created',{telegramId:auth.user.id,dbUserId:user.id,linkId:link.id,source,categoryId:config.categoryId,subcategoryId:config.subcategoryId||null});
          json(res,201,{link,config});return;
        }

        const dismissMatch = requestPath.match(/^\/api\/ads\/(\d+)\/dismiss$/);
        if (dismissMatch && req.method === 'POST') {
          const adId = Number(dismissMatch[1]);
          if (!Number.isSafeInteger(adId) || adId <= 0) { json(res, 400, { error: 'invalid_ad_id' }); return; }
          const ok = await db.dismissAdForUser(adId, user.id);
          if (!ok) { json(res, 404, { error: 'not_found' }); return; }
          logger.info('WellBOT ad dismissed', { telegramId: auth.user.id, dbUserId: user.id, adId });
          json(res, 200, { ok: true, adId });
          return;
        }

        if (requestPath === '/api/links' && req.method === 'POST') {
          json(res, 410, { error: 'url_monitors_disabled', message: 'Создание поиска по ссылке отключено. Используйте каталог WellBOT.' });
          return;
        }

        const linkMatch = requestPath.match(/^\/api\/links\/(\d+)$/);
        if (linkMatch && req.method === 'PATCH') {
          let body: Record<string, unknown>;
          try { body = await readJson(req); }
          catch (error: unknown) { json(res, error instanceof Error && error.message === 'body_too_large' ? 413 : 400, { error: error instanceof Error && error.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' }); return; }
          if (typeof body.is_active !== 'boolean') { json(res, 400, { error: 'is_active_required' }); return; }
          if (body.is_active) {
            const activeLinks = (await db.getUserLinks(user.id)).filter(link => link.is_active && link.id !== Number(linkMatch[1]));
            if (activeLinks.length >= MAX_LINKS) { json(res, 409, { error: 'limit_reached', message: `Достигнут лимит в ${MAX_LINKS} активных поисков.` }); return; }
          }
          const ok = await db.setLinkActive(Number(linkMatch[1]), user.id, body.is_active);
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not_found' }); return;
        }
        if (linkMatch && req.method === 'DELETE') {
          const linkId = Number(linkMatch[1]);
          const linkBeforeDelete = await db.getLinkForUser(linkId, user.id);
          const ok = await db.deleteLink(linkId, user.id);
          logger.info('WellBOT monitor delete requested', { telegramId: auth.user.id, dbUserId: user.id, linkId, existed: Boolean(linkBeforeDelete), deleted: ok });
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not_found' }); return;
        }
        json(res, 404, { error: 'not_found' }); return;
      }

      if (requestPath === '/' && req.method === 'HEAD') { applySecurityHeaders(res); res.statusCode = 200; res.setHeader('Cache-Control', 'no-store'); res.end(); return; }
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET, HEAD'); json(res, 405, { error: 'method_not_allowed' }); return; }
      const relativePath = requestPath === '/' ? '/index.html' : requestPath;
      const normalizedPath = normalize(relativePath).replace(/^[/\\]+/, '');
      if (normalizedPath.startsWith('..')) { json(res, 400, { error: 'bad_request' }); return; }
      const filePath = join(webRoot, normalizedPath);
      const body = await readFile(filePath);
      const extension = extname(filePath).toLowerCase();
      applySecurityHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
      res.setHeader('Cache-Control', extension === '.html' ? 'no-cache' : 'public, max-age=300');
      res.end(body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'body_too_large') { json(res, 413, { error: 'body_too_large' }); return; }
      if (requestPath.startsWith('/api/')) { logger.error('WellBOT API request failed', { requestPath, error: message }); json(res, 500, { error: 'internal_error' }); return; }
      res.statusCode = 404;
      applySecurityHeaders(res);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      logger.error('WellBOT WebApp server error', {
        port,
        host: '0.0.0.0',
        error: error.message,
        code: (error as NodeJS.ErrnoException).code,
      });
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      const address = server.address();
      logger.info('WellBOT WebApp server started', { port, host: '0.0.0.0', webRoot, address });
      resolve();
    });
    logger.info('WellBOT WebApp server binding', { port, host: '0.0.0.0' });
    server.listen(port, '0.0.0.0');
  });
  return { close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))) };
}
