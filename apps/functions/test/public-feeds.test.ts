import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFixture } from '../../../fixtures';
import { demoScenarioConfig } from '../../../scenarios';
import { makePublicFixture } from '../../../packages/strategies/btc-strategy-nfp-observed-v1/test/fixtures';
import { BlsPublicProvider } from '../../../packages/data-providers/src/bls-public';
import { KrakenFxProvider } from '../../../packages/data-providers/src/kraken-fx';
import { ProviderError } from '../../../packages/data-providers/src/http';
import { structuredFeedSchema } from '../../../packages/data-providers/src/structured';
import { PublicDataStore } from '../src/public-data-store';
import { fetchPublicFeeds } from '../src/public-feeds';

// All adapter outputs are synthetic fixtures. Prototype spies prevent both network and Firestore access.
function harness() {
  const fixture=makeFixture();const config=demoScenarioConfig();
  const {usdPerUsdt,calendar,employment,consensus,treasury,etf,marketCalendar}=fixture.snapshot;
  const ingested=structuredFeedSchema.parse({usdPerUsdt,calendar,employment,consensus,treasury,etf,marketCalendar});
  const publicCalendar=structuredClone(calendar!);publicCalendar.provenance.sourceId='mock-bls-calendar';
  const publicEmployment=structuredClone(employment!);publicEmployment.provenance.sourceId='mock-bls-employment';
  const publicFx=structuredClone(usdPerUsdt!);publicFx.value='1.0005';publicFx.provenance.sourceId='mock-kraken-fx';
  const content='SYNTHETIC PUBLIC FEED TEST EVIDENCE';
  const evidence=[{sha256:createHash('sha256').update(content).digest('hex'),content}];
  const calendarSpy=vi.spyOn(BlsPublicProvider.prototype,'getCalendar').mockResolvedValue({data:publicCalendar,evidence});
  const employmentSpy=vi.spyOn(BlsPublicProvider.prototype,'getEmployment').mockResolvedValue({data:publicEmployment,evidence});
  const fxSpy=vi.spyOn(KrakenFxProvider.prototype,'getUsdPerUsdt').mockResolvedValue({data:publicFx,evidence});
  const previous=vi.spyOn(PublicDataStore.prototype,'previous').mockResolvedValue(null);
  const record=vi.spyOn(PublicDataStore.prototype,'record').mockImplementation(async(_key,data)=>structuredClone(data) as never);
  const store=new PublicDataStore({} as Firestore);
  return {config,ingested,publicCalendar,publicEmployment,publicFx,evidence,calendarSpy,employmentSpy,fxSpy,previous,record,store};
}

afterEach(()=>vi.restoreAllMocks());

describe('public-feed runtime integration without network or Firestore',()=>{
  it('combines public BLS/FX with the ingested consensus, treasury, ETF and market calendar without mutation',async()=>{
    const h=harness();const original=structuredClone(h.ingested);
    const result=await fetchPublicFeeds(h.config,h.store,h.ingested);
    expect(result.errors).toEqual([]);
    expect(result.structured.calendar).toEqual(h.publicCalendar);
    expect(result.structured.employment).toEqual(h.publicEmployment);
    expect(result.structured.usdPerUsdt).toEqual(h.publicFx);
    for(const field of ['consensus','treasury','etf','marketCalendar'] as const)expect(result.structured[field]).toEqual(original[field]);
    expect(h.ingested).toEqual(original);expect(result.structured).not.toBe(h.ingested);
    const prefix=`${h.config.environment}:${h.config.event.eventId}`;
    expect(h.calendarSpy).toHaveBeenCalledWith(h.config.event,null);
    expect(h.employmentSpy).toHaveBeenCalledWith(h.config.event,null);
    expect(h.fxSpy).toHaveBeenCalledWith(null);
    expect(h.record).toHaveBeenCalledWith(`${prefix}:calendar`,h.publicCalendar,h.evidence);
    expect(h.record).toHaveBeenCalledWith(`${prefix}:employment`,h.publicEmployment,h.evidence);
    expect(h.record).toHaveBeenCalledWith(`${h.config.environment}:usdPerUsdt`,h.publicFx,h.evidence);
  });

  it('passes the prior persisted source revision to each adapter',async()=>{
    const h=harness();
    h.previous.mockImplementation(async key=>(key.endsWith(':calendar')?h.publicCalendar:key.endsWith(':employment')?h.publicEmployment:h.publicFx) as never);
    await fetchPublicFeeds(h.config,h.store,h.ingested);
    expect(h.calendarSpy).toHaveBeenCalledWith(h.config.event,h.publicCalendar);
    expect(h.employmentSpy).toHaveBeenCalledWith(h.config.event,h.publicEmployment);
    expect(h.fxSpy).toHaveBeenCalledWith(h.publicFx);
  });

  it('fails closed on an invalid operator BLS contact instead of silently dropping it',async()=>{
    const h=harness();
    await expect(fetchPublicFeeds(h.config,h.store,undefined,{blsContact:'not a contact'})).rejects.toThrow('BLS_INVALID_CONTACT');
    expect(h.calendarSpy).not.toHaveBeenCalled();expect(h.employmentSpy).not.toHaveBeenCalled();
    expect((await fetchPublicFeeds(h.config,h.store,undefined,{blsContact:'https://example.org/bls-contact'})).errors).toEqual([]);
  });

  it('does not invent a missing external consensus, treasury stream or ETF report',async()=>{
    const h=harness();const result=await fetchPublicFeeds(h.config,h.store,undefined);
    expect(result.errors).toEqual([]);expect(result.structured.consensus).toBeNull();
    expect(result.structured.treasury).toEqual([]);expect(result.structured.etf).toBeNull();
    expect(result.structured.marketCalendar?.coverageFrom).toBe('2026-01-01');
    expect(result.structured.marketCalendar?.coverageTo).toBe('2026-12-31');
    expect(result.structured.marketCalendar?.sessions.some(session=>session.sessionDate==='2026-09-07')).toBe(false);
  });

  it('null September employment means waiting for publication and never reuses an ingested report',async()=>{
    const h=harness();h.employmentSpy.mockResolvedValue({data:null,evidence:h.evidence});
    const result=await fetchPublicFeeds(h.config,h.store,h.ingested);
    expect(result.errors).toEqual([]);expect(result.structured.employment).toBeNull();
    expect(result.structured.calendar).toEqual(h.publicCalendar);
    expect(h.record.mock.calls.some(([key])=>key.endsWith(':employment'))).toBe(false);
    expect(result.structured.consensus).toEqual(h.ingested.consensus);
  });

  it('returns all independent source failures explicitly and clears their values without fallback',async()=>{
    const h=harness();
    h.calendarSpy.mockRejectedValue(new ProviderError('BLS_HTTP_503'));
    h.employmentSpy.mockRejectedValue(new Error('private backend response must never escape'));
    h.fxSpy.mockRejectedValue(new ProviderError('KRAKEN_FX_INVALID_RESPONSE'));
    const result=await fetchPublicFeeds(h.config,h.store,h.ingested);
    expect(result.errors).toEqual(['BLS_HTTP_503','BLS_EMPLOYMENT_PROVIDER_FAILURE','KRAKEN_FX_INVALID_RESPONSE']);
    expect(result.structured.calendar).toBeNull();expect(result.structured.employment).toBeNull();expect(result.structured.usdPerUsdt).toBeNull();
    expect(result.structured.consensus).toEqual(h.ingested.consensus);expect(result.structured.treasury).toEqual(h.ingested.treasury);
    expect(result.structured.etf).toEqual(h.ingested.etf);expect(h.record).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private backend');
  });

  it('reports calendar and numeric employment conflicts once, while preserving the authoritative public observations',async()=>{
    const h=harness();h.publicCalendar.scheduledAtUtc='2026-10-02T13:00:00.000Z';
    h.publicEmployment.nfp!.value='81000';h.publicEmployment.wages!.value='0.4';
    const result=await fetchPublicFeeds(h.config,h.store,h.ingested);
    expect(result.errors).toEqual(['CALENDAR_SOURCE_CONFLICT','EMPLOYMENT_SOURCE_CONFLICT']);
    expect(result.structured.calendar?.scheduledAtUtc).toBe('2026-10-02T13:00:00.000Z');
    expect(result.structured.employment?.nfp?.value).toBe('81000');
    expect(h.ingested.calendar?.scheduledAtUtc).toBe('2026-10-02T12:30:00.000Z');
    expect(h.ingested.employment?.nfp?.value).toBe('80000');
  });

  it('compares instants and decimal values semantically rather than treating formatting as a conflict',async()=>{
    const h=harness();h.publicCalendar.scheduledAtUtc='2026-10-02T12:30:00Z';
    h.publicEmployment.nfp!.value='80000.0';h.publicEmployment.unemployment!.value='4.200';h.publicEmployment.wages!.value='0.3000';
    expect((await fetchPublicFeeds(h.config,h.store,h.ingested)).errors).toEqual([]);
  });

  it('treats an employment-unit mismatch as an unresolved source conflict',async()=>{
    const h=harness();h.publicEmployment.unemployment!.unit='fraction';
    expect((await fetchPublicFeeds(h.config,h.store,h.ingested)).errors).toContain('EMPLOYMENT_SOURCE_CONFLICT');
  });

  it('blocks a public observation when its evidence cannot be persisted and still returns other source outcomes',async()=>{
    const h=harness();h.record.mockImplementation(async(key,data)=>{
      if(key.endsWith(':employment'))throw new Error('private datastore failure');return structuredClone(data) as never;
    });
    const result=await fetchPublicFeeds(h.config,h.store,h.ingested);
    expect(result.errors).toEqual(['BLS_EMPLOYMENT_PROVIDER_FAILURE']);expect(result.structured.employment).toBeNull();
    expect(result.structured.calendar).toEqual(h.publicCalendar);expect(result.structured.usdPerUsdt).toEqual(h.publicFx);
    expect(JSON.stringify(result)).not.toContain('private datastore');
  });

  it('does not query a source after its previous-state read failed and does not disguise that failure as a valid old value',async()=>{
    const h=harness();h.previous.mockImplementation(async key=>{
      if(key.endsWith(':calendar'))throw new Error('private previous-state failure');return null as never;
    });
    const result=await fetchPublicFeeds(h.config,h.store,h.ingested);
    expect(result.errors).toEqual(['BLS_CALENDAR_PROVIDER_FAILURE']);expect(result.structured.calendar).toBeNull();
    expect(h.calendarSpy).not.toHaveBeenCalled();expect(h.employmentSpy).toHaveBeenCalledOnce();expect(h.fxSpy).toHaveBeenCalledOnce();
  });

  it('uses the canonical data returned by persistence when a concurrent newer source revision superseded the response',async()=>{
    const h=harness();const canonical=structuredClone(h.publicEmployment);canonical.nfp!.value='81000';canonical.provenance.revision='newer-synthetic-revision';
    h.record.mockImplementation(async(key,data)=>(key.endsWith(':employment')?canonical:structuredClone(data)) as never);
    const result=await fetchPublicFeeds(h.config,h.store,undefined);
    expect(result.errors).toEqual([]);expect(result.structured.employment).toEqual(canonical);
    expect(h.publicEmployment.nfp?.value).toBe('80000');
  });

  it('uses only public observations for the observed-NFP strategy even if legacy manual data conflicts',async()=>{
    const h=harness();const {config}=makePublicFixture();
    h.ingested.calendar!.scheduledAtUtc='2026-10-02T13:00:00.000Z';
    h.ingested.employment!.nfp!.value='1';h.ingested.employment!.unemployment!.value='99';
    h.ingested.etf!.complete=false;h.ingested.consensus!.nfp!.provenance.conflicts=['STALE_MANUAL_SOURCE'];
    const original=structuredClone(h.ingested);h.publicEmployment.wages=null;
    const result=await fetchPublicFeeds(config,h.store,h.ingested);
    expect(result.errors).toEqual([]);
    expect(result.structured.calendar).toEqual(h.publicCalendar);expect(result.structured.employment).toEqual(h.publicEmployment);
    expect(result.structured.usdPerUsdt).toEqual(h.publicFx);
    expect(result.structured.consensus).toBeNull();expect(result.structured.treasury).toEqual([]);
    expect(result.structured.etf).toBeNull();expect(result.structured.marketCalendar).toBeNull();
    expect(h.ingested).toEqual(original);
    expect(h.employmentSpy).toHaveBeenCalledWith(config.event,null,{requireWages:false});
    const key=`${config.environment}:${config.event.eventId}:employment:nfp-unemployment`;
    expect(h.record).toHaveBeenCalledWith(key,h.publicEmployment,h.evidence);
    expect(h.record.mock.calls.some(([value])=>value.endsWith(':employment'))).toBe(false);
  });

  it.each([false,true])('inherits first detection from the other public projection on first use (observed=%s)',async publicOnly=>{
    const h=harness();const config=publicOnly?makePublicFixture().config:h.config;
    const legacyKey=`${config.environment}:${config.event.eventId}:employment`;const observedKey=`${legacyKey}:nfp-unemployment`;
    const key=publicOnly?observedKey:legacyKey;const alternateKey=publicOnly?legacyKey:observedKey;
    const prior=structuredClone(h.publicEmployment);prior.releasedAtUtc='2026-10-02T12:30:05.000Z';
    if(!publicOnly)prior.wages=null;
    h.previous.mockImplementation(async candidate=>(candidate===alternateKey?prior:null) as never);
    h.employmentSpy.mockImplementation(async(_request,previous,options)=>({
      data:{...h.publicEmployment,releasedAtUtc:previous!.releasedAtUtc,wages:options?.requireWages===false?null:h.publicEmployment.wages},evidence:h.evidence,
    }));
    const result=await fetchPublicFeeds(config,h.store,undefined);
    expect(result.errors).toEqual([]);expect(result.structured.employment?.releasedAtUtc).toBe(prior.releasedAtUtc);
    expect(h.previous).toHaveBeenCalledWith(key);expect(h.previous).toHaveBeenCalledWith(alternateKey);
    if(publicOnly)expect(h.employmentSpy).toHaveBeenCalledWith(config.event,prior,{requireWages:false});
    else expect(h.employmentSpy).toHaveBeenCalledWith(config.event,prior);
    expect(h.record).toHaveBeenCalledWith(key,result.structured.employment,h.evidence);
    expect(h.record.mock.calls.some(([candidate])=>candidate===alternateKey)).toBe(false);
  });

  it('keeps same-document projections in distinct revision archives',async()=>{
    const h=harness();const config=makePublicFixture().config;
    h.employmentSpy.mockImplementation(async(_request,_previous,options)=>({
      data:{...h.publicEmployment,wages:options?.requireWages===false?null:h.publicEmployment.wages},evidence:h.evidence,
    }));
    const archived=new Map<string,unknown>();
    h.record.mockImplementation(async(key,data)=>{
      const previous=archived.get(key);
      if(previous && JSON.stringify(previous)!==JSON.stringify(data))throw new ProviderError('PUBLIC_REVISION_CONFLICT');
      archived.set(key,structuredClone(data));return structuredClone(data) as never;
    });
    const legacy=await fetchPublicFeeds(h.config,h.store,undefined);
    const observed=await fetchPublicFeeds(config,h.store,undefined);
    expect(legacy.errors).toEqual([]);expect(observed.errors).toEqual([]);
    expect(legacy.structured.employment?.wages).not.toBeNull();expect(observed.structured.employment?.wages).toBeNull();
    expect(legacy.structured.employment?.provenance.revision).toBe(observed.structured.employment?.provenance.revision);
    const prefix=`${config.environment}:${config.event.eventId}:employment`;
    expect(archived.has(prefix)).toBe(true);expect(archived.has(`${prefix}:nfp-unemployment`)).toBe(true);
  });

  it('does not fall back to any manual data when required public sources fail for observed NFP',async()=>{
    const h=harness();const {config}=makePublicFixture();
    h.calendarSpy.mockRejectedValue(new ProviderError('BLS_HTTP_503'));
    h.employmentSpy.mockResolvedValue({data:null,evidence:h.evidence});
    h.fxSpy.mockRejectedValue(new ProviderError('KRAKEN_FX_INVALID_RESPONSE'));
    const result=await fetchPublicFeeds(config,h.store,h.ingested);
    expect(result.errors).toEqual(['BLS_HTTP_503','KRAKEN_FX_INVALID_RESPONSE']);
    for(const field of ['calendar','employment','usdPerUsdt','consensus','etf','marketCalendar'] as const)expect(result.structured[field]).toBeNull();
    expect(result.structured.treasury).toEqual([]);expect(h.record).not.toHaveBeenCalled();
  });
});
