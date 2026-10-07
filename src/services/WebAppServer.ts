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
const API_RATE_WINDOW_MS=60_000;
const API_RATE_LIMIT=180;
const apiRateLimits=new Map<number,{windowStarted:number;count:number}>();
function allowApiRequest(telegramId:number):boolean{
  const now=Date.now();
  const current=apiRateLimits.get(telegramId);
  if(!current||now-current.windowStarted>=API_RATE_WINDOW_MS){
    apiRateLimits.set(telegramId,{windowStarted:now,count:1});
    return true;
  }
  if(current.count>=API_RATE_LIMIT) return false;
  current.count+=1;
  return true;
}
function pruneApiRateLimits():void{
  const cutoff=Date.now()-API_RATE_WINDOW_MS*2;
  for(const [id,state] of apiRateLimits) if(state.windowStarted<cutoff) apiRateLimits.delete(id);
}
function isAdminTelegramId(id:number):boolean{return String(process.env.TELEGRAM_ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean).includes(String(id));}


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
  return lines.join('\n') + '\n';
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

      if (requestPath === '/terms') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); json(res, 405, { error: 'method_not_allowed' }); return; }
        applySecurityHeaders(res);
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.method === 'HEAD') { res.end(); return; }
        res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>WellBOT — Условия использования</title><style>body{margin:0;background:#07090d;color:#f4f6fb;font:16px/1.65 Inter,system-ui,sans-serif}main{max-width:760px;margin:auto;padding:40px 22px 70px}h1{font-size:32px}h2{margin-top:30px}p,li{color:#b9c0cc}.card{background:#0d1118;border:1px solid #202734;border-radius:16px;padding:24px}</style></head><body><main><div class="card"><h1>WellBOT — Условия использования</h1><p>Последнее обновление: 7 октября 2026 г.</p><h2>1. Назначение сервиса</h2><p>WellBOT помогает отслеживать объявления на поддерживаемых площадках, сравнивать цены и получать уведомления о потенциально интересных предложениях.</p><h2>2. Ответственность пользователя</h2><p>Пользователь самостоятельно проверяет продавца, состояние товара, цену, условия сделки и достоверность объявления перед покупкой.</p><h2>3. Аналитика</h2><p>Оценки, Deal Score, рыночные цены, потенциальная прибыль и ROI являются информационной аналитикой и не являются гарантией прибыли или возможности перепродажи.</p><h2>4. PRO</h2><p>Платные функции WellBOT предоставляются в соответствии с отображаемыми в Mini App условиями и стоимостью. Оплата через Telegram Stars обрабатывается Telegram.</p><h2>5. Использование сервиса</h2><p>Запрещается использовать WellBOT для незаконных действий, обхода ограничений площадок или нарушения прав третьих лиц.</p><h2>6. Изменения</h2><p>Условия могут обновляться при изменении функциональности сервиса. Актуальная версия всегда доступна по адресу <strong>/terms</strong>.</p></div></main></body></html>`);
        return;
      }

      if (requestPath === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); json(res, 405, { error: 'method_not_allowed' }); return; }
        applySecurityHeaders(res);
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'HEAD') { res.end(); return; }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ status: 'ok', service: 'wellbot-web' }));
        return;
      }

      if (requestPath === '/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); json(res, 405, { error: 'method_not_allowed' }); return; }
        if (req.method === 'HEAD') {
          try {
            await db.healthCheck();
            const metrics=metricsProvider ? await metricsProvider() as any : null;
            const running=metrics?.scheduler?.running;
            const ready=typeof running==='boolean' ? running===true : true;
            applySecurityHeaders(res); res.statusCode=ready?200:503; res.setHeader('Cache-Control','no-store'); res.end();
          } catch {
            applySecurityHeaders(res); res.statusCode=503; res.setHeader('Cache-Control','no-store'); res.end();
          }
          return;
        }
        try {
          const database=await db.healthCheck();
          const metrics=metricsProvider ? await metricsProvider() as any : null;
          const schedulerRunning=metrics?.scheduler?.running;
          const schedulerKnown=typeof schedulerRunning==='boolean';
          const ready=!schedulerKnown || schedulerRunning===true;
          json(res,ready?200:503,{
            status:ready?'ok':'degraded',
            service:'wellbot-web',
            database:{status:'ok',name:database.database,serverVersion:database.serverVersion},
            scheduler:schedulerKnown?{status:ready?'running':'stopped'}:undefined,
          });
        } catch(error) {
          logger.error('WellBOT health check failed',{error:error instanceof Error?error.message:String(error)});
          json(res,503,{status:'degraded',service:'wellbot-web',database:{status:'error'},scheduler:{status:'unknown'}});
        } return;
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
        if (!allowApiRequest(auth.user.id)) {
          res.setHeader('Retry-After','60');
          json(res,429,{error:'rate_limited',message:'Слишком много запросов. Повторите через минуту.'});
          return;
        }
        pruneApiRateLimits();
        const user = await db.getUser(auth.user.id);
        if (!user) { logger.warn('WellBOT API user not registered', { telegramId: auth.user.id, requestPath }); json(res, 403, { error: 'user_not_registered' }); return; }

        if (requestPath === '/api/admin/overview' && req.method === 'GET') {
          if(!isAdminTelegramId(auth.user.id)){json(res,403,{error:'admin_forbidden'});return;}
          const [users,promos,audit]=await Promise.all([db.adminListUsers(100),db.listPromoCodes(100),db.getAdminAudit(100)]);
          json(res,200,{users,promos,audit,adminTelegramId:auth.user.id});return;
        }
        if (requestPath === '/api/admin/pro/grant' && req.method === 'POST') {
          if(!isAdminTelegramId(auth.user.id)){json(res,403,{error:'admin_forbidden'});return;}
          try{const body=await readJson(req);const telegramId=Number(body.telegramId),days=Number(body.durationDays),reason=String(body.reason||'admin grant').slice(0,500);if(!Number.isSafeInteger(telegramId)||telegramId<=0||!Number.isFinite(days)||days<1||days>3650){json(res,400,{error:'invalid_grant'});return;}await db.adminGrantPro(telegramId,days,auth.user.id,reason);json(res,200,{ok:true});}catch(e){json(res,400,{error:e instanceof Error?e.message:'grant_failed'});}return;
        }
        if (requestPath === '/api/admin/pro/revoke' && req.method === 'POST') {
          if(!isAdminTelegramId(auth.user.id)){json(res,403,{error:'admin_forbidden'});return;}
          try{const body=await readJson(req);const telegramId=Number(body.telegramId),reason=String(body.reason||'admin revoke').slice(0,500);if(!Number.isSafeInteger(telegramId)||telegramId<=0){json(res,400,{error:'invalid_user'});return;}await db.revokePro(telegramId,auth.user.id,reason);json(res,200,{ok:true});}catch(e){json(res,400,{error:e instanceof Error?e.message:'revoke_failed'});}return;
        }
        if (requestPath === '/api/admin/promo/create' && req.method === 'POST') {
          if(!isAdminTelegramId(auth.user.id)){json(res,403,{error:'admin_forbidden'});return;}
          try{const body=await readJson(req);const code=String(body.code||'').trim().toUpperCase(),days=Number(body.durationDays),maxUses=Number(body.maxUses||1);const expiresAt=body.expiresAt?new Date(String(body.expiresAt)):null;if(!code||!Number.isFinite(days)||days<1||days>3650||!Number.isFinite(maxUses)||maxUses<1||maxUses>100000||expiresAt&&!Number.isFinite(expiresAt.getTime())){json(res,400,{error:'invalid_promo'});return;}await db.createPromoCode(code,days,maxUses,expiresAt,auth.user.id);json(res,200,{ok:true,code});}catch(e){json(res,400,{error:e instanceof Error?e.message:'promo_create_failed'});}return;
        }
        if (requestPath === '/api/promo/redeem' && req.method === 'POST') {
          try{const body=await readJson(req);const code=String(body.code||'').trim();if(!code||code.length>64){json(res,400,{error:'invalid_promo'});return;}const expiresAt=await db.redeemPromoCode(auth.user.id,code);json(res,200,{ok:true,expiresAt:expiresAt.toISOString()});}catch(e){json(res,400,{error:e instanceof Error?e.message:'promo_redeem_failed'});}return;
        }

        if (requestPath === '/api/pro' && req.method === 'GET') {
          const subscription=await db.getProSubscription(auth.user.id);
          const active=subscription?.status==='active'&&subscription.expiresAt.getTime()>Date.now();
          json(res,200,{tier:active?'pro':'free',active,subscription:subscription?{tier:subscription.tier,status:active?'active':subscription.status,expiresAt:subscription.expiresAt.toISOString(),starsAmount:subscription.starsAmount}:null,priceStars:Number(process.env.WELLBOT_PRO_PRICE_STARS||'199')});
          return;
        }
        if (requestPath === '/api/pro/invoice' && req.method === 'POST') {
          const priceStars=Math.min(10000,Math.max(1,Math.floor(Number(process.env.WELLBOT_PRO_PRICE_STARS||'199'))));
          const current=await db.getProSubscription(auth.user.id);
          if(current?.status==='active'&&current.expiresAt.getTime()>Date.now()){json(res,409,{error:'pro_already_active',message:'WellBOT PRO уже активен.'});return;}
          const payload='wellbot_pro_monthly_v1:'+auth.user.id+':'+Date.now();
          const telegramResponse=await fetch('https://api.telegram.org/bot'+encodeURIComponent(botToken)+'/sendInvoice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:auth.user.id,title:'WellBOT PRO',description:'Умный Deal Score, расширенная аналитика рынка, быстрые находки и PRO-возможности.',payload,currency:'XTR',prices:[{label:'WellBOT PRO — 30 дней',amount:priceStars}],subscription_period:2592000,terms_url:process.env.WELLBOT_TERMS_URL||undefined})});
          const telegramResult=await telegramResponse.json() as {ok?:boolean;result?:{message_id:number};description?:string};
          if(!telegramResponse.ok||!telegramResult.ok){logger.error('Telegram PRO invoice failed',{telegramId:auth.user.id,status:telegramResponse.status,description:telegramResult.description});json(res,502,{error:'invoice_failed',message:'Telegram не смог создать счёт. Попробуйте ещё раз.'});return;}
          json(res,200,{ok:true,messageId:telegramResult.result?.message_id||null,priceStars});return;
        }

        if (requestPath === '/api/preferences' && req.method === 'GET') {
          json(res,200,{preferences:await db.getUserPreferences(user.id)}); return;
        }
        if (requestPath === '/api/preferences' && req.method === 'PATCH') {
          try {
            const body=await readJson(req);
            if(body.notificationsEnabled!=null&&typeof body.notificationsEnabled!=='boolean') throw new Error('invalid_notifications');
            if(body.digestEnabled!=null&&typeof body.digestEnabled!=='boolean') throw new Error('invalid_digest');
            const prefs=await db.updateUserPreferences(user.id,{
              notificationsEnabled:body.notificationsEnabled as boolean|undefined,
              minDealScore:body.minDealScore==null?undefined:Number(body.minDealScore),
              digestEnabled:body.digestEnabled as boolean|undefined,
              digestHour:body.digestHour==null?undefined:Number(body.digestHour),
            });
            json(res,200,{preferences:prefs});
          } catch(e){json(res,400,{error:e instanceof Error?e.message:'invalid_preferences'});}
          return;
        }
        if (requestPath === '/api/analytics' && req.method === 'GET') {
          json(res,200,await db.getUserAnalytics(user.id)); return;
        }
        if (requestPath === '/api/saved' && req.method === 'GET') {
          const ads=await db.getSavedAds(user.id,100);
          json(res,200,{ads,count:ads.length}); return;
        }
        const savedMatch=requestPath.match(/^\/api\/saved\/(\d+)$/);
        if(savedMatch&&(req.method==='POST'||req.method==='DELETE')){
          const adId=Number(savedMatch[1]);
          if(!Number.isSafeInteger(adId)||adId<=0){json(res,400,{error:'invalid_ad_id'});return;}
          const ok=req.method==='POST'?await db.saveAdForUser(adId,user.id):await db.unsaveAdForUser(adId,user.id);
          json(res,ok?200:404,ok?{ok:true,adId}:{error:'not_found'}); return;
        }

        if (requestPath === '/api/metrics' && req.method === 'GET') { json(res, 200, metricsProvider ? await metricsProvider() : { scheduler: { running: false }, notifications: {}, generatedAt: new Date().toISOString() }); return; }

        if (requestPath === '/api/bootstrap' && req.method === 'GET') {
          const [links, ads, priceDrops, stats, statsByLink, preferences, savedAds] = await Promise.all([
            db.getUserLinks(user.id), db.getDashboardAds(user.id, 50), db.getDashboardPriceDrops(user.id, 30),
            db.getDashboardStats(user.id), db.getUserAdsCount(user.id), db.getUserPreferences(user.id), db.getSavedAds(user.id, 100),
          ]);
          logger.info('WellBOT bootstrap', { telegramId: auth.user.id, dbUserId: user.id, links: links.length, activeLinksFromLinks: links.filter(link => link.is_active).length, inactiveLinksFromLinks: links.filter(link => !link.is_active).length, ads: ads.length, priceDrops: priceDrops.length, totalLinks: stats.totalLinks, activeLinks: stats.activeLinks });
          json(res, 200, { user: { id: user.id, telegramId: user.telegram_id, username: user.username }, isAdmin: isAdminTelegramId(auth.user.id), links, ads, priceDrops, stats, statsByLink, preferences, savedAds, serverTime: new Date().toISOString() });
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
          if (typeof config.categoryId !== 'string' || config.categoryId.length < 1 || config.categoryId.length > 100) { json(res,400,{error:'invalid_category',message:'Выберите категорию из каталога WellBOT.'}); return; }
          const node = source==='kufar' ? findCatalogNode(config.categoryId) : findMarketplaceNode(source,config.categoryId);
          if (!node || node.searchable===false) { json(res,400,{error:'invalid_category',message:'Выберите категорию из каталога WellBOT.'}); return; }
          const category = source==='kufar' ? findCatalogCategory(config.categoryId) : findMarketplaceCategory(source,config.categoryId);
          if (node.children?.length && !config.subcategoryId) { json(res,400,{error:'subcategory_required',message:'Выберите подкатегорию.'}); return; }
          if (config.subcategoryId) {
            const child = source==='kufar' ? findCatalogNode(config.subcategoryId) : findMarketplaceNode(source,config.subcategoryId);
            if (!child || child.searchable===false || !category || category.id!==config.categoryId || !isCatalogDescendant(child.id, category)) { json(res,400,{error:'invalid_subcategory',message:'Выберите подкатегорию из выбранной категории.'}); return; }
          }
          if (config.condition && config.condition!=='new' && config.condition!=='used') { json(res,400,{error:'invalid_condition'}); return; }
          if (config.seller && config.seller!=='private' && config.seller!=='company') { json(res,400,{error:'invalid_seller'}); return; }
          if (config.minMarketDiscount!=null && (typeof config.minMarketDiscount!=='number' || !Number.isFinite(config.minMarketDiscount) || config.minMarketDiscount<0 || config.minMarketDiscount>90)) { json(res,400,{error:'invalid_market_discount',message:'Минимальная скидка от рынка должна быть от 0 до 90%.'}); return; }
          if (config.skipSlots!=null && (typeof config.skipSlots!=='number' || !Number.isSafeInteger(config.skipSlots) || config.skipSlots<0 || config.skipSlots>100)) { json(res,400,{error:'invalid_skip_slots',message:'Пропуск слотов должен быть от 0 до 100.'}); return; }
          if (config.mode && config.mode!=='normal' && config.mode!=='sniper') { json(res,400,{error:'invalid_mode'}); return; }
          if (config.brand!=null && (typeof config.brand!=='string' || config.brand.length>60 || !KUFAR_PHONE_BRANDS.some(x=>x.id===String(config.brand).toLowerCase()))) { json(res,400,{error:'invalid_brand',message:'Производитель не найден в каталоге Kufar.'}); return; }
          if (config.model!=null && (typeof config.model!=='string' || config.model.length>100)) { json(res,400,{error:'invalid_model',message:'Модель слишком длинная.'}); return; }
          if ((config.brand||config.model||config.phoneFilters) && source!=='kufar') { json(res,400,{error:'phone_filters_only_kufar'}); return; }
          if ((config.brand||config.model||config.phoneFilters) && !isKufarPhoneCategory(config.categoryId,config.subcategoryId)) { json(res,400,{error:'phone_filters_wrong_category',message:'Фильтры телефона доступны только для мобильных телефонов Kufar.'}); return; }
          if (config.query!=null && (typeof config.query!=='string' || config.query.length>120)) { json(res,400,{error:'invalid_query'}); return; }
          if (config.city!=null && (typeof config.city!=='string' || config.city.length>100)) { json(res,400,{error:'invalid_city'}); return; }
          if (config.region!=null && (typeof config.region!=='string' || config.region.length>100)) { json(res,400,{error:'invalid_region'}); return; }
          if (config.phoneFilters!=null && (typeof config.phoneFilters!=='object' || Array.isArray(config.phoneFilters))) { json(res,400,{error:'invalid_phone_filters'}); return; }
          if (config.minPrice!=null && (typeof config.minPrice!=='number' || !Number.isFinite(config.minPrice) || config.minPrice<0)) { json(res,400,{error:'invalid_min_price'}); return; }
          if (config.maxPrice!=null && (typeof config.maxPrice!=='number' || !Number.isFinite(config.maxPrice) || config.maxPrice<0)) { json(res,400,{error:'invalid_max_price'}); return; }
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
      if(extension==='.html'){
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org https://*.telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.telegram.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      }
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
