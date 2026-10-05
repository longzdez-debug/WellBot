import { DatabaseService, NotificationJob, NotificationEnqueueJob } from '../database/DatabaseService';
import { ParserFactory } from '../parsers/ParserFactory';
import { BotHandler } from '../bot/BotHandler';
import { Ad, Platform } from '../types';
import { logger } from '../utils/logger';
import { MonitorConfig } from '../catalog/KufarCatalog';
import { getComparableMarketSignal } from '../services/ComparableMarketEngine';
import { parseMarketPrice } from '../services/MarketEngine';

interface ParseLink { id:number; user_id:number; url:string; platform:Platform; config?:MonitorConfig|null; last_parsed_at?:Date|null; error_count?:number; next_check_at?:Date|null; }
interface PriceDrop { adId:number; oldPrice:string; newPrice:string; changePercent:string; externalId:string; linkId:number; }
interface ParseResult { newAds:Ad[]; priceDrops:PriceDrop[]; nextCheckDelayMs?:number; }
interface NewAdNotification { ad:Ad; telegramId:number; userId:number; }

function isMonitorConfig(value:unknown): value is MonitorConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Record<string, unknown>;
  return typeof config.source === 'string' && typeof config.categoryId === 'string';
}

export class ParserScheduler {
  private readonly db:DatabaseService;
  private readonly bot:BotHandler;
  private intervalId:NodeJS.Timeout|null=null;
  private notificationIntervalId:NodeJS.Timeout|null=null;
  private outboxMaintenanceIntervalId:NodeJS.Timeout|null=null;
  private readonly intervalMs:number;
  private readonly concurrency:number;
  private readonly notificationConcurrency:number;
  private readonly parseTimeoutMs:number;
  private readonly notificationBatchSize:number;
  private readonly notificationDrainMs:number;
  private readonly maxNotificationAttempts:number;
  private readonly notificationRetentionDays:number;
  private readonly newAdMaxAgeSeconds:number;
  private isRunning=false;
  private stopping=false;
  private pendingTrigger=false;
  private notificationDrainWorkers=0;
  private readonly maxNotificationWorkers=2;
  private readonly metrics={cycles:0,cycleFailures:0,cycleOverruns:0,skippedTicks:0,linkFailures:0,linksParsed:0,newAds:0,priceDrops:0,notificationsSent:0,notificationsFailed:0,duplicateNotifications:0,notificationLatencies:[] as number[],sourceVisibilityLatencies:[] as number[],cycleDurations:[] as number[],cycleNewAds:[] as Array<{at:number,count:number}>};
  async getMetrics(){const sorted=[...this.metrics.cycleDurations].sort((a,b)=>a-b);const percentile=(p:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]:0;const notificationSorted=[...this.metrics.notificationLatencies].sort((a,b)=>a-b);const nPercentile=(p:number)=>notificationSorted.length?notificationSorted[Math.min(notificationSorted.length-1,Math.ceil(notificationSorted.length*p)-1)]:0;const sourceSorted=[...this.metrics.sourceVisibilityLatencies].sort((a,b)=>a-b);const sPercentile=(p:number)=>sourceSorted.length?sourceSorted[Math.min(sourceSorted.length-1,Math.ceil(sourceSorted.length*p)-1)]:0;const queue=await this.db.getPendingNotificationStats();const freshness=await this.db.getActiveLinkFreshnessStats();const cutoff=Date.now()-600000;this.metrics.cycleNewAds=this.metrics.cycleNewAds.filter(x=>x.at>=cutoff);const adsPerMinute=this.metrics.cycleNewAds.reduce((sum,x)=>sum+x.count,0)/10;return{scheduler:{running:this.isRunning,intervalMs:this.intervalMs,concurrency:this.concurrency,cycles:this.metrics.cycles,failures:this.metrics.cycleFailures,cycleOverruns:this.metrics.cycleOverruns,skippedTicks:this.metrics.skippedTicks,linkFailures:this.metrics.linkFailures,linksParsed:this.metrics.linksParsed,activeLinks:freshness.activeLinks,freshnessLagMs:{oldest:freshness.oldestAgeMs,avg:freshness.avgAgeMs},adsPerMinute:Number(adsPerMinute.toFixed(2)),cycleDurationMs:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),last:this.metrics.cycleDurations.length?this.metrics.cycleDurations[this.metrics.cycleDurations.length-1]:0}},sourceVisibility:{p50:sPercentile(.5),p95:sPercentile(.95),p99:sPercentile(.99)},notifications:{draining:this.notificationDrainWorkers>0,workers:this.notificationDrainWorkers,concurrency:this.notificationConcurrency,sent:this.metrics.notificationsSent,failed:this.metrics.notificationsFailed,pending:queue.count,oldestAgeMs:queue.oldestAgeMs,latencyMs:{p50:nPercentile(.5),p95:nPercentile(.95),p99:nPercentile(.99)}},newAds:this.metrics.newAds,priceDrops:this.metrics.priceDrops,duplicateNotifications:this.metrics.duplicateNotifications,generatedAt:new Date().toISOString()};}

  constructor(db:DatabaseService,bot:BotHandler){this.db=db;this.bot=bot;const seconds=Number.parseFloat(process.env.PARSE_INTERVAL_SECONDS||'0.25');const concurrency=Number.parseInt(process.env.PARSE_CONCURRENCY||'16',10);const notificationConcurrency=Number.parseInt(process.env.NOTIFICATION_CONCURRENCY||'8',10);const parseTimeoutMs=Number.parseInt(process.env.PARSE_TIMEOUT_MS||'6000',10);const batchSize=Number.parseInt(process.env.NOTIFICATION_BATCH_SIZE||'25',10);const drainMs=Number.parseInt(process.env.NOTIFICATION_DRAIN_MS||'50',10);const maxAttempts=Number.parseInt(process.env.NOTIFICATION_MAX_ATTEMPTS||'12',10);const retentionDays=Number.parseInt(process.env.NOTIFICATION_RETENTION_DAYS||'14',10);const maxAgeSeconds=Number.parseInt(process.env.NEW_AD_MAX_AGE_SECONDS||'900',10);this.intervalMs=Math.max(100,Number.isFinite(seconds)?seconds*1000:500);this.concurrency=Math.max(1,Math.min(20,Number.isFinite(concurrency)?concurrency:5));this.notificationConcurrency=Math.max(1,Math.min(10,Number.isFinite(notificationConcurrency)?notificationConcurrency:4));this.parseTimeoutMs=Math.max(1000,Math.min(60000,Number.isFinite(parseTimeoutMs)?parseTimeoutMs:9000));this.notificationBatchSize=Math.max(1,Math.min(100,Number.isFinite(batchSize)?batchSize:25));this.notificationDrainMs=Math.max(25,Math.min(30000,Number.isFinite(drainMs)?drainMs:250));this.maxNotificationAttempts=Math.max(1,Math.min(100,Number.isFinite(maxAttempts)?maxAttempts:12));this.notificationRetentionDays=Math.max(1,Math.min(365,Number.isFinite(retentionDays)?retentionDays:14));this.newAdMaxAgeSeconds=Math.max(0,Math.min(86400,Number.isFinite(maxAgeSeconds)?maxAgeSeconds:900));logger.info('Parser scheduler configured',{intervalSeconds:this.intervalMs/1000,concurrency:this.concurrency,notificationConcurrency:this.notificationConcurrency,parseTimeoutMs:this.parseTimeoutMs,notificationBatchSize:this.notificationBatchSize,notificationDrainMs:this.notificationDrainMs,maxNotificationAttempts:this.maxNotificationAttempts,notificationRetentionDays:this.notificationRetentionDays,newAdMaxAgeSeconds:this.newAdMaxAgeSeconds,overlapProtection:true});}
  start():void{if(this.intervalId)return;this.stopping=false;void this.runParsing();void this.drainNotifications();void this.maintainNotificationOutbox();this.intervalId=setInterval(()=>{if(!this.isRunning)void this.runParsing();else {this.metrics.skippedTicks+=1;this.pendingTrigger=true;logger.debug('Skipping scheduler tick because previous cycle is still running; next cycle queued');}},this.intervalMs);this.notificationIntervalId=setInterval(()=>void this.drainNotifications(),this.notificationDrainMs);this.outboxMaintenanceIntervalId=setInterval(()=>void this.maintainNotificationOutbox(),60*60*1000);logger.info('Parser scheduler started',{intervalMs:this.intervalMs,notificationDrainMs:this.notificationDrainMs,notificationConcurrency:this.notificationConcurrency,overlapProtection:true});}

  async runParsing():Promise<void>{if(this.stopping)return;if(this.isRunning){this.pendingTrigger=true;return;}this.isRunning=true;this.pendingTrigger=false;const startedAt=Date.now();this.metrics.cycles+=1;try{const links=await this.db.getActiveLinks() as ParseLink[];const seen=new Set<string>();const unique=links.filter(link=>{const key=`${link.user_id}|${link.url}`;if(seen.has(key))return false;seen.add(key);return true;});const userIds=[...new Set(unique.map(link=>link.user_id))];const userRows=await this.db.getUsersByIds(userIds);const users=new Map<number,{telegram_id:number;id:number}>(userRows.map(user=>[user.id,user]));logger.info('🔄 Parsing cycle started',{linksCount:unique.length,concurrency:this.concurrency});const results=await this.mapWithConcurrency(unique,this.concurrency,async link=>{const currentConfig=isMonitorConfig(link.config)?link.config:undefined;const result=await this.parseLink({...link,config:currentConfig});const user=users.get(link.user_id);if(user){if(result.newAds.length)await this.notifyNewAds(result.newAds.map(ad=>({ad,telegramId:user.telegram_id,userId:user.id})));if(result.priceDrops.length)await this.notifyPriceDrops(result.priceDrops.map(drop=>({drop,telegramId:user.telegram_id,userId:user.id})));if(result.newAds.length||result.priceDrops.length)void this.drainNotifications();}return result;});await this.db.scheduleNextChecks(unique.map((link,i)=>({linkId:link.id,delayMs:results[i]?.nextCheckDelayMs??this.intervalMs})));const totalNew=results.reduce((sum,result)=>sum+(result?.newAds.length??0),0);const totalDrops=results.reduce((sum,result)=>sum+(result?.priceDrops.length??0),0);const duration=Date.now()-startedAt;this.metrics.linksParsed+=unique.length;this.metrics.newAds+=totalNew;this.metrics.priceDrops+=totalDrops;this.metrics.cycleDurations.push(duration);if(this.metrics.cycleDurations.length>200)this.metrics.cycleDurations.shift();if(duration>this.intervalMs)this.metrics.cycleOverruns+=1;this.metrics.cycleNewAds.push({at:Date.now(),count:totalNew});if(this.metrics.cycleNewAds.length>200)this.metrics.cycleNewAds.shift();logger.info('Parsing cycle completed',{duration:`${duration}ms`,linksCount:unique.length,totalNewAds:totalNew,totalPriceDrops:totalDrops});}catch(error:unknown){this.metrics.cycleFailures+=1;const message=error instanceof Error?error.message:String(error);const stack=error instanceof Error?error.stack:undefined;logger.error('Parsing cycle failed',{error:message,stack});}finally{this.isRunning=false;if(this.pendingTrigger){this.pendingTrigger=false;setImmediate(()=>void this.runParsing());}}}

  private async mapWithConcurrency<T,R>(items:T[],limit:number,worker:(item:T)=>Promise<R>):Promise<R[]>{const results=new Array<R>(items.length);let next=0;const run=async():Promise<void>=>{while(true){const index=next++;if(index>=items.length)return;try{results[index]=await worker(items[index]);}catch(error:unknown){const message=error instanceof Error?error.message:String(error);logger.error('Scheduler worker failed',{index,error:message});}}};await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>run()));return results;}

  private async notifyNewAds(items:NewAdNotification[]):Promise<void>{const jobs:NotificationEnqueueJob[]=[];const seen=new Set<string>();for(const {ad,telegramId,userId} of items){const key=`new_ad:user:${telegramId}:${ad.external_id}`;if(seen.has(key))continue;seen.add(key);jobs.push({kind:'new_ad',chatId:telegramId,dedupeKey:key,payload:{ad,userId},priority:100});}if(!jobs.length)return;const inserted=await this.db.enqueueNotifications(jobs);this.metrics.duplicateNotifications+=Math.max(0,jobs.length-inserted);}

  private async notifyPriceDrops(items:Array<{drop:PriceDrop;telegramId:number;userId:number}>):Promise<void>{const jobs:NotificationEnqueueJob[]=[];const seen=new Set<string>();for(const {drop,telegramId,userId} of items){const key=`price_drop:user:${telegramId}:${drop.externalId}:${drop.oldPrice}:${drop.newPrice}`;if(seen.has(key))continue;seen.add(key);jobs.push({kind:'price_drop',chatId:telegramId,dedupeKey:key,payload:{drop,userId},priority:50});}if(!jobs.length)return;const inserted=await this.db.enqueueNotifications(jobs);this.metrics.duplicateNotifications+=Math.max(0,jobs.length-inserted);}

  private async drainNotifications():Promise<void>{if(this.stopping||this.notificationDrainWorkers>=this.maxNotificationWorkers)return;this.notificationDrainWorkers+=1;const startedAt=Date.now();try{const jobs=await this.db.claimNotificationJobs(this.notificationBatchSize,60);if(!jobs.length)return;await this.mapWithConcurrency(jobs,this.notificationConcurrency,job=>this.deliverNotification(job));logger.debug('Notification batch drained',{jobs:jobs.length,workers:this.notificationDrainWorkers,concurrency:Math.min(this.notificationConcurrency,jobs.length),duration:`${Date.now()-startedAt}ms`});}catch(error:unknown){const message=error instanceof Error?error.message:String(error);logger.error('Notification drain failed',{error:message});}finally{this.notificationDrainWorkers=Math.max(0,this.notificationDrainWorkers-1);}}
  private async deliverNotification(job:NotificationJob):Promise<void>{try{if(job.kind==='new_ad'){const ad=job.payload.ad as unknown as Ad;const userId=Number(job.payload.userId);if(!ad||typeof ad.external_id!=='string'||typeof ad.title!=='string'||typeof ad.ad_url!=='string'||!Number.isSafeInteger(userId)||userId<=0)throw new Error('Invalid new-ad notification payload');if(await this.db.isAdDismissedForUser(ad.external_id,userId)){await this.db.markNotificationSent(job.id);logger.info('Notification suppressed because ad was dismissed',{jobId:job.id,chatId:job.chat_id,externalId:ad.external_id,userId});return;}await this.bot.sendNotification(job.chat_id,ad);}else if(job.kind==='price_drop'){const drop=job.payload.drop as unknown as PriceDrop;const userId=Number(job.payload.userId);if(!drop||typeof drop.externalId!=='string'||typeof drop.oldPrice!=='string'||typeof drop.newPrice!=='string'||!Number.isSafeInteger(userId)||userId<=0)throw new Error('Invalid price-drop notification payload');await this.bot.sendPriceDropNotification(job.chat_id,drop,userId);}else throw new Error(`Unsupported notification kind: ${job.kind}`);await this.db.markNotificationSent(job.id);this.metrics.notificationsSent+=1;const createdAt=job.created_at instanceof Date?job.created_at:new Date(job.created_at);if(!Number.isNaN(createdAt.getTime())){this.metrics.notificationLatencies.push(Math.max(0,Date.now()-createdAt.getTime()));if(this.metrics.notificationLatencies.length>200)this.metrics.notificationLatencies.shift();}logger.debug('Notification delivered',{jobId:job.id,kind:job.kind,chatId:job.chat_id,attempts:job.attempts});}catch(error:unknown){const message=error instanceof Error?error.message:String(error);this.metrics.notificationsFailed+=1;const nextAttempt=job.attempts+1;if(nextAttempt>=this.maxNotificationAttempts){await this.db.discardNotification(job.id,`retry limit reached (${this.maxNotificationAttempts}): ${message}`);return;}const delaySeconds=Math.min(300,Math.max(2,2**Math.min(nextAttempt,8)));await this.db.rescheduleNotification(job.id,message,delaySeconds);logger.warn('Notification delivery failed; scheduled retry',{jobId:job.id,kind:job.kind,chatId:job.chat_id,attempts:nextAttempt,maxAttempts:this.maxNotificationAttempts,retryInSeconds:delaySeconds,error:message});}}

  private async maintainNotificationOutbox():Promise<void>{try{const purged=await this.db.purgeNotificationOutbox(this.notificationRetentionDays);if(purged>0)logger.info('Notification outbox retention cleanup completed',{purged,retentionDays:this.notificationRetentionDays});}catch(error:unknown){const message=error instanceof Error?error.message:String(error);logger.warn('Notification outbox maintenance failed',{error:message});}}

  private applyMonitorFilters(link: ParseLink, ads: Ad[]): Ad[] {
    const config = link.config;
    if (!config || link.platform !== 'kufar') return ads;
    const min = config.minPrice != null ? Number(config.minPrice) : undefined;
    const max = config.maxPrice != null ? Number(config.maxPrice) : undefined;
    const condition = config.condition === 'new' ? ['new','новое','новый','новая'] : config.condition === 'used' ? ['used','б/у','б\u002fu','бу','бывший в употреблении'] : [];
    const normalizeFilterText=(value:string)=>String(value||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/gi,' ').replace(/\s+/g,' ').trim();
    const brandAliases:Record<string,string[]>={
      apple:['apple','iphone','айфон'],samsung:['samsung','самсунг'],xiaomi:['xiaomi','сяоми','ксиаоми'],huawei:['huawei','хуавей'],honor:['honor','хонор'],google:['google','pixel'],oneplus:['oneplus','one plus']
    };
    const queryTerms=normalizeFilterText(config.query||'').split(' ').filter(x=>x.length>=2);
    const brandTerms=String(config.brand||'').trim()?brandAliases[String(config.brand).toLowerCase()]||[normalizeFilterText(String(config.brand))]:[];
    const modelTerm=normalizeFilterText(String(config.model||''));
    return ads.filter(ad => {
      const searchText=normalizeFilterText([ad.title,ad.description].filter(Boolean).join(' '));
      if(queryTerms.length&&!queryTerms.every(term=>searchText.includes(term))) return false;
      if(brandTerms.length&&!brandTerms.some(term=>searchText.includes(term))) return false;
      if(modelTerm&&!searchText.includes(modelTerm)) return false;
      if (condition.length) {
        const value = String(ad.condition || '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
        if (!value || !condition.some(token => value.includes(token))) return false;
      }
      if (config.minMarketDiscount != null && (typeof ad.market_percent !== 'number' || ad.market_percent > -Number(config.minMarketDiscount))) return false;
      if (config.seller) {
        if (config.seller === 'company' && ad.is_company !== true) return false;
        if (config.seller === 'private' && ad.is_company === true) return false;
      }
      if (min == null && max == null) return true;
      const match = String(ad.price || '').toUpperCase().match(/([0-9]+(?:[.,][0-9]+)?)\s*(BYN|USD|EUR|RUB|UAH|PLN)\b/);
      if (!match) return false;
      const amount = Number(match[1].replace(',','.'));
      if (!Number.isFinite(amount)) return false;
      return (min == null || amount >= min) && (max == null || amount <= max);
    });
  }

  private isValidAd(ad:Ad|null|undefined):ad is Ad{if(!ad)return false;const externalId=typeof ad.external_id==='string'?ad.external_id.trim():'';const title=typeof ad.title==='string'?ad.title.trim():'';const adUrl=typeof ad.ad_url==='string'?ad.ad_url.trim():'';if(!externalId||!title||!adUrl)return false;try{const parsed=new URL(adUrl);return parsed.protocol==='http:'||parsed.protocol==='https:';}catch{return false;}}
  private normalizeAds(rawAds:Ad[]):Ad[]{const valid:Ad[]=[];const seen=new Set<string>();for(const ad of rawAds){if(!this.isValidAd(ad))continue;const externalId=ad.external_id.trim();if(seen.has(externalId))continue;seen.add(externalId);valid.push({...ad,external_id:externalId,title:ad.title.trim(),ad_url:ad.ad_url.trim()});}return valid;}
  private async parseLink(link:ParseLink):Promise<ParseResult>{const newAds:Ad[]=[];const priceDrops:PriceDrop[]=[];let failureCount=Number(link.error_count||0);try{const parser=ParserFactory.getParser(link.platform);if(!parser){failureCount=await this.recordLinkFailure(link,`No parser configured for platform ${link.platform}`);return{newAds,priceDrops,nextCheckDelayMs:this.computeNextCheckDelay(link,failureCount)};}let rawAds:Ad[];try{rawAds=await this.withTimeout(parser.parseUrl(link.url),this.parseTimeoutMs,`Parse timeout after ${this.parseTimeoutMs} milliseconds`);}catch(error:unknown){const message=error instanceof Error?error.message:String(error);failureCount=await this.recordLinkFailure(link,message);return{newAds,priceDrops,nextCheckDelayMs:this.computeNextCheckDelay(link,failureCount)};}if(!Array.isArray(rawAds)){failureCount=await this.recordLinkFailure(link,'Parser returned a non-array result');return{newAds,priceDrops,nextCheckDelayMs:this.computeNextCheckDelay(link,failureCount)};}const normalizedRaw=this.normalizeAds(rawAds);
      const skipSlots=Math.min(100,Math.max(0,Math.floor(Number(link.config?.skipSlots||0))));
      const scannedRaw=skipSlots>0?normalizedRaw.slice(skipSlots):normalizedRaw;
      if(skipSlots>0) logger.debug('Skipping listing slots for monitor',{linkId:link.id,skipSlots,availableSlots:normalizedRaw.length});
      const externalIds=scannedRaw.map(ad=>ad.external_id);
      const state=await this.db.getExistingAdStatesForLink(link.id,externalIds);
      const marketAds=await this.db.getRecentMarketAds(link.id,250);
      const marketCandidates=scannedRaw.map(ad=>{
        const last=state.prices.get(ad.external_id); const newPrice=parseMarketPrice(ad.price); const oldPrice=last?parseMarketPrice(last.price):null;
        const unchanged=Boolean(last&&newPrice&&oldPrice&&newPrice.currency===oldPrice.currency&&newPrice.amount===oldPrice.amount);
        const cached=state.market.get(ad.external_id);
        if(state.existingIds.has(ad.external_id)&&unchanged&&cached) return {...ad,market_status:cached.status,market_percent:cached.percent,market_median:cached.median,market_low:cached.low,market_high:cached.high,sell_fast:cached.sellFast,sell_normal:cached.sellNormal,sell_max:cached.sellMax,market_sample_size:cached.sampleSize,market_confidence:cached.confidence,market_quality:cached.quality};
        return this.attachComparableMarket(ad,marketAds);
      });
      const configured=this.applyMonitorFilters(link,marketCandidates);
      const configuredIds=new Set(configured.map(ad=>ad.external_id));
      const ads=marketCandidates;
      const marketUpdates:Array<{id:number;status:Exclude<Ad['market_status'], undefined>;percent:number|null;median:number|null;low:number|null;high:number|null;sellFast:number|null;sellNormal:number|null;sellMax:number|null;sampleSize:number|null;confidence:Exclude<Ad['market_confidence'], undefined>;quality:number|null}>=[];
      const baseline = !link.last_parsed_at;
      if (!baseline && rawAds.length > 0 && normalizedRaw.length === 0) {
        this.metrics.linkFailures += 1;
        failureCount = await this.recordLinkFailure(link, 'Parser returned only invalid/malformed ads');
        return { newAds, priceDrops, nextCheckDelayMs: this.computeNextCheckDelay(link, failureCount) };
      }
      if (baseline) {
        const marketById=new Map(ads.map(ad=>[ad.external_id,ad]));
        const insertedRaw=await this.db.bulkCreateAdsReturning(link.id,ads);
        await this.db.updateAdMarketSignals(insertedRaw.map(row=>{
          const signal=marketById.get(row.external_id);
          return {id:Number(row.id),status:signal?.market_status??null,percent:signal?.market_percent??null,median:signal?.market_median??null,low:signal?.market_low??null,high:signal?.market_high??null,sellFast:signal?.sell_fast??null,sellNormal:signal?.sell_normal??null,sellMax:signal?.sell_max??null,sampleSize:signal?.market_sample_size??null,confidence:signal?.market_confidence??null,quality:signal?.market_quality??null};
        }).filter(signal=>Number.isFinite(signal.id)));
        await this.db.updateLastParsed(link.id);
        if ((link.error_count ?? 0) > 0) await this.db.resetErrorCount(link.id);
        logger.info('Baseline snapshot stored; no notifications sent', {
          linkId: link.id,
          adsFound: ads.length,
          adsInserted: insertedRaw.length,
          emptyResult: ads.length === 0,
        });
        return { newAds, priceDrops, nextCheckDelayMs: this.computeNextCheckDelay(link, failureCount) };
      }
      if (ads.length === 0) {
        logger.warn('Established monitor returned empty result; checkpoint preserved', {
          linkId: link.id,
          platform: link.platform,
          url: link.url,
          rawAdsCount: rawAds.length,
        });
        return { newAds, priceDrops, nextCheckDelayMs: this.computeNextCheckDelay(link, failureCount) };
      }

      const existing = state.existingIds;
      const prices = state.prices;
      const processed = new Set<string>();
      const priceUpdates:Array<{id:number;price:string}>=[];
      const newCandidates: Ad[] = [];

      for (const adData of ads) {
        const id = adData.external_id;
        if (processed.has(id)) continue;
        processed.add(id);

        if (existing.has(id)) {
          const last = prices.get(id);
          if (last && adData.price) {
            if (configuredIds.has(id)) {
              await this.processPriceDrop(last, id, adData.price, priceDrops, link.id, link.user_id);
            } else {
              priceUpdates.push({id:last.adId,price:adData.price});
            }
            if (adData.market_median != null) marketUpdates.push({id:last.adId,status:adData.market_status ?? null,percent:adData.market_percent??null,median:adData.market_median,low:adData.market_low??null,high:adData.market_high??null,sellFast:adData.sell_fast??null,sellNormal:adData.sell_normal??null,sellMax:adData.sell_max??null,sampleSize:adData.market_sample_size??null,confidence:adData.market_confidence??null,quality:adData.market_quality??null});
          }
          continue;
        }

        newCandidates.push(adData);
      }

      if (newCandidates.length) {
        const marketById = new Map(newCandidates.map(ad => [ad.external_id, ad]));
        const insertedRaw = await this.db.bulkCreateAdsReturning(link.id, newCandidates);
        const inserted = insertedRaw.map(ad => ({ ...ad, ...marketById.get(ad.external_id) }));
        for(const row of inserted) marketUpdates.push({id:Number(row.id),status:row.market_status??null,percent:row.market_percent??null,median:row.market_median??null,low:row.market_low??null,high:row.market_high??null,sellFast:row.sell_fast??null,sellNormal:row.sell_normal??null,sellMax:row.sell_max??null,sampleSize:row.market_sample_size??null,confidence:row.market_confidence??null,quality:row.market_quality??null});
        const notifyCandidates = inserted.filter(ad => configuredIds.has(ad.external_id));
        const claimed = await this.db.claimNewAdsForUser(link.user_id, link.id, notifyCandidates);

        for (const adData of inserted) {
          if (!configuredIds.has(adData.external_id)) continue;
          if (!claimed.has(adData.external_id)) {
            logger.debug('Duplicate ad across monitors suppressed', {
              linkId: link.id,
              userId: link.user_id,
              external_id: adData.external_id,
            });
            continue;
          }

          const publishedAt = adData.published_at instanceof Date
            ? adData.published_at
            : adData.published_at
              ? new Date(adData.published_at)
              : null;
          const ageSeconds = publishedAt && !Number.isNaN(publishedAt.getTime())
            ? Math.max(0, (Date.now() - publishedAt.getTime()) / 1000)
            : null;

          if (ageSeconds !== null && this.newAdMaxAgeSeconds > 0 && ageSeconds > this.newAdMaxAgeSeconds) {
            logger.warn('🕒 STALE AD FIRST SEEN; notification suppressed', {
              linkId: link.id,
              external_id: adData.external_id,
              title: adData.title,
              price: adData.price,
              publishedAt: publishedAt?.toISOString(),
              ageSeconds: Number(ageSeconds.toFixed(1)),
              maxAgeSeconds: this.newAdMaxAgeSeconds,
            });
            continue;
          }

          newAds.push(adData);
          const firstSeenAt = adData.first_seen_at instanceof Date ? adData.first_seen_at : new Date();
          if (publishedAt && !Number.isNaN(publishedAt.getTime())) {
            const visibilityLagMs = Math.max(0, firstSeenAt.getTime() - publishedAt.getTime());
            this.metrics.sourceVisibilityLatencies.push(visibilityLagMs);
            if (this.metrics.sourceVisibilityLatencies.length > 200) this.metrics.sourceVisibilityLatencies.shift();
          }
          logger.info('📢 NEW AD DETECTED!', {
            linkId: link.id,
            external_id: adData.external_id,
            title: adData.title,
            price: adData.price,
            timestamp: new Date().toISOString(),
            publishedAt: publishedAt?.toISOString(),
            ageSeconds: ageSeconds !== null ? Number(ageSeconds.toFixed(1)) : undefined,
            firstSeenSource: adData.first_seen_source ?? null,
            firstSeenRank: adData.first_seen_rank ?? null,
            visibilityLagMs: publishedAt ? Math.max(0, firstSeenAt.getTime() - publishedAt.getTime()) : null,
          });
        }
      }

      if(priceUpdates.length) await this.db.bulkUpdateAdPrices(priceUpdates);
      if(marketUpdates.length) await this.db.updateAdMarketSignals(marketUpdates);
      await this.db.updateLastParsed(link.id);
      if ((link.error_count ?? 0) > 0) await this.db.resetErrorCount(link.id);
      return { newAds, priceDrops, nextCheckDelayMs: this.computeNextCheckDelay(link, failureCount) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to parse link', { linkId: link.id, url: link.url, error: message, stack });
      try {
        failureCount = await this.recordLinkFailure(link, message);
      } catch (failureError: unknown) {
        const failureMessage = failureError instanceof Error ? failureError.message : String(failureError);
        logger.error('Failed to record link parse failure', { linkId: link.id, error: failureMessage });
      }
      return { newAds, priceDrops, nextCheckDelayMs: this.computeNextCheckDelay(link, failureCount) };
    }
  }

  private attachComparableMarket(ad:Ad, marketAds:Ad[]):Ad {
    const signal = getComparableMarketSignal(ad, marketAds);
    return {
      ...ad,
      market_status: signal.market_status,
      market_percent: signal.market_percent,
      market_median: signal.market_median,
      market_low: signal.market_low,
      market_high: signal.market_high,
      sell_fast: signal.sell_fast,
      sell_normal: signal.sell_normal,
      sell_max: signal.sell_max,
      market_sample_size: signal.sample_size,
      market_confidence: signal.confidence,
      market_quality: signal.quality,
    };
  }

  private computeNextCheckDelay(link:ParseLink,failureCount:number):number{const sniper=link.config?.mode==='sniper';const base=(sniper?Math.min(250,this.intervalMs):this.intervalMs)*Math.pow(2,Math.min(failureCount,6));const jitter=base>=2000?Math.floor(Math.random()*Math.min(750,Math.max(100,base*0.15))):0;return Math.min(300000,base+jitter);}
  private async recordLinkFailure(link:ParseLink,reason:string):Promise<number>{this.metrics.linkFailures+=1;await this.db.incrementErrorCount(link.id);const current=await this.db.getLink(link.id);const errorCount=Math.max(current?.error_count??0,(link.error_count??0)+1);logger.warn('Link parse failure',{linkId:link.id,errorCount,reason});logger.warn('Monitor remains active after parse failure; backoff will be applied',{linkId:link.id,errorCount});return errorCount;}
  private async withTimeout<T>(promise:Promise<T>,timeoutMs:number,message:string):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),timeoutMs);})]);}finally{if(timer)clearTimeout(timer);}}
  private async processPriceDrop(last:{price:string;adId:number},externalId:string,newPrice:string,priceDrops:PriceDrop[],linkId:number,userId:number):Promise<void>{try{const oldParsed=parseMarketPrice(last.price);const newParsed=parseMarketPrice(newPrice);if(!oldParsed||!newParsed||oldParsed.currency!==newParsed.currency)return;const oldNumber=oldParsed.amount;const newNumber=newParsed.amount;if(newNumber<oldNumber){const percent=((oldNumber-newNumber)/oldNumber*100).toFixed(1);const recorded=await this.db.createPriceDropRecord(userId,last.adId,externalId,last.price,newPrice,Number(percent));if(recorded)priceDrops.push({adId:last.adId,oldPrice:last.price,newPrice,changePercent:percent,externalId,linkId});}if(oldNumber!==newNumber)await this.db.updateAdPrice(last.adId,newPrice);}catch(error:unknown){const message=error instanceof Error?error.message:String(error);logger.error('Failed to check price drop',{linkId,externalId,error:message});}}
  async stop():Promise<void>{this.stopping=true;if(this.intervalId){clearInterval(this.intervalId);this.intervalId=null;}if(this.notificationIntervalId){clearInterval(this.notificationIntervalId);this.notificationIntervalId=null;}if(this.outboxMaintenanceIntervalId){clearInterval(this.outboxMaintenanceIntervalId);this.outboxMaintenanceIntervalId=null;}this.pendingTrigger=false;while(this.isRunning||this.notificationDrainWorkers>0)await new Promise<void>(resolve=>setTimeout(resolve,25));logger.info('Parser scheduler stopped');}
  triggerParse():void{if(this.stopping)return;if(this.isRunning){this.pendingTrigger=true;return;}void this.runParsing();}
}
