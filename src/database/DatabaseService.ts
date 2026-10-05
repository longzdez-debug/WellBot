import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { User, Link, Ad, Platform } from '../types';
import { logger } from '../utils/logger';
import { MonitorConfig } from '../catalog/KufarCatalog';

export interface DashboardAd extends Ad { link_platform: Platform; link_url: string; }
export interface DashboardPriceDrop { id:number; external_id:string; old_price:string|null; new_price:string|null; price_change_percent:number|null; created_at:Date; title:string; image_url:string|null; ad_url:string; link_platform:Platform; }
export type NotificationKind = 'new_ad' | 'price_drop';
export interface NotificationEnqueueJob { kind:NotificationKind; chatId:number; dedupeKey:string; payload:Record<string, unknown>; priority?:number; }
export interface NotificationJob { id:number; kind:NotificationKind; chat_id:number; dedupe_key:string; payload:Record<string, unknown>; attempts:number; available_at:Date; locked_until:Date|null; sent_at:Date|null; last_error:string|null; created_at:Date; }

export class DatabaseService {
  private pool: Pool;
  constructor(connectionString:string){this.pool=new Pool({connectionString,max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:5000,statement_timeout:12000,query_timeout:12000,keepAlive:true,keepAliveInitialDelayMillis:10000});this.pool.on('error',(err:Error)=>logger.error('Unexpected database error',{error:err.message}));}
  async initialize():Promise<void>{try{await this.pool.query(readFileSync(join(__dirname,'schema.sql'),'utf-8'));logger.info('Database schema initialized');}catch(error){logger.error('Failed to initialize database',{error});throw error;}}
  async close():Promise<void>{await this.pool.end();}
  async createUser(telegramId:number,username:string|null):Promise<User>{const r=await this.pool.query<User>('INSERT INTO users (telegram_id, username) VALUES ($1,$2) ON CONFLICT (telegram_id) DO UPDATE SET username=COALESCE(EXCLUDED.username, users.username) RETURNING *',[telegramId,username]);return r.rows[0];}
  async getProSubscription(telegramId:number):Promise<{tier:string;status:string;expiresAt:Date;starsAmount:number|null}|null>{
    const r=await this.pool.query<{tier:string;status:string;expires_at:Date;stars_amount:number|null}>('SELECT s.tier,s.status,s.expires_at,s.stars_amount FROM pro_subscriptions s JOIN users u ON u.id=s.user_id WHERE u.telegram_id=$1 ORDER BY s.expires_at DESC LIMIT 1',[telegramId]);
    const row=r.rows[0]; if(!row)return null; const active=row.status==='active' && new Date(row.expires_at).getTime()>Date.now();
    if(!active && row.status==='active') await this.pool.query('UPDATE pro_subscriptions SET status=$1,updated_at=CURRENT_TIMESTAMP WHERE user_id=(SELECT id FROM users WHERE telegram_id=$2) AND tier=$3',['expired',telegramId,'pro']);
    return {tier:row.tier,status:active?'active':row.status==='active'?'expired':row.status,expiresAt:new Date(row.expires_at),starsAmount:row.stars_amount};
  }
  async activateProSubscription(telegramId:number,expiresAt:Date,starsAmount:number,telegramChargeId:string,providerChargeId:string|null,payload:string):Promise<void>{
    const user=await this.getUser(telegramId); if(!user)throw new Error('user_not_registered');
    await this.pool.query("INSERT INTO pro_subscriptions(user_id,tier,status,expires_at,telegram_payment_charge_id,provider_payment_charge_id,stars_amount,last_invoice_payload,updated_at) VALUES($1,'pro','active',$2,$3,$4,$5,$6,CURRENT_TIMESTAMP) ON CONFLICT(user_id,tier) DO UPDATE SET status='active',expires_at=GREATEST(pro_subscriptions.expires_at,EXCLUDED.expires_at),telegram_payment_charge_id=EXCLUDED.telegram_payment_charge_id,provider_payment_charge_id=EXCLUDED.provider_payment_charge_id,stars_amount=EXCLUDED.stars_amount,last_invoice_payload=EXCLUDED.last_invoice_payload,updated_at=CURRENT_TIMESTAMP",[user.id,expiresAt,telegramChargeId,providerChargeId,starsAmount,payload]);
  }
  async revokeProByCharge(telegramChargeId:string):Promise<void>{await this.pool.query("UPDATE pro_subscriptions SET status='refunded',expires_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE telegram_payment_charge_id=$1",[telegramChargeId]);}

  async getUser(telegramId:number):Promise<User|null>{const r=await this.pool.query<User>('SELECT * FROM users WHERE telegram_id=$1',[telegramId]);return r.rows[0]||null;}
  async getUsersByIds(userIds:number[]):Promise<User[]>{const ids=[...new Set(userIds.filter(id=>Number.isSafeInteger(id)&&id>0))];if(!ids.length)return[];const r=await this.pool.query<User>('SELECT * FROM users WHERE id=ANY($1::int[])',[ids]);return r.rows;}
  private monitorSourceKey(config:MonitorConfig):string{const min=config.minPrice==null?'':String(config.minPrice);const max=config.maxPrice==null?'':String(config.maxPrice);return [config.source,config.categoryId,config.subcategoryId||'',config.region||'',config.city||'',config.query||'',min,max,config.condition||'',config.seller||'',config.minMarketDiscount==null?'':String(config.minMarketDiscount),config.mode||'normal'].join(':');}
  async createLink(userId:number,url:string,platform:Platform,config?:MonitorConfig):Promise<Link>{const sourceKey=config ? this.monitorSourceKey(config) : null;const configJson=config ? JSON.stringify(config) : null;const r=await this.pool.query<Link>('INSERT INTO links (user_id,url,platform,config,source_key,next_check_at,priority) VALUES ($1,$2,$3,$4::jsonb,$5,CURRENT_TIMESTAMP,CASE WHEN ($4::jsonb->>\'mode\')=\'sniper\' THEN 100 ELSE 0 END) ON CONFLICT (user_id,url) DO UPDATE SET is_active=true, platform=EXCLUDED.platform, config=COALESCE(EXCLUDED.config,links.config), source_key=COALESCE(EXCLUDED.source_key,links.source_key), error_count=0, next_check_at=CURRENT_TIMESTAMP, priority=EXCLUDED.priority RETURNING *',[userId,url,platform,configJson,sourceKey]);return r.rows[0];}
  async getUserLinks(userId:number):Promise<Link[]>{const r=await this.pool.query<Link>('SELECT * FROM links WHERE user_id=$1 ORDER BY created_at DESC',[userId]);return r.rows;}
  async getUserLinksCount(userId:number):Promise<number>{const r=await this.pool.query<{count:string}>('SELECT COUNT(*) as count FROM links WHERE user_id=$1 AND is_active=true',[userId]);return parseInt(r.rows[0].count,10);}
  async getLink(linkId:number):Promise<Link|null>{const r=await this.pool.query<Link>('SELECT * FROM links WHERE id=$1',[linkId]);return r.rows[0]||null;}
  async getLinkForUser(linkId:number,userId:number):Promise<Link|null>{const r=await this.pool.query<Link>('SELECT * FROM links WHERE id=$1 AND user_id=$2',[linkId,userId]);return r.rows[0]||null;}
  async deleteLink(linkId:number,userId?:number):Promise<boolean>{const query=userId==null?'DELETE FROM links WHERE id=$1':'DELETE FROM links WHERE id=$1 AND user_id=$2';const params=userId==null?[linkId]:[linkId,userId];const r=await this.pool.query(query,params);return(r.rowCount||0)>0;}
  async setLinkActive(linkId:number,userId:number,isActive:boolean):Promise<boolean>{const r=await this.pool.query('UPDATE links SET is_active=$1,error_count=CASE WHEN $1 THEN 0 ELSE error_count END WHERE id=$2 AND user_id=$3 AND ($1=false OR (SELECT COUNT(*) FROM links AS active_links WHERE active_links.user_id=$3 AND active_links.is_active=true AND active_links.id<>$2)<50)',[isActive,linkId,userId]);return(r.rowCount||0)>0;}
  async getActiveLinks():Promise<Link[]>{const r=await this.pool.query<Link>('SELECT * FROM links WHERE is_active=true AND (next_check_at IS NULL OR next_check_at<=CURRENT_TIMESTAMP) ORDER BY COALESCE(next_check_at,CURRENT_TIMESTAMP),priority DESC,id',[]);return r.rows;}
  async scheduleNextChecks(items:Array<{linkId:number;delayMs:number}>):Promise<void>{if(!items.length)return;const unique=new Map<number,number>();for(const item of items){if(!Number.isSafeInteger(item.linkId)||item.linkId<=0)continue;unique.set(item.linkId,Math.min(Math.max(Math.floor(item.delayMs),250),300000));}if(!unique.size)return;const ids=[...unique.keys()];const delays=[...unique.values()];await this.pool.query('UPDATE links l SET next_check_at=CURRENT_TIMESTAMP+(v.delay_ms::int * INTERVAL \'1 millisecond\') FROM unnest($1::int[],$2::int[]) AS v(id,delay_ms) WHERE l.id=v.id AND l.is_active=true',[ids,delays]);}
  async incrementErrorCount(linkId:number):Promise<void>{await this.pool.query('UPDATE links SET error_count=error_count+1 WHERE id=$1',[linkId]);}
  async updateLastParsed(linkId:number):Promise<void>{await this.pool.query('UPDATE links SET last_parsed_at=CURRENT_TIMESTAMP WHERE id=$1',[linkId]);}
  async resetErrorCount(linkId:number):Promise<void>{await this.pool.query('UPDATE links SET error_count=0 WHERE id=$1',[linkId]);}
  async bulkCreateAdsReturning(linkId:number,ads:Ad[]):Promise<Ad[]>{const unique=new Map<string,Ad>();for(const ad of ads)if(ad?.external_id&&!unique.has(ad.external_id))unique.set(ad.external_id,ad);const rows=[...unique.values()];if(!rows.length)return[];const inserted:Ad[]=[];const chunkSize=400;for(let start=0;start<rows.length;start+=chunkSize){const chunk=rows.slice(start,start+chunkSize);const values:unknown[]=[];const placeholders=chunk.map((ad,i)=>{const b=i*15;values.push(linkId,ad.external_id,ad.title,ad.description||null,ad.price||null,ad.image_url||null,ad.ad_url,ad.location||null,ad.address||null,ad.published_at||null,ad.detected_at||new Date(),ad.first_seen_at||ad.detected_at||new Date(),ad.first_seen_source||null,ad.first_seen_rank??null,ad.updated_at||null);return`(${b+1},${b+2},${b+3},${b+4},${b+5},${b+6},${b+7},${b+8},${b+9},${b+10},${b+11},${b+12},${b+13},${b+14},${b+15})`;}).join(',');const result=await this.pool.query<Ad>(`INSERT INTO ads (link_id,external_id,title,description,price,image_url,ad_url,location,address,published_at,detected_at,first_seen_at,first_seen_source,first_seen_rank,updated_at) VALUES ${placeholders} ON CONFLICT (external_id,link_id) DO NOTHING RETURNING *`,values);inserted.push(...result.rows);}return inserted;}
  async getAdByIdForUser(adId:number,userId:number):Promise<Ad|null>{const r=await this.pool.query<Ad>('SELECT a.* FROM ads a JOIN links l ON l.id=a.link_id WHERE a.id=$1 AND l.user_id=$2',[adId,userId]);return r.rows[0]||null;}
  async getExistingAdStatesForLink(linkId:number,externalIds:string[]):Promise<{existingIds:Set<string>;prices:Map<string,{price:string;adId:number}>;market:Map<string,{status:Ad['market_status'];percent:number|null;median:number|null;low:number|null;high:number|null;sellFast:number|null;sellNormal:number|null;sellMax:number|null;sampleSize:number|null;confidence:Ad['market_confidence'];quality:number|null}>}>{if(!externalIds.length)return{existingIds:new Set(),prices:new Map(),market:new Map()};const r=await this.pool.query<{external_id:string;price:string|null;ad_id:number;market_status:Ad['market_status'];market_percent:string|null;market_median:string|null;market_low:string|null;market_high:string|null;sell_fast:string|null;sell_normal:string|null;sell_max:string|null;market_sample_size:number|null;market_confidence:Ad['market_confidence'];market_quality:string|null}>('SELECT DISTINCT ON (external_id) external_id,price,id AS ad_id,market_status,market_percent,market_median,market_low,market_high,sell_fast,sell_normal,sell_max,market_sample_size,market_confidence,market_quality FROM ads WHERE link_id=$1 AND external_id=ANY($2::text[]) ORDER BY external_id,updated_at DESC NULLS LAST,id DESC',[linkId,externalIds]);const existingIds=new Set(r.rows.map(row=>row.external_id));const prices=new Map(r.rows.filter(row=>row.price!=null).map(row=>[row.external_id,{price:row.price as string,adId:row.ad_id}]));const market=new Map(r.rows.map(row=>[row.external_id,{status:row.market_status,percent:row.market_percent==null?null:Number(row.market_percent),median:row.market_median==null?null:Number(row.market_median),low:row.market_low==null?null:Number(row.market_low),high:row.market_high==null?null:Number(row.market_high),sellFast:row.sell_fast==null?null:Number(row.sell_fast),sellNormal:row.sell_normal==null?null:Number(row.sell_normal),sellMax:row.sell_max==null?null:Number(row.sell_max),sampleSize:row.market_sample_size,confidence:row.market_confidence,quality:row.market_quality==null?null:Number(row.market_quality)}]));return{existingIds,prices,market};}
  async claimNewAdsForUser(userId:number,linkId:number,ads:Ad[]):Promise<Set<string>>{
    const rows=[...new Set(ads.filter(ad=>ad?.external_id).map(ad=>ad.external_id))];
    if(!rows.length)return new Set();
    const r=await this.pool.query<{external_id:string}>(
      `INSERT INTO user_ad_seen (user_id,external_id,first_link_id)
       SELECT $1, x, $2 FROM unnest($3::text[]) AS x
       ON CONFLICT (user_id,external_id) DO NOTHING
       RETURNING external_id`,
      [userId,linkId,rows],
    );
    return new Set(r.rows.map(row=>row.external_id));
  }

  async getGlobalRecentMarketAds(limit=2000,platform?:Platform):Promise<Ad[]>{const safeLimit=Math.min(Math.max(Math.floor(limit),100),5000);const r=await this.pool.query<Ad>(`SELECT a.id,a.link_id,a.external_id,a.title,a.description,a.price,a.image_url,a.ad_url,a.location,a.address,a.published_at,a.updated_at,a.created_at,CASE WHEN l.config IS NULL THEN NULL ELSE CONCAT(l.platform,':',COALESCE(l.config->>'categoryId',''),':',COALESCE(l.config->>'subcategoryId','')) END AS market_group FROM ads a JOIN links l ON l.id=a.link_id WHERE a.price IS NOT NULL AND a.price <> '' ${platform ? 'AND l.platform=$2' : ''} ORDER BY COALESCE(a.published_at,a.created_at) DESC,a.id DESC LIMIT $1`,platform?[safeLimit,platform]:[safeLimit]);return r.rows;}
  async getUserAdsCount(userId:number):Promise<{linkId:number;linkPlatform:string;count:number}[]>{const r=await this.pool.query('SELECT l.id as "linkId",l.platform as "linkPlatform",COUNT(a.id) as "count" FROM links l LEFT JOIN ads a ON a.link_id=l.id WHERE l.user_id=$1 GROUP BY l.id ORDER BY l.id',[userId]);return r.rows;}
  async clearAdsByUserId(userId:number):Promise<number>{const r=await this.pool.query<{id:number}>('SELECT id FROM links WHERE user_id=$1',[userId]);if(!r.rows.length)return 0;const d=await this.pool.query('DELETE FROM ads WHERE link_id=ANY($1::int[])',[r.rows.map(x=>x.id)]);await this.pool.query('DELETE FROM user_ad_seen WHERE user_id=$1',[userId]);return d.rowCount||0;}
  async dismissAdForUser(adId:number,userId:number):Promise<boolean>{
    const r=await this.pool.query<{external_id:string}>(
      `INSERT INTO dismissed_ads (user_id,external_id)
       SELECT $1,a.external_id FROM ads a JOIN links l ON l.id=a.link_id
       WHERE a.id=$2 AND l.user_id=$1
       ON CONFLICT (user_id,external_id) DO UPDATE SET dismissed_at=CURRENT_TIMESTAMP
       RETURNING external_id`,
      [userId,adId],
    );
    return r.rows.length>0;
  }
  async isAdDismissedForChat(externalId:string,telegramId:number):Promise<boolean>{
    const r=await this.pool.query('SELECT 1 FROM dismissed_ads d JOIN users u ON u.id=d.user_id WHERE u.telegram_id=$1 AND d.external_id=$2 LIMIT 1',[telegramId,externalId]);
    return r.rowCount===1;
  }
  async isAdDismissedForUser(externalId:string,userId:number):Promise<boolean>{
    const r=await this.pool.query('SELECT 1 FROM dismissed_ads WHERE user_id=$1 AND external_id=$2',[userId,externalId]);
    return r.rowCount===1;
  }
  async getDismissedExternalIds(userId:number):Promise<Set<string>>{
    const r=await this.pool.query<{external_id:string}>('SELECT external_id FROM dismissed_ads WHERE user_id=$1',[userId]);
    return new Set(r.rows.map(x=>x.external_id));
  }
  async getDashboardAds(userId:number,limit=50):Promise<DashboardAd[]>{const safeLimit=Math.min(Math.max(Math.floor(limit),1),100);const r=await this.pool.query<DashboardAd>('SELECT a.*,l.platform AS link_platform,l.url AS link_url FROM ads a JOIN links l ON l.id=a.link_id WHERE l.user_id=$1 AND NOT EXISTS (SELECT 1 FROM dismissed_ads d WHERE d.user_id=$1 AND d.external_id=a.external_id) ORDER BY COALESCE(a.published_at,a.created_at) DESC,a.id DESC LIMIT $2',[userId,safeLimit]);return r.rows;}
  async getDashboardPriceDrops(userId:number,limit=30):Promise<DashboardPriceDrop[]>{const safeLimit=Math.min(Math.max(Math.floor(limit),1),50);const r=await this.pool.query<DashboardPriceDrop>('SELECT ph.id,ph.external_id,ph.old_price,ph.new_price,ph.price_change_percent,ph.created_at,a.title,a.image_url,a.ad_url,l.platform AS link_platform FROM price_history ph JOIN ads a ON a.id=ph.ad_id JOIN links l ON l.id=a.link_id WHERE ph.user_id=$1 ORDER BY ph.created_at DESC,ph.id DESC LIMIT $2',[userId,safeLimit]);return r.rows;}
  async getDashboardStats(userId:number):Promise<{activeLinks:number;totalLinks:number;adsToday:number;priceDropsToday:number}>{const r=await this.pool.query<{active_links:string;total_links:string;ads_today:string;drops_today:string}>('SELECT COUNT(*) FILTER (WHERE is_active) AS active_links,COUNT(*) AS total_links,(SELECT COUNT(*) FROM ads a JOIN links l ON a.link_id=l.id WHERE l.user_id=$1 AND a.created_at>=CURRENT_DATE) AS ads_today,(SELECT COUNT(*) FROM price_history ph WHERE ph.user_id=$1 AND ph.created_at>=CURRENT_DATE) AS drops_today FROM links WHERE user_id=$1',[userId]);const row=r.rows[0];return{activeLinks:Number(row?.active_links||0),totalLinks:Number(row?.total_links||0),adsToday:Number(row?.ads_today||0),priceDropsToday:Number(row?.drops_today||0)};}
  async createPriceDropRecord(userId:number,adId:number,externalId:string,oldPrice:string,newPrice:string,changePercent:number):Promise<boolean>{try{const r=await this.pool.query('INSERT INTO price_history (ad_id,user_id,external_id,old_price,new_price,price_change_percent,notified_at) VALUES ($1,$2,$3,$4,$5,$6,NULL) ON CONFLICT (user_id,external_id,old_price,new_price) DO NOTHING',[adId,userId,externalId,oldPrice,newPrice,changePercent]);return(r.rowCount||0)>0;}catch(error:unknown){const message=error instanceof Error?error.message:String(error);logger.warn('Price drop record insert failed',{error:message});return false;}}
  async updateAdMarketSignals(signals:Array<{id:number;status:'below_market'|'market'|'above_market'|null;percent:number|null;median:number|null;low:number|null;high:number|null;sellFast:number|null;sellNormal:number|null;sellMax:number|null;sampleSize:number|null;confidence:'low'|'medium'|'high'|null;quality:number|null}>):Promise<void>{
    if(!signals.length)return;
    await this.pool.query(
      `UPDATE ads a
       SET market_status=x.status,
           market_percent=x.percent,
           market_median=x.median,
           market_low=x.low,
           market_high=x.high,
           sell_fast=x.sell_fast,
           sell_normal=x.sell_normal,
           sell_max=x.sell_max,
           market_sample_size=x.sample_size,
           market_confidence=x.confidence,
           market_quality=x.quality
       FROM jsonb_to_recordset($1::jsonb) AS x(id int,status text,percent numeric,median numeric,low numeric,high numeric,sell_fast numeric,sell_normal numeric,sell_max numeric,sample_size int,confidence text,quality numeric)
       WHERE a.id=x.id`,
      [JSON.stringify(signals.map(s=>({id:s.id,status:s.status,percent:s.percent,median:s.median,low:s.low,high:s.high,sell_fast:s.sellFast,sell_normal:s.sellNormal,sell_max:s.sellMax,sample_size:s.sampleSize,confidence:s.confidence,quality:s.quality})))],
    );
  }

  async updateAdPrice(adId:number,newPrice:string):Promise<void>{await this.pool.query('UPDATE ads SET price=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2',[newPrice,adId]);}
  async bulkUpdateAdPrices(updates:Array<{id:number;price:string}>):Promise<void>{if(!updates.length)return;const unique=new Map<number,string>();for(const item of updates)if(Number.isSafeInteger(item.id)&&item.id>0&&item.price)unique.set(item.id,item.price);if(!unique.size)return;await this.pool.query(`UPDATE ads a SET price=x.price,updated_at=CURRENT_TIMESTAMP FROM jsonb_to_recordset($1::jsonb) AS x(id int,price text) WHERE a.id=x.id`,[JSON.stringify([...unique].map(([id,price])=>({id,price})))]);}
  async enqueueNotifications(jobs:NotificationEnqueueJob[]):Promise<number>{if(!jobs.length)return 0;let inserted=0;const chunkSize=400;for(let start=0;start<jobs.length;start+=chunkSize){const chunk=jobs.slice(start,start+chunkSize);const values:unknown[]=[];const placeholders=chunk.map((job,i)=>{const b=i*5;values.push(job.kind,job.chatId,job.dedupeKey,JSON.stringify(job.payload),Math.max(-1000,Math.min(1000,Math.floor(job.priority??0))));return`(${b+1},${b+2},${b+3},${b+4}::jsonb,${b+5})`;}).join(',');const result=await this.pool.query(`INSERT INTO notification_outbox (kind,chat_id,dedupe_key,payload,priority) VALUES ${placeholders} ON CONFLICT (dedupe_key) DO NOTHING`,values);inserted+=result.rowCount||0;}return inserted;}
  async claimNotificationJobs(limit=25,leaseSeconds=60):Promise<NotificationJob[]>{const safeLimit=Math.min(Math.max(Math.floor(limit),1),100);const safeLease=Math.min(Math.max(Math.floor(leaseSeconds),5),3600);const r=await this.pool.query<NotificationJob>(`WITH candidates AS (SELECT id FROM notification_outbox WHERE sent_at IS NULL AND available_at<=CURRENT_TIMESTAMP AND (locked_until IS NULL OR locked_until<CURRENT_TIMESTAMP) ORDER BY priority DESC, available_at, id LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE notification_outbox n SET locked_until=CURRENT_TIMESTAMP+($2::int * INTERVAL '1 second') FROM candidates c WHERE n.id=c.id RETURNING n.*`,[safeLimit,safeLease]);return r.rows;}
  async markNotificationSent(id:number):Promise<void>{await this.pool.query('UPDATE notification_outbox SET sent_at=CURRENT_TIMESTAMP,locked_until=NULL,last_error=NULL WHERE id=$1',[id]);}
  async rescheduleNotification(id:number,errorMessage:string,delaySeconds:number):Promise<void>{const delay=Math.min(Math.max(Math.floor(delaySeconds),1),3600);await this.pool.query("UPDATE notification_outbox SET attempts=attempts+1,available_at=CURRENT_TIMESTAMP+($2::int * INTERVAL '1 second'),locked_until=NULL,last_error=$3 WHERE id=$1 AND sent_at IS NULL",[id,delay,errorMessage.slice(0,2000)]);}
  async discardNotification(id:number,errorMessage:string):Promise<void>{await this.pool.query('DELETE FROM notification_outbox WHERE id=$1 AND sent_at IS NULL',[id]);logger.warn('Notification discarded after retry limit',{jobId:id,error:errorMessage.slice(0,500)});}
  async getPendingNotificationStats():Promise<{count:number;oldestAgeMs:number}>{const r=await this.pool.query<{count:string;oldest_at:Date|null}>('SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at FROM notification_outbox WHERE sent_at IS NULL',[]);const row=r.rows[0];const oldest=row?.oldest_at instanceof Date?row.oldest_at:null;return {count:Number(row?.count||0),oldestAgeMs:oldest?Math.max(0,Date.now()-oldest.getTime()):0};}
  async getActiveLinkFreshnessStats():Promise<{activeLinks:number;oldestAgeMs:number;avgAgeMs:number}>{const r=await this.pool.query<{active_links:string;oldest_at:Date|null;avg_age_ms:string|null}>(`SELECT COUNT(*) FILTER (WHERE is_active) AS active_links,MIN(last_parsed_at) FILTER (WHERE is_active) AS oldest_at,COALESCE(AVG(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-COALESCE(last_parsed_at,created_at)))*1000) FILTER (WHERE is_active),0) AS avg_age_ms FROM links`,[]);const row=r.rows[0];const oldest=row?.oldest_at instanceof Date?row.oldest_at:null;return{activeLinks:Number(row?.active_links||0),oldestAgeMs:oldest?Math.max(0,Date.now()-oldest.getTime()):0,avgAgeMs:Number(row?.avg_age_ms||0)};}
  async purgeNotificationOutbox(retentionDays=14):Promise<number>{const safeDays=Math.min(Math.max(Math.floor(retentionDays),1),365);const r=await this.pool.query('DELETE FROM notification_outbox WHERE sent_at IS NOT NULL AND sent_at < CURRENT_TIMESTAMP - ($1::int * INTERVAL \'1 day\')',[safeDays]);return r.rowCount||0;}
}
