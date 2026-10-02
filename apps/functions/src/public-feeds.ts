import Decimal from 'decimal.js';
import { PUBLIC_NFP_STRATEGY_ID, type AnyScenarioConfig, type EventCalendar, type EmploymentReport, type NumericDatum } from '../../../packages/shared/src';
import { BlsPublicProvider, blsUserAgent } from '../../../packages/data-providers/src/bls-public';
import { KrakenFxProvider } from '../../../packages/data-providers/src/kraken-fx';
import { createUsEquitiesCalendar2026 } from '../../../packages/data-providers/src/calendar';
import { emptyStructuredFeed,type StructuredFeed } from '../../../packages/data-providers/src/structured';
import { ProviderError } from '../../../packages/data-providers/src/http';
import { PublicDataStore } from './public-data-store';

export interface PublicFeedOptions { blsContact?: string }

export async function fetchPublicFeeds(config:AnyScenarioConfig,store:PublicDataStore,ingested:StructuredFeed|undefined,options:PublicFeedOptions={}):Promise<{structured:StructuredFeed;errors:string[]}> {
  // The observed-NFP strategy has an independent data contract. Even if a caller accidentally passes
  // a legacy manual feed, its values and conflicts cannot affect this strategy's public observations.
  const publicOnly=config.strategyId===PUBLIC_NFP_STRATEGY_ID;
  const structured=publicOnly?emptyStructuredFeed():structuredClone(ingested ?? emptyStructuredFeed());const errors:string[]=[];
  const prefix=`${config.environment}:${config.event.eventId}`;
  // An invalid operator contact throws here and blocks the evaluation; it is never silently dropped.
  const bls=new BlsPublicProvider({userAgent:blsUserAgent(options.blsContact)});const fx=new KrakenFxProvider();
  const results=await Promise.allSettled([
    (async()=>{const key=`${prefix}:calendar`;const response=await bls.getCalendar(config.event,await store.previous<EventCalendar>(key));
      return response.data?await store.record(key,response.data,response.evidence):null;})(),
    (async()=>{
      // Identical raw HTML has different valid projections. Keep their revision archives separate,
      // and inherit initial detection from the other public projection only on first use.
      const legacyKey=`${prefix}:employment`;const observedKey=`${legacyKey}:nfp-unemployment`;
      const key=publicOnly?observedKey:legacyKey;const alternateKey=publicOnly?legacyKey:observedKey;
      const previous=await store.previous<EmploymentReport>(key)??await store.previous<EmploymentReport>(alternateKey);
      const response=publicOnly?await bls.getEmployment(config.event,previous,{requireWages:false}):await bls.getEmployment(config.event,previous);
      return response.data?await store.record(key,response.data,response.evidence):null;})(),
    (async()=>{const key=`${config.environment}:usdPerUsdt`;const response=await fx.getUsdPerUsdt(await store.previous<NumericDatum>(key));
      return store.record(key,response.data,response.evidence);})(),
  ]);
  function read<T>(result:PromiseSettledResult<T>,name:string):T|null {
    if(result.status==='fulfilled')return result.value;
    errors.push(result.reason instanceof ProviderError?result.reason.code:`${name}_PROVIDER_FAILURE`);return null;
  }
  const calendar=read(results[0],'BLS_CALENDAR');const employment=read(results[1],'BLS_EMPLOYMENT');const usdPerUsdt=read(results[2],'KRAKEN_FX');
  // Configured built-in feeds have explicit priority. Errors never silently fall back to older observations.
  if(calendar&&structured.calendar&&calendar.scheduledAtUtc!==structured.calendar.scheduledAtUtc&&Date.parse(calendar.scheduledAtUtc)!==Date.parse(structured.calendar.scheduledAtUtc))errors.push('CALENDAR_SOURCE_CONFLICT');
  if(employment&&structured.employment&&employment.period===structured.employment.period) {
    for(const field of ['nfp','unemployment','wages'] as const)if(employment[field]&&structured.employment[field]&&
      (!new Decimal(employment[field]!.value).eq(structured.employment[field]!.value)||employment[field]!.unit!==structured.employment[field]!.unit))errors.push('EMPLOYMENT_SOURCE_CONFLICT');
  }
  structured.calendar=calendar;structured.employment=employment;structured.usdPerUsdt=usdPerUsdt;
  if(!publicOnly&&!structured.marketCalendar)structured.marketCalendar=createUsEquitiesCalendar2026('2026-10-01T23:18:53.000Z');
  return {structured,errors:[...new Set(errors)]};
}
