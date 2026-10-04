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

const STOP = new Set(['для','из','и','или','в','на','с','по','от','до','как','не','это','the','a','an','pro','новый','новая','новое','б/у','бу','куплю','продам','цена','срочно','торг']);
function norm(v:string|null|undefined){return (v||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/gi,' ').replace(/\s+/g,' ').trim();}
function tokens(v:string|null|undefined){return new Set(norm(v).split(' ').filter(x=>x.length>=2&&!STOP.has(x)));}
function numericTokens(set:Set<string>){return [...set].filter(x=>/\d/.test(x));}
type PreparedAd={item:Ad;tokens:Set<string>;location:string;price:ReturnType<typeof parseMarketPrice>};
const preparedHistoryCache=new WeakMap<Ad[],PreparedAd[]>();
function prepareHistory(history:Ad[]):PreparedAd[]{const cached=preparedHistoryCache.get(history);if(cached)return cached;const prepared=history.map(item=>({item,tokens:tokens(item.title),location:norm(item.location),price:parseMarketPrice(item.price)}));preparedHistoryCache.set(history,prepared);return prepared;}
function titleSimilarity(left:Set<string>,right:Set<string>){if(!left.size||!right.size)return 0;let hit=0;for(const x of left)if(right.has(x))hit++;const union=new Set([...left,...right]).size;return union?hit/union:0;}
function sameLocation(a:string,b:string){if(!a||!b)return 0;return a===b||a.includes(b)||b.includes(a)?1:0;}
function score(current:Ad,currentTokens:Set<string>,currentLocation:string,candidate:PreparedAd){
  const candidateTokens=candidate.tokens;
  const currentNums=numericTokens(currentTokens); const candidateNums=numericTokens(candidateTokens);
  if(currentNums.length&&candidateNums.length&&!currentNums.every(x=>candidateNums.includes(x))) return 0;
  const title=titleSimilarity(currentTokens,candidateTokens);
  if(title<0.42)return 0;
  let s=title*0.68;
  s+=sameLocation(currentLocation,candidate.location)*0.14;
  if(current.condition&&candidate.item.condition)s+=current.condition===candidate.item.condition?0.10:-0.06;
  if(current.is_company!==undefined&&candidate.item.is_company!==undefined)s+=current.is_company===candidate.item.is_company?0.04:-0.02;
  if(currentNums.length&&candidateNums.length)s+=0.04;
  return Math.max(0,Math.min(1,s));
}
function percentile(values:number[],p:number){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos);return a[lo]+(a[hi]-a[lo])*(pos-lo);}
function robustValues(values:number[]):number[]{
  if(values.length<8)return values;
  const q1=percentile(values,.25)!; const q3=percentile(values,.75)!; const iqr=q3-q1;
  if(iqr<=0)return values.filter(v=>v===q1);
  const low=q1-iqr*1.5, high=q3+iqr*1.5;
  const filtered=values.filter(v=>v>=low&&v<=high);
  return filtered.length>=8?filtered:values;
}
export function getComparableMarketSignal(current:Ad,history:Ad[],minimumSampleSize=8):ComparableMarketResult{
  const cp=parseMarketPrice(current.price);
  const empty={market_status:null,market_percent:null,market_median:null,market_low:null,market_high:null,sell_fast:null,sell_normal:null,sell_max:null,sample_size:0,confidence:null,comparable_count:0,quality:0} as ComparableMarketResult;
  if(!cp)return empty;
  const currentTokens=tokens(current.title); const currentLocation=norm(current.location);
  if(currentTokens.size<1)return empty;
  const prepared=prepareHistory(history);
  const ranked=prepared
    .filter(x=>x.item.external_id!==current.external_id&&x.price?.currency===cp.currency)
    .map(x=>({item:x.item,s:score(current,currentTokens,currentLocation,x),p:x.price!}))
    .filter(x=>x.s>=0.48)
    .sort((a,b)=>b.s-a.s);
  if(ranked.length<minimumSampleSize)return {...empty,comparable_count:ranked.length};
  const selected=ranked.slice(0,40);
  const rawValues=selected.map(x=>x.p.amount).filter(Number.isFinite);
  if(rawValues.length<minimumSampleSize)return {...empty,comparable_count:ranked.length};
  const values=robustValues(rawValues);
  if(values.length<minimumSampleSize)return {...empty,comparable_count:ranked.length};
  const median=percentile(values,.5)!; const low=percentile(values,.25)!; const high=percentile(values,.75)!;
  const percent=Number((((cp.amount-median)/median)*100).toFixed(1));
  const status=percent<=-15?'below_market':percent>=15?'above_market':'market';
  const confidence=values.length>=25&&ranked[0].s>=0.65?'high':values.length>=12?'medium':'low';
  const avgScore=selected.reduce((sum,x)=>sum+x.s,0)/selected.length;
  const spread=median>0?Math.min(1,(high-low)/median):1;
  const quality=Math.round(Math.min(100,values.length*1.7+avgScore*45-spread*18));
  return {market_status:status,market_percent:percent,market_median:Number(median.toFixed(2)),market_low:Number(low.toFixed(2)),market_high:Number(high.toFixed(2)),sell_fast:Number((low*.98).toFixed(2)),sell_normal:Number((median*.97).toFixed(2)),sell_max:Number((high*.97).toFixed(2)),sample_size:values.length,confidence,comparable_count:ranked.length,quality};
}
