import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { User, Link, Ad, Platform } from '../types';
import { logger } from '../utils/logger';

export class DatabaseService {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    this.pool.on('error', (err: Error) => logger.error('Unexpected database error', { error: err.message }));
  }

  async initialize(): Promise<void> {
    try { await this.pool.query(readFileSync(join(__dirname, 'schema.sql'), 'utf-8')); logger.info('Database schema initialized'); }
    catch (error) { logger.error('Failed to initialize database', { error }); throw error; }
  }
  async close(): Promise<void> { await this.pool.end(); }

  async createUser(telegramId: number, username: string | null): Promise<User> {
    const r = await this.pool.query<User>('INSERT INTO users (telegram_id, username) VALUES ($1,$2) ON CONFLICT (telegram_id) DO UPDATE SET username=$2 RETURNING *',[telegramId,username]); return r.rows[0];
  }
  async getUser(telegramId: number): Promise<User | null> { const r=await this.pool.query<User>('SELECT * FROM users WHERE telegram_id=$1',[telegramId]); return r.rows[0]||null; }
  async getUserById(userId: number): Promise<User | null> { const r=await this.pool.query<User>('SELECT * FROM users WHERE id=$1',[userId]); return r.rows[0]||null; }

  async createLink(userId:number,url:string,platform:Platform):Promise<Link>{const r=await this.pool.query<Link>('INSERT INTO links (user_id,url,platform) VALUES ($1,$2,$3) RETURNING *',[userId,url,platform]);return r.rows[0];}
  async getUserLinks(userId:number):Promise<Link[]>{const r=await this.pool.query<Link>('SELECT * FROM links WHERE user_id=$1 ORDER BY created_at DESC',[userId]);return r.rows;}
  async getUserLinksCount(userId:number):Promise<number>{const r=await this.pool.query<{count:string}>('SELECT COUNT(*) as count FROM links WHERE user_id=$1',[userId]);return parseInt(r.rows[0].count,10);}
  async getLink(linkId:number):Promise<Link|null>{const r=await this.pool.query<Link>('SELECT * FROM links WHERE id=$1',[linkId]);return r.rows[0]||null;}
  async deleteLink(linkId:number):Promise<void>{await this.pool.query('DELETE FROM links WHERE id=$1',[linkId]);}
  async getActiveLinks():Promise<Link[]>{const r=await this.pool.query<Link>('SELECT * FROM links WHERE is_active=true');return r.rows;}
  async incrementErrorCount(linkId:number):Promise<void>{await this.pool.query('UPDATE links SET error_count=error_count+1 WHERE id=$1',[linkId]);}
  async markLinkInactive(linkId:number):Promise<void>{await this.pool.query('UPDATE links SET is_active=false WHERE id=$1',[linkId]);}
  async updateLastParsed(linkId:number):Promise<void>{await this.pool.query('UPDATE links SET last_parsed_at=CURRENT_TIMESTAMP WHERE id=$1',[linkId]);}
  async resetErrorCount(linkId:number):Promise<void>{await this.pool.query('UPDATE links SET error_count=0 WHERE id=$1',[linkId]);}

  async createAd(linkId:number,adData:Ad):Promise<Ad|null>{const r=await this.pool.query<Ad>(`INSERT INTO ads (link_id,external_id,title,description,price,image_url,ad_url,location,address,published_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (external_id,link_id) DO NOTHING RETURNING *`,[linkId,adData.external_id,adData.title,adData.description||null,adData.price||null,adData.image_url||null,adData.ad_url,adData.location||null,adData.address||null,adData.published_at||null,adData.updated_at||null]);return r.rows[0]||null;}
  async getAdByExternalId(externalId:string):Promise<Ad|null>{const r=await this.pool.query<Ad>('SELECT * FROM ads WHERE external_id=$1',[externalId]);return r.rows[0]||null;}
  async isNewAd(externalId:string):Promise<boolean>{return (await this.getAdByExternalId(externalId))===null;}
  async isNewAdForLink(linkId:number,externalId:string):Promise<boolean>{const r=await this.pool.query('SELECT id FROM ads WHERE link_id=$1 AND external_id=$2',[linkId,externalId]);return r.rows.length===0;}
  async isNewAdForUser(userId:number,externalId:string):Promise<boolean>{const r=await this.pool.query('SELECT a.id FROM ads a JOIN links l ON a.link_id=l.id WHERE l.user_id=$1 AND a.external_id=$2',[userId,externalId]);return r.rows.length===0;}

  async getExistingAdExternalIdsForUser(userId:number,externalIds:string[]):Promise<Set<string>>{
    if(!externalIds.length)return new Set();
    const r=await this.pool.query<{external_id:string}>('SELECT DISTINCT a.external_id FROM ads a JOIN links l ON a.link_id=l.id WHERE l.user_id=$1 AND a.external_id=ANY($2::text[])',[userId,externalIds]);
    return new Set(r.rows.map(x=>x.external_id));
  }
  async getLastPricesForAds(linkId:number,externalIds:string[]):Promise<Map<string,{price:string;adId:number}>>{
    if(!externalIds.length)return new Map();
    const r=await this.pool.query<{external_id:string;price:string;ad_id:number}>(`SELECT DISTINCT ON (external_id) external_id,price,id as ad_id FROM ads WHERE link_id=$1 AND external_id=ANY($2::text[]) ORDER BY external_id,updated_at DESC NULLS LAST,id DESC`,[linkId,externalIds]);
    return new Map(r.rows.filter(x=>x.price!=null).map(x=>[x.external_id,{price:x.price,adId:x.ad_id}]));
  }

  async getUserAdsCount(userId:number):Promise<{linkId:number;linkPlatform:string;count:number}[]>{const r=await this.pool.query(`SELECT l.id as "linkId",l.platform as "linkPlatform",COUNT(a.id) as "count" FROM links l LEFT JOIN ads a ON a.link_id=l.id WHERE l.user_id=$1 GROUP BY l.id`,[userId]);return r.rows;}
  async clearAdsByUserId(userId:number):Promise<number>{const r=await this.pool.query<{id:number}>('SELECT id FROM links WHERE user_id=$1',[userId]);if(!r.rows.length)return 0;const d=await this.pool.query('DELETE FROM ads WHERE link_id=ANY($1::int[])',[r.rows.map(x=>x.id)]);return d.rowCount||0;}

  parsePriceToNumber(priceStr:string|null|undefined):number|null{if(!priceStr)return null;const m=priceStr.match(/([\d.]+)/);if(!m)return null;const n=parseFloat(m[1]);return isNaN(n)?null:n;}
  async getLastPriceForAd(linkId:number,externalId:string):Promise<{price:string;adId:number}|null>{const r=await this.pool.query('SELECT a.price,a.id as ad_id FROM ads a WHERE a.link_id=$1 AND a.external_id=$2 ORDER BY a.updated_at DESC LIMIT 1',[linkId,externalId]);return r.rows[0]||null;}
  async createPriceDropRecord(adId:number,externalId:string,oldPrice:string,newPrice:string,changePercent:number):Promise<boolean>{try{const r=await this.pool.query(`INSERT INTO price_history (ad_id,external_id,old_price,new_price,price_change_percent,notified_at) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP) ON CONFLICT (ad_id,old_price,new_price) DO NOTHING`,[adId,externalId,oldPrice,newPrice,changePercent]);return(r.rowCount||0)>0;}catch(error:any){logger.warn('Price drop record insert failed',{error:error.message});return false;}}
  async updateAdPrice(adId:number,newPrice:string):Promise<void>{await this.pool.query('UPDATE ads SET price=$1 WHERE id=$2',[newPrice,adId]);}

  async createChannelSubscription(userId:number,channelId:number,channelUsername:string|null,channelTitle:string|null):Promise<void>{await this.pool.query(`INSERT INTO channel_subscriptions (user_id,channel_id,channel_username,channel_title) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,channel_id) DO UPDATE SET channel_username=EXCLUDED.channel_username,channel_title=EXCLUDED.channel_title,is_active=true`,[userId,channelId,channelUsername,channelTitle]);}
  async deleteChannelSubscription(userId:number,channelId:number):Promise<void>{await this.pool.query('UPDATE channel_subscriptions SET is_active=false WHERE user_id=$1 AND channel_id=$2',[userId,channelId]);}
  async deactivateAllChannelSubscriptions(userId:number):Promise<void>{await this.pool.query('UPDATE channel_subscriptions SET is_active=false WHERE user_id=$1',[userId]);}
  async getActiveChannelSubscription(userId:number):Promise<{channel_id:number;channel_username:string|null;channel_title:string|null}|null>{const r=await this.pool.query('SELECT channel_id,channel_username,channel_title FROM channel_subscriptions WHERE user_id=$1 AND is_active=true ORDER BY created_at DESC LIMIT 1',[userId]);return r.rows[0]||null;}
}
