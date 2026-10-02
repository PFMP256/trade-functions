import { describe, expect, it } from 'vitest';
import { fixtureProvenance, makeFixture } from '../../../../fixtures';
import { anyScenarioConfigSchema, evaluationSchema, PUBLIC_NFP_STRATEGY_ID, publicNfpScenarioConfigSchema, scenarioConfigSchema } from '../../../shared/src';
import { evaluateScenario, evaluateBtcNfpObservedV1 } from '../src';
import { makePublicFixture } from './fixtures';

type Fixture=ReturnType<typeof makePublicFixture>;
const run=(f:Fixture)=>evaluateScenario(f.snapshot,f.config,f.now);
const block=(f:Fixture,code:string)=>{const result=run(f);expect(result.decision).toBe('NO_TRADE');expect(result.reasonCodes).toContain(code);};

describe('public observed-employment configuration and identity',()=>{
  it('adds a separate config without changing the legacy schema',()=>{
    const legacy=makeFixture().config,publicConfig=makePublicFixture().config;
    expect(scenarioConfigSchema.safeParse(legacy).success).toBe(true);
    expect(scenarioConfigSchema.safeParse(publicConfig).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse(legacy).success).toBe(false);
    expect(anyScenarioConfigSchema.safeParse(legacy).success).toBe(true);
    expect(anyScenarioConfigSchema.safeParse(publicConfig).success).toBe(true);
  });
  it('does not accept consensus or bond settings disguised as the public strategy',()=>{
    const config=makePublicFixture().config;
    expect(publicNfpScenarioConfigSchema.safeParse({...config,minTreasuryObservations:4}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...config,thresholds:{...config.thresholds,nfpWeakMaxPersons:'90000'}}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...config,freshness:{...config.freshness,treasurySeconds:300}}).success).toBe(false);
  });
  it('requires conflict blocking and the documented 15-minute wait',()=>{
    const f=makePublicFixture();
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,confirmationMinutes:0}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,conflictingMacroPolicy:'REQUIRE_UNIQUE_DIRECTION'}).success).toBe(false);
  });
  it('retains 100 USD nominal, 1x, and net RR floor 1.5',()=>{
    const f=makePublicFixture();
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,execution:{...f.config.execution,leverage:'10'}}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,execution:{...f.config.execution,targetPositionNotionalUsd:'1000'}}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,minRewardRisk:'1.49'}).success).toBe(false);
  });
  it('rejects invalid validity window and mode/environment mismatch',()=>{
    const f=makePublicFixture();
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,expiresAtUtc:f.config.validFromUtc}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,tradingMode:'live',environment:'testnet'}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,tradingMode:'testnet',environment:'mainnet'}).success).toBe(false);
  });
  it('requires a bounded percentage threshold and integer NFP threshold',()=>{
    const f=makePublicFixture();
    for(const value of ['-0.1','100.000000000000000001']) expect(publicNfpScenarioConfigSchema.safeParse({...f.config,thresholds:{...f.config.thresholds,unemploymentLongPct:value}}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,thresholds:{...f.config.thresholds,nfpShortPersons:'150000.5'}}).success).toBe(false);
    expect(publicNfpScenarioConfigSchema.safeParse({...f.config,thresholds:{...f.config.thresholds,nfpShortPersons:'-10000'}}).success).toBe(true);
  });
});

describe('observed BLS employment predicates',()=>{
  it.each(['LONG','SHORT'] as const)('produces audited %s without private fundamental feeds',direction=>{
    const f=makePublicFixture(direction),before=JSON.stringify(f),result=run(f);
    expect(result.decision).toBe(direction);expect(result.strategyId).toBe(PUBLIC_NFP_STRATEGY_ID);
    expect(result.risk!.valid).toBe(true);expect(evaluationSchema.safeParse(result).success).toBe(true);
    expect(result.etfSession).toBeNull();expect(result.treasuryWindow).toBeNull();
    expect(result.missingData).toEqual([]);expect(JSON.stringify(f)).toBe(before);
    expect(evaluateBtcNfpObservedV1(f.snapshot,f.config,new Date(f.now))).toEqual(result);
    expect(result.execution.status).toBe('NOT_REQUESTED');expect(result.validationStatus).toBe('UNVALIDATED');
    expect(result.evaluatedAtLocal).toBe('2026-10-02T06:46:30.000-06:00');
  });
  it('unemployment exactly 4.2 enables LONG',()=>{const f=makePublicFixture();f.snapshot.employment!.unemployment!.value='4.2';expect(run(f).decision).toBe('LONG');});
  it('NFP exactly 150000 does not enable SHORT',()=>{const f=makePublicFixture('SHORT');f.snapshot.employment!.nfp!.value='150000';block(f,'CONDITIONS_NOT_MET');});
  it('NFP 150001 enables SHORT when unemployment is below 4.2',()=>{const f=makePublicFixture('SHORT');f.snapshot.employment!.nfp!.value='150001';expect(run(f).decision).toBe('SHORT');});
  it('NFP below 90000 is not an independent LONG condition',()=>{const f=makePublicFixture();f.snapshot.employment!.nfp!.value='50000';f.snapshot.employment!.unemployment!.value='4.1';block(f,'CONDITIONS_NOT_MET');});
  it('mixed observed conditions block regardless of potential RR',()=>{const f=makePublicFixture();f.snapshot.employment!.nfp!.value='180000';block(f,'CONFLICTING_MACRO');});
  it('both false returns NO_TRADE',()=>{const f=makePublicFixture();f.snapshot.employment!.unemployment!.value='4.19';block(f,'CONDITIONS_NOT_MET');});
  it.each(['nfp','unemployment'] as const)('missing %s stays unknown and cannot enable the opposite direction',key=>{
    const f=makePublicFixture();f.snapshot.employment![key]=null;
    block(f,'MISSING_DATA');block(f,'MACRO_UNKNOWN');expect(run(f).conditions.some(c=>c.result==='unknown')).toBe(true);
  });
  it('missing wages and all removed sources never block',()=>{const f=makePublicFixture();expect(f.snapshot.employment!.wages).toBeNull();expect(f.snapshot.consensus).toBeNull();expect(run(f).decision).toBe('LONG');});
  it('unrelated context never influences direction or validates as required provenance',()=>{
    const f=makePublicFixture(),legacy=makeFixture('SHORT').snapshot;
    f.snapshot.consensus=legacy.consensus;f.snapshot.treasury=legacy.treasury;f.snapshot.etf=legacy.etf;f.snapshot.marketCalendar=legacy.marketCalendar;
    f.snapshot.employment!.wages=legacy.employment!.wages;
    f.snapshot.consensus!.nfp!.provenance.verified=false;
    f.snapshot.treasury[0]!.provenance.conflicts=['unrelated context'];
    f.snapshot.etf!.complete=false;f.snapshot.employment!.wages!.value='999';
    expect(run(f).decision).toBe('LONG');expect(run(f).conditions.map(c=>c.name)).toEqual(['macroLong','macroShort','publicationWait']);
  });
});

describe('publication, provenance, and revision timing',()=>{
  it('waits before scheduled publication',()=>{const f=makePublicFixture();f.now='2026-10-02T12:29:00Z';f.snapshot.employment=null;block(f,'WAITING_FOR_NFP');expect(run(f).status).toBe('WAITING');});
  it('scheduled time does not prove publication',()=>{const f=makePublicFixture();f.snapshot.employment=null;block(f,'WAITING_FOR_NFP');});
  it('honors the updated calendar instead of the preset time',()=>{const f=makePublicFixture();f.snapshot.calendar!.scheduledAtUtc='2026-10-02T14:30:00Z';block(f,'WAITING_FOR_NFP');});
  it('waits 15 minutes from delayed initial BLS detection',()=>{
    const f=makePublicFixture(),report=f.snapshot.employment!,detected='2026-10-02T12:40:00Z';
    report.releasedAtUtc=detected;report.provenance=fixtureProvenance(detected);
    report.nfp!.provenance=fixtureProvenance(detected);report.unemployment!.provenance=fixtureProvenance(detected);
    block(f,'WAITING_FOR_CONFIRMATION');
  });
  it('wait is complete exactly at 15 minutes',()=>{
    const f=makePublicFixture();f.now='2026-10-02T12:45:00Z';
    f.snapshot.quote!.provenance=fixtureProvenance(f.now);f.snapshot.usdPerUsdt!.provenance=fixtureProvenance(f.now);
    expect(run(f).decision).toBe('LONG');
  });
  it('new known revisions do not reset the initial detection wait',()=>{
    const f=makePublicFixture(),report=f.snapshot.employment!;
    const revision={...fixtureProvenance('2026-10-02T12:46:00Z'),revision:'revision-2'};
    report.provenance={...revision};report.nfp!.provenance={...revision};report.unemployment!.provenance={...revision};
    const result=run(f);expect(result.decision).toBe('LONG');expect(result.employmentPublication!.releasedAtUtc).toBe('2026-10-02T12:30:00.000Z');expect(result.employmentPublication!.revision).toBe('revision-2');
  });
  it('different report versions cannot be combined',()=>{const f=makePublicFixture();f.snapshot.employment!.nfp!.provenance.revision='other-version';block(f,'REPORT_REVISION_MISMATCH');});
  it('future revisions cannot leak into historical evaluations',()=>{const f=makePublicFixture();f.snapshot.employment!.nfp!.provenance=fixtureProvenance('2026-10-03T12:00:00Z');block(f,'FUTURE_DATA');});
  it('publication availability cannot predate persisted initial detection',()=>{const f=makePublicFixture();f.snapshot.employment!.nfp!.provenance=fixtureProvenance('2026-10-02T12:29:00Z');block(f,'INVALID_PUBLICATION_TIME');});
  it.each(['report','calendar','datum'] as const)('rejects wrong %s period',target=>{
    const f=makePublicFixture();if(target==='report')f.snapshot.employment!.period='2026-08';else if(target==='calendar')f.snapshot.calendar!.period='2026-08';else f.snapshot.employment!.nfp!.period='2026-08';block(f,'NFP_PERIOD_MISMATCH');
  });
  it('rejects unit, series and fractional NFP contradictions',()=>{
    const f=makePublicFixture();f.snapshot.employment!.nfp!.unit='thousands';block(f,'UNIT_MISMATCH');
    f.snapshot.employment!.nfp!.unit='persons';f.snapshot.employment!.nfp!.seriesId='OTHER';block(f,'SERIES_MISMATCH');
    f.snapshot.employment!.nfp!.seriesId='US_NFP_CHANGE';f.snapshot.employment!.nfp!.value='80000.5';block(f,'NFP_VALUE_INVALID');
  });
  it.each(['-0.1','100.000000000000000001'])('rejects impossible unemployment percentage %s',value=>{const f=makePublicFixture();f.snapshot.employment!.unemployment!.value=value;block(f,'UNEMPLOYMENT_VALUE_INVALID');});
  it('rejects unverified sources and unresolved contradictions',()=>{const f=makePublicFixture();f.snapshot.employment!.provenance.verified=false;block(f,'UNVERIFIED_SOURCE');f.snapshot.employment!.provenance.verified=true;f.snapshot.employment!.provenance.conflicts=['conflict'];block(f,'SOURCE_CONFLICT');});
  it('does not invent a publishedAt value',()=>{const f=makePublicFixture();f.snapshot.employment!.provenance.publishedAt=null;expect(run(f).decision).toBe('LONG');expect(run(f).sources.some(s=>s.publishedAt===null)).toBe(true);});
  it('rejects impossible fetch/availability ordering',()=>{const f=makePublicFixture();f.snapshot.employment!.provenance.fetchedAt='2026-10-02T12:29:00Z';block(f,'INVALID_PROVENANCE');});
});

describe('market and execution prerequisites',()=>{
  it.each([['quote','QUOTE_MISSING'],['usdPerUsdt','FX_MISSING'],['calendar','CALENDAR_MISSING']] as const)('requires %s', (key,code)=>{const f=makePublicFixture();f.snapshot[key]=null;block(f,code);});
  it.each([['quote','QUOTE_STALE'],['usdPerUsdt','FX_STALE'],['calendar','CALENDAR_STALE']] as const)('rejects stale %s despite a recent fetch',(key,code)=>{
    const f=makePublicFixture();f.snapshot[key]!.provenance.observedAt=key==='calendar'?'2026-09-30T12:00:00Z':'2026-10-02T12:40:00Z';block(f,code);
  });
  it('rejects crossed book and future price',()=>{const f=makePublicFixture();f.snapshot.quote!.bid='90000';block(f,'CROSSED_BOOK');f.snapshot.quote!.bid='84000';f.snapshot.quote!.provenance.observedAt='2026-10-02T12:47:00Z';block(f,'FUTURE_DATA');});
  it('does not assume USD/USDT parity or invert an unspecified rate',()=>{const f=makePublicFixture();f.snapshot.usdPerUsdt!.unit='USDT_PER_USD';block(f,'CURRENCY_MISMATCH');f.snapshot.usdPerUsdt!.unit='USD_PER_USDT';f.snapshot.usdPerUsdt!.value='0';block(f,'CURRENCY_MISMATCH');});
  it('requires the correct FX series as well as its unit',()=>{const f=makePublicFixture();f.snapshot.usdPerUsdt!.seriesId='EUR_USDT';block(f,'FX_SERIES_MISMATCH');});
  it('uses a non-par USD/USDT rate in risk levels',()=>{const f=makePublicFixture();f.snapshot.usdPerUsdt!.value='1.01';const r=run(f);expect(r.risk!.takeProfitUsdt).not.toBe('87400');});
  it('uses ask for LONG and bid for SHORT',()=>{const f=makePublicFixture();expect(run(f).candidateEntryUsdt).toBe(f.snapshot.quote!.ask);const g=makePublicFixture('SHORT');expect(run(g).candidateEntryUsdt).toBe(g.snapshot.quote!.bid);});
  it('requires explicit cost and funding assumptions',()=>{const f=makePublicFixture();const config=structuredClone(f.config) as unknown as Record<string,unknown>;delete config.costs;expect(evaluateScenario(f.snapshot,config,f.now).reasonCodes).toContain('CONFIG_INVALID');});
  it('blocks insufficient RR and never moves TP/SL',()=>{const f=makePublicFixture();f.snapshot.quote!.bid='85999';f.snapshot.quote!.ask='86000';block(f,'RR_BELOW_MINIMUM');expect(run(f).risk!.takeProfitUsdt).toBe('87400');});
  it('blocks invalid TP/SL geometry',()=>{const f=makePublicFixture();f.snapshot.quote!.bid='87999';f.snapshot.quote!.ask='88000';block(f,'INVALID_TP_SL');});
  it('provider errors are ERROR and invalidate an earlier signal',()=>{const f=makePublicFixture();expect(run(f).decision).toBe('LONG');f.snapshot.providerErrors=['BLS unavailable'];block(f,'PROVIDER_FAILURE');expect(run(f).status).toBe('ERROR');expect(run(f).validUntilUtc).toBe(f.now);});
  it('rejects mixed Bybit environments',()=>{const f=makePublicFixture();f.snapshot.quote!.environment='mainnet';block(f,'ENVIRONMENT_MISMATCH');});
});

describe('validity, reproducibility and live gating',()=>{
  it('expires exactly at the original expiry without shifting dates',()=>{const f=makePublicFixture();f.now=f.config.expiresAtUtc;block(f,'SCENARIO_EXPIRED');});
  it('waits before the original scenario validity window',()=>{const f=makePublicFixture();f.now='2026-10-01T21:40:59Z';block(f,'SCENARIO_NOT_STARTED');});
  it('signal validity includes source expiry and the next scheduled boundary',()=>{
    const f=makePublicFixture();expect(run(f).validUntilUtc).toBe('2026-10-02T12:47:20.000Z');
    f.config.freshness.quoteSeconds=1000;f.config.freshness.fxSeconds=1000;expect(run(f).validUntilUtc).toBe('2026-10-02T12:50:00.000Z');
    f.config.expiresAtUtc='2026-10-02T12:47:00Z';expect(run(f).validUntilUtc).toBe('2026-10-02T12:47:00.000Z');
  });
  it('identical inputs are deterministic; a known data version changes the audit hash',()=>{const f=makePublicFixture(),a=run(f);expect(run(f)).toEqual(a);f.snapshot.employment!.provenance.evidenceSha256='a'.repeat(64);const b=run(f);expect(b.snapshot.hash).not.toBe(a.snapshot.hash);expect(b.evaluationId).not.toBe(a.evaluationId);});
  it('demo and unvalidated labels do not block live when substantive checks pass or invent validation',()=>{
    const f=makePublicFixture();Object.assign(f.config,{tradingMode:'live',environment:'mainnet'});
    // Model non-synthetic provider input only inside this unit test; no fixture is sent to an exchange.
    f.snapshot=JSON.parse(JSON.stringify(f.snapshot,(key,value)=>key==='synthetic'?false:value));
    f.snapshot.environment='mainnet';f.snapshot.quote!.environment='mainnet';
    const result=run(f);expect(result.decision).toBe('LONG');expect(result.validationStatus).toBe('UNVALIDATED');
    expect(f.config.demo).toBe(true);expect(f.config.sourcesValidated).toBe(false);
    f.snapshot.employment!.provenance.verified=false;block(f,'UNVERIFIED_SOURCE');
  });
  it('synthetic snapshots and synthetic provenance remain blocked in live',()=>{
    const f=makePublicFixture();Object.assign(f.config,{tradingMode:'live',environment:'mainnet',demo:false,sourcesValidated:true,validationStatus:'VALIDATED'});
    block(f,'DEMO_NOT_LIVE');f.snapshot.synthetic=false;f.snapshot.environment='mainnet';f.snapshot.quote!.environment='mainnet';block(f,'DEMO_NOT_LIVE');
  });
  it('pausing entries does not erase a valid macro decision; the executor owns that gate',()=>{const f=makePublicFixture();f.config.allowNewEntries=false;expect(run(f).decision).toBe('LONG');expect(run(f).execution.status).toBe('NOT_REQUESTED');});
  it('invalid snapshot produces a validated NO_TRADE response',()=>{const f=makePublicFixture();const r=evaluateScenario({},f.config,f.now);expect(r.reasonCodes).toContain('SNAPSHOT_INVALID');expect(evaluationSchema.safeParse(r).success).toBe(true);});
});
