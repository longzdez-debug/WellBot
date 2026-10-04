import { Ad } from '../types';
import { parseMarketPrice } from './MarketEngine';

export interface ComparableMarketResult {
  market_status: 'below_market' | 'market' | 'above_market' | null;
  market_percent: number | null;
  market_median: number | null;
  market_low: number | null;
  market_high: number | null;
  sell_fast: number | null;
  sell_normal: number | null;
  sell_max: number | null;
  sample_size: number;
  confidence: 'low' | 'medium' | 'high' | null;
  comparable_count: number;
  quality: number;
}

const STOP = new Set(['для','из','и','или','в','на','с','по','от','до','как','не','это','the','a','an','pro','новый','новая','новое','б/у','бу','куплю','продам']);
function norm(v:string|null|undefined){return (v||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/gi,' ').replace(/\s+/g,' ').trim();}
function tokens(v:string|null|undefined){return new Set(norm(v).split(' ').filter(x=>x.length>=2&&!STOP.has(x)));}
type PreparedAd={item:Ad;tokens:Set<string>;location:string;price:ReturnType<typeof parseMarketPrice>};
const preparedHistoryCache=new WeakMap<Ad[],PreparedAd[]>();
function prepareHistory(history:Ad[]):PreparedAd[]{const cached=preparedHistoryCache.get(history);if(cached)return cached;const prepared=history.map(item=>({item,tokens:tokens(item.title),location:norm(item.location),price:parseMarketPrice(item.price)}));preparedHistoryCache.set(history,prepared);return prepared;}
function titleSimilarity(left:Set<string>,right:Set<string>){if(!left.size||!right.size)return 0;let hit=0;for(const x of left)if(right.has(x))hit++;return hit/Math.max(1,Math.min(left.size,right.size));}
function sameLocation(a:string,b:string){if(!a||!b)return 0;return a===b||a.includes(b)||b.includes(a)?1:0;}
function score(current:Ad,currentTokens:Set<string>,currentLocation:string,candidate:PreparedAd){const title=titleSimilarity(currentTokens,candidate.tokens);if(title<0.35)return 0;let s=title*0.72;s+=sameLocation(currentLocation,candidate.location)*0.12;if(current.condition&&candidate.item.condition)s+=current.condition===candidate.item.condition?0.10:-0.04;if(current.is_company!==undefined&&candidate.item.is_company!==undefined)s+=current.is_company===candidate.item.is_company?0.03:-0.01;return Math.max(0,Math.min(1,s));}
function percentile(values:number[],p:number){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos);return a[lo]+(a[hi]-a[lo])*(pos-lo);}
export function getComparableMarketSignal(current:Ad,history:Ad[],minimumSampleSize=8):ComparableMarketResult{
 const cp=parseMarketPrice(current.price);const empty={market_status:null,market_percent:null,market_median:null,market_low:null,market_high:null,sell_fast:null,sell_normal:null,sell_max:null,sample_size:0,confidence:null,comparable_count:0,quality:0} as ComparableMarketResult;
 if(!cp)return empty;
 const currentTokens=tokens(current.title);const currentLocation=norm(current.location);const prepared=prepareHistory(history);const ranked=prepared.filter(x=>x.item.external_id!==current.external_id).map(x=>({item:x.item,s:score(current,currentTokens,currentLocation,x),p:x.price})).filter(x=>x.s>=0.30&&x.p?.currency===cp.currency).sort((a,b)=>b.s-a.s);
 let selected=ranked.slice(0,60);
 if(selected.length<minimumSampleSize)return {...empty,comparable_count:ranked.length};
 const values=selected.map(x=>x.p!.amount).filter(Number.isFinite);
 if(values.length<minimumSampleSize)return {...empty,comparable_count:ranked.length};
 const median=percentile(values,.5)!;const low=percentile(values,.25)!;const high=percentile(values,.75)!;
 const percent=Number((((cp.amount-median)/median)*100).toFixed(1));
 const status=percent<=-15?'below_market':percent>=15?'above_market':'market';
 const confidence=values.length>=40?'high':values.length>=15?'medium':'low';
 const quality=Math.round(Math.min(100,values.length*1.5+Math.max(...selected.map(x=>x.s))*30));
 return {market_status:status,market_percent:percent,market_median:Number(median.toFixed(2)),market_low:Number(low.toFixed(2)),market_high:Number(high.toFixed(2)),sell_fast:Number((low*.98).toFixed(2)),sell_normal:Number((median*.97).toFixed(2)),sell_max:Number((high*.97).toFixed(2)),sample_size:values.length,confidence,comparable_count:ranked.length,quality};
}
