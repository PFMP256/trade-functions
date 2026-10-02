import { NumericDatum, Provenance, ScenarioConfig, Snapshot } from '../packages/shared/src';
import { demoScenarioConfig } from '../scenarios';

export const FIXTURE_NOW = '2026-10-02T12:46:30.000Z';
const RELEASE = '2026-10-02T12:30:00.000Z';
export function fixtureProvenance(at: string, sourceId = 'synthetic-fixture'): Provenance {
  return {sourceId,sourceUrl:'https://example.invalid/synthetic-fixture',observedAt:at,publishedAt:null,
    firstSeenAt:at,availableAt:at,fetchedAt:at,revision:'synthetic-v1',verified:true,synthetic:true,conflicts:[]};
}
export function fixtureDatum(value:string,unit:string,seriesId:string,at=RELEASE):NumericDatum {
  return {value,unit,seriesId,period:'2026-09',provenance:fixtureProvenance(at)};
}
/** All values are deliberately synthetic; never use these snapshots with mainnet. */
export function makeFixture(direction: 'LONG' | 'SHORT' = 'LONG'): { snapshot: Snapshot; config: ScenarioConfig; now: string } {
  const short=direction==='SHORT';
  const quoteAt='2026-10-02T12:46:20.000Z';
  const prior='2026-10-01T20:00:00.000Z';
  const consensusNfp=fixtureDatum('90000','persons','US_NFP_CHANGE',prior);
  const consensusWages=fixtureDatum('0.3','percent_mom','US_AHE_MOM',prior);
  return {config:demoScenarioConfig(),now:FIXTURE_NOW,snapshot:{
    snapshotId:`synthetic-${direction.toLowerCase()}-2026-10-02`,location:`fixtures/${direction.toLowerCase()}.json`,environment:'testnet',synthetic:true,
    quote:{exchange:'BYBIT',symbol:'BTCUSDT',category:'linear',quoteCurrency:'USDT',environment:'testnet',
      bid:short?'84999':'84000',ask:short?'85000':'84001',last:short?'85000':'84000',mark:short?'85000':'84000',provenance:fixtureProvenance(quoteAt)},
    usdPerUsdt:{...fixtureDatum('1','USD_PER_USDT','USD_USDT',quoteAt),period:'2026-10-02'},
    calendar:{eventId:'bls-employment-2026-09',period:'2026-09',scheduledAtUtc:RELEASE,provenance:fixtureProvenance('2026-10-02T11:00:00.000Z')},
    employment:{eventId:'bls-employment-2026-09',period:'2026-09',releasedAtUtc:RELEASE,
      nfp:fixtureDatum(short?'180000':'80000','persons','US_NFP_CHANGE'),unemployment:fixtureDatum(short?'4.0':'4.2','percent','US_UNEMPLOYMENT_RATE'),
      wages:fixtureDatum('0.3','percent_mom','US_AHE_MOM'),provenance:{...fixtureProvenance(RELEASE),publishedAt:RELEASE}},
    consensus:{eventId:'bls-employment-2026-09',period:'2026-09',frozenAtUtc:'2026-10-01T20:01:00.000Z',nfp:consensusNfp,wages:consensusWages},
    treasury:[31,36,41,46].map(min=>({...fixtureDatum(short?'5.4':'5.1','percent','US10Y_NOMINAL',`2026-10-02T12:${min}:00.000Z`),frequency:'intraday' as const})),
    etf:{sessionDate:'2026-10-01',expectedFunds:['SYNTH_A','SYNTH_B'],funds:[
      {fund:'SYNTH_A',netFlowUsd:short?'-2000000':'2000000',rawValue:short?'-2.0':'2.0'},
      {fund:'SYNTH_B',netFlowUsd:'0',rawValue:'0.0'}],totalUsd:short?'-2000000':'2000000',complete:true,unit:'USD',provenance:fixtureProvenance('2026-10-02T01:00:00.000Z')},
    marketCalendar:{calendarId:'synthetic-nyse-2026',coverageFrom:'2026-10-01',coverageTo:'2026-10-03',sessions:[
      {sessionDate:'2026-10-01',closeAtUtc:'2026-10-01T20:00:00.000Z'},
      {sessionDate:'2026-10-02',closeAtUtc:'2026-10-02T20:00:00.000Z'}],provenance:fixtureProvenance('2026-10-01T00:00:00.000Z')},providerErrors:[],
  }};
}
