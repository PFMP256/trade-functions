import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { makeFixture, fixtureProvenance } from '../../../../fixtures';
import { scenarioConfigSchema, snapshotSchema, evaluationSchema, sha256 } from '../../../shared/src';
import { evaluateBtcNfpEtfV1, evaluateScenario, calculateRisk, triOr } from '../src';

const run = (f:ReturnType<typeof makeFixture>) => evaluateScenario(f.snapshot,f.config,f.now);
function expectBlocked(f:ReturnType<typeof makeFixture>,code:string):void {
  const result=run(f);expect(result.decision).toBe('NO_TRADE');expect(result.reasonCodes).toContain(code);
}
describe('pure BTC NFP ETF evaluator',()=>{
  it.each(['LONG','SHORT'] as const)('produces a deterministic auditable %s with synthetic data',direction=>{
    const f=makeFixture(direction), before=JSON.stringify(f);
    const evaluation=run(f);
    expect(evaluation.decision).toBe(direction);expect(evaluation.risk?.valid).toBe(true);
    expect(evaluationSchema.safeParse(evaluation).success).toBe(true);
    expect(evaluateBtcNfpEtfV1(f.snapshot,f.config,new Date(f.now))).toEqual(evaluation);
    expect(JSON.stringify(f)).toBe(before);
    expect(evaluation.evaluatedAtLocal).toBe('2026-10-02T06:46:30.000-06:00');
    expect(evaluation.validUntilUtc).toBe('2026-10-02T12:47:20.000Z');
    expect(evaluation.execution.status).toBe('NOT_REQUESTED');
  });
  it('canonical hash ignores object order but includes revisions',()=>{
    expect(sha256({b:2,a:1})).toBe(sha256({a:1,b:2}));
    const f=makeFixture(), a=run(f);f.snapshot.employment!.provenance.revision='v2';
    const b=run(f);expect(a.snapshot.hash).not.toBe(b.snapshot.hash);expect(a.evaluationId).not.toBe(b.evaluationId);
  });
  it('waits before scheduled event',()=>{const f=makeFixture();f.now='2026-10-02T12:29:00Z';f.snapshot.employment=null;expectBlocked(f,'WAITING_FOR_NFP');});
  it('scheduled time alone never proves publication',()=>{const f=makeFixture();f.snapshot.employment=null;expectBlocked(f,'WAITING_FOR_NFP');});
  it('uses rescheduled official calendar',()=>{const f=makeFixture();f.snapshot.calendar!.scheduledAtUtc='2026-10-02T14:30:00Z';f.snapshot.employment=null;expectBlocked(f,'WAITING_FOR_NFP');});
  it('waits 15 minutes from effective delayed publication',()=>{
    const f=makeFixture();f.snapshot.employment!.releasedAtUtc='2026-10-02T12:40:00Z';
    f.snapshot.employment!.provenance=fixtureProvenance('2026-10-02T12:40:00Z');expectBlocked(f,'WAITING_FOR_CONFIRMATION');
  });
  it('rejects wrong NFP period',()=>{const f=makeFixture();f.snapshot.employment!.period='2026-08';expectBlocked(f,'NFP_PERIOD_MISMATCH');});
  it('rejects wrong calendar period',()=>{const f=makeFixture();f.snapshot.calendar!.period='2026-08';expectBlocked(f,'NFP_PERIOD_MISMATCH');});
  it('rejects missing calendar',()=>{const f=makeFixture();f.snapshot.calendar=null;expectBlocked(f,'CALENDAR_MISSING');});
  it('rejects mixed macro signals before directional confirmations',()=>{const f=makeFixture();f.snapshot.employment!.wages!.value='0.4';expectBlocked(f,'CONFLICTING_MACRO');});
  it('can explicitly choose unique full-direction macro policy',()=>{const f=makeFixture();f.snapshot.employment!.wages!.value='0.4';f.config.conflictingMacroPolicy='REQUIRE_UNIQUE_DIRECTION';expect(run(f).decision).toBe('LONG');});
  it('uses unknown instead of false for absent wages',()=>{
    const f=makeFixture();f.snapshot.employment!.wages=null;
    expectBlocked(f,'MACRO_UNKNOWN');expect(run(f).conditions.find(c=>c.name==='macroShort')!.result).toBe('unknown');
  });
  it('true OR unknown is true but missing critical data still blocks',()=>{
    const f=makeFixture();f.snapshot.employment!.nfp=null;
    expect(run(f).conditions.find(c=>c.name==='macroLong')!.result).toBe(true);expectBlocked(f,'MISSING_DATA');
  });
  it.each([
    [true,'unknown',true], [false,'unknown','unknown'], ['unknown','unknown','unknown'], [false,false,false],
  ] as const)('three-state OR %s/%s = %s',(a,b,want)=>expect(triOr(a,b)).toBe(want));
  it('NFP equals consensus satisfies long',()=>{const f=makeFixture();f.snapshot.employment!.nfp!.value='90000';f.snapshot.employment!.unemployment!.value='4.1';expect(run(f).decision).toBe('LONG');});
  it('unemployment equals 4.2 satisfies long',()=>{const f=makeFixture();f.snapshot.employment!.nfp!.value='100000';expect(run(f).decision).toBe('LONG');});
  it('NFP equals 150000 does not satisfy short',()=>{const f=makeFixture('SHORT');f.snapshot.employment!.nfp!.value='150000';expectBlocked(f,'CONDITIONS_NOT_MET');});
  it('wages equality does not satisfy short',()=>{const f=makeFixture('SHORT');f.snapshot.employment!.nfp!.value='100000';expectBlocked(f,'CONDITIONS_NOT_MET');});
  it('strict wage upside independently satisfies short',()=>{const f=makeFixture('SHORT');f.snapshot.employment!.nfp!.value='100000';f.snapshot.employment!.wages!.value='0.3001';expect(run(f).decision).toBe('SHORT');});
  it.each([['LONG','5.15'],['SHORT','5.36']] as const)('treasury equality %s %s never confirms',(direction,value)=>{const f=makeFixture(direction);f.snapshot.treasury.forEach(t=>t.value=value);expectBlocked(f,'CONDITIONS_NOT_MET');});
  it('ETF zero is neutral, not missing',()=>{const f=makeFixture();f.snapshot.etf!.funds[0]!.netFlowUsd='0';f.snapshot.etf!.totalUsd='0';expectBlocked(f,'CONDITIONS_NOT_MET');expect(run(f).conditions.find(c=>c.name==='etfPositive')!.result).toBe(false);});
  it('partial ETF remains incomplete despite a displayed total',()=>{const f=makeFixture();f.snapshot.etf!.complete=false;expectBlocked(f,'ETF_INCOMPLETE');});
  it('missing fund cannot be zero',()=>{const f=makeFixture();f.snapshot.etf!.funds[1]!.netFlowUsd=null;f.snapshot.etf!.funds[1]!.rawValue='-';expectBlocked(f,'ETF_INCOMPLETE');});
  it('dynamic expected ETF coverage is mandatory',()=>{const f=makeFixture();f.snapshot.etf!.expectedFunds.push('NEW_FUND');expectBlocked(f,'ETF_INCOMPLETE');});
  it('duplicate ETF funds cannot fake full coverage',()=>{const f=makeFixture();f.snapshot.etf!.funds.push(f.snapshot.etf!.funds[0]!);expectBlocked(f,'ETF_INCOMPLETE');});
  it('audits effective ETF coverage rather than trusting complete flag',()=>{const f=makeFixture();f.snapshot.etf!.expectedFunds.push('MISSING');const r=run(f);expect(r.etfSession!.complete).toBe(false);expect(r.etfSession!.missingFunds).toEqual(['MISSING']);});
  it('checks ETF arithmetic',()=>{const f=makeFixture();f.snapshot.etf!.totalUsd='1';expectBlocked(f,'ETF_TOTAL_MISMATCH');});
  it('does not silently choose an older ETF session',()=>{const f=makeFixture();f.snapshot.etf!.sessionDate='2026-09-30';expectBlocked(f,'ETF_SESSION_MISMATCH');});
  it('does not use future report for current day',()=>{const f=makeFixture();f.snapshot.etf!.sessionDate='2026-10-02';expectBlocked(f,'ETF_SESSION_MISMATCH');});
  it('rejects unknown exchange calendar coverage',()=>{const f=makeFixture();f.snapshot.marketCalendar!.coverageTo='2026-10-01';expectBlocked(f,'MARKET_CALENDAR_UNAVAILABLE');});
  it('rejects ETF report available before session close',()=>{const f=makeFixture();f.snapshot.etf!.provenance=fixtureProvenance('2026-10-01T19:00:00Z');expectBlocked(f,'ETF_AVAILABLE_BEFORE_CLOSE');});
  it('uses the prior session across a market holiday represented by calendar',()=>{
    const f=makeFixture();f.snapshot.marketCalendar!.sessions=[{sessionDate:'2026-09-30',closeAtUtc:'2026-09-30T20:00:00Z'}];
    f.snapshot.etf!.sessionDate='2026-09-30';expect(run(f).decision).toBe('LONG');
  });
  it('requires four bond observations',()=>{const f=makeFixture();f.snapshot.treasury.splice(1,1);expectBlocked(f,'TREASURY_INSUFFICIENT_OBSERVATIONS');});
  it('rejects repeated observations rather than counting them',()=>{const f=makeFixture();f.snapshot.treasury[1]!.provenance=structuredClone(f.snapshot.treasury[0]!.provenance);expectBlocked(f,'TREASURY_DUPLICATE_OBSERVATION');});
  it('requires entire 15-minute span',()=>{const f=makeFixture();f.snapshot.treasury[0]!.provenance=fixtureProvenance('2026-10-02T12:32:00Z');expectBlocked(f,'TREASURY_INSUFFICIENT_OBSERVATIONS');});
  it('rejects gaps exceeding six minutes',()=>{const f=makeFixture();f.snapshot.treasury[1]!.provenance=fixtureProvenance('2026-10-02T12:32:00Z');expectBlocked(f,'TREASURY_GAP_TOO_LARGE');});
  it('observations from before publication never count',()=>{const f=makeFixture();f.snapshot.treasury[0]!.provenance=fixtureProvenance('2026-10-02T12:29:00Z');expectBlocked(f,'TREASURY_INSUFFICIENT_OBSERVATIONS');});
  it('requires strictly after publication, not equal',()=>{const f=makeFixture();f.snapshot.treasury[0]!.provenance=fixtureProvenance('2026-10-02T12:30:00Z');expectBlocked(f,'TREASURY_INSUFFICIENT_OBSERVATIONS');});
  it('historical pre-event points can coexist with four valid later observations',()=>{const f=makeFixture();f.snapshot.treasury.unshift({...f.snapshot.treasury[0]!,provenance:fixtureProvenance('2026-10-02T12:29:00Z')});expect(run(f).decision).toBe('LONG');});
  it('daily treasury feeds are rejected',()=>{const f=makeFixture();f.snapshot.treasury[0]!.frequency='daily';expectBlocked(f,'TREASURY_NOT_INTRADAY');});
  it('rejects stale latest bond observation even with a valid span',()=>{const f=makeFixture();f.now='2026-10-02T12:52:00Z';expectBlocked(f,'TREASURY_STALE');});
  it('all observations must stay on the confirming side',()=>{const f=makeFixture();f.snapshot.treasury[1]!.value='5.2';expectBlocked(f,'CONDITIONS_NOT_MET');});
  it('rejects consensus frozen after publication',()=>{const f=makeFixture();f.snapshot.consensus!.frozenAtUtc='2026-10-02T12:31:00Z';expectBlocked(f,'CONSENSUS_AFTER_EVENT');});
  it('rejects post-event consensus availability even if frozenAt claims otherwise',()=>{const f=makeFixture();f.snapshot.consensus!.nfp!.provenance=fixtureProvenance('2026-10-02T12:31:00Z');expectBlocked(f,'CONSENSUS_AFTER_EVENT');});
  it('future revision is not usable in historical evaluation',()=>{const f=makeFixture();f.snapshot.employment!.nfp!.provenance=fixtureProvenance('2026-10-03T10:00:00Z');expectBlocked(f,'FUTURE_DATA');});
  it('current known revised report keeps its revision in audit output',()=>{const f=makeFixture();f.snapshot.employment!.provenance.revision='revision-2';expect(run(f).employmentPublication?.revision).toBe('revision-2');});
  it('rejects mismatched wage series',()=>{const f=makeFixture();f.snapshot.consensus!.wages!.seriesId='US_AHE_YOY';expectBlocked(f,'SERIES_MISMATCH');});
  it('rejects fractions as wrong unit',()=>{const f=makeFixture();f.snapshot.employment!.unemployment!.unit='ratio';expectBlocked(f,'UNIT_MISMATCH');});
  it('stale quote blocks even if recently fetched',()=>{const f=makeFixture();f.snapshot.quote!.provenance.observedAt='2026-10-02T12:40:00Z';expectBlocked(f,'QUOTE_STALE');});
  it('stale exchange rate blocks',()=>{const f=makeFixture();f.snapshot.usdPerUsdt!.provenance.observedAt='2026-10-02T12:40:00Z';expectBlocked(f,'FX_STALE');});
  it('requires USD per USDT rather than inverse conversion',()=>{const f=makeFixture();f.snapshot.usdPerUsdt!.unit='USDT_PER_USD';expectBlocked(f,'CURRENCY_MISMATCH');});
  it('requires positive conversion',()=>{const f=makeFixture();f.snapshot.usdPerUsdt!.value='0';expectBlocked(f,'CURRENCY_MISMATCH');});
  it('does not assume parity when FX is absent',()=>{const f=makeFixture();f.snapshot.usdPerUsdt=null;expectBlocked(f,'FX_MISSING');});
  it('uses live ask for long, bid for short rather than historical reference',()=>{const f=makeFixture();expect(run(f).candidateEntryUsdt).toBe(f.snapshot.quote!.ask);const g=makeFixture('SHORT');expect(run(g).candidateEntryUsdt).toBe(g.snapshot.quote!.bid);});
  it('crossed bid/ask is invalid',()=>{const f=makeFixture();f.snapshot.quote!.bid='90000';expectBlocked(f,'CROSSED_BOOK');});
  it('does not silently provide zero funding when costs omitted',()=>{const f=makeFixture();const config=JSON.parse(JSON.stringify(f.config));delete config.costs.fundingToTpPerBtcUsdt;expect(evaluateScenario(f.snapshot,config,f.now).reasonCodes).toContain('CONFIG_INVALID');});
  it('blocks insufficient RR without changing levels',()=>{const f=makeFixture();f.snapshot.quote!.bid='85999';f.snapshot.quote!.ask='86000';expectBlocked(f,'RR_BELOW_MINIMUM');expect(run(f).risk!.takeProfitUsdt).toBe('87400');});
  it('blocks entry outside TP/SL',()=>{const f=makeFixture();f.snapshot.quote!.bid='87999';f.snapshot.quote!.ask='88000';expectBlocked(f,'INVALID_TP_SL');});
  it('expires exactly at expiresAtUtc without rolling dates',()=>{const f=makeFixture();f.now=f.config.expiresAtUtc;expectBlocked(f,'SCENARIO_EXPIRED');});
  it('expires signals at the next scheduler boundary even on a delayed run',()=>{const f=makeFixture();f.config.freshness.quoteSeconds=1000;f.config.freshness.fxSeconds=1000;f.config.freshness.treasurySeconds=1000;expect(run(f).validUntilUtc).toBe('2026-10-02T12:50:00.000Z');});
  it('configuration cannot reduce the net RR requirement below 1.5',()=>{const f=makeFixture();f.config.minRewardRisk='1.4';expectBlocked(f,'CONFIG_INVALID');});
  it('waits before validity window',()=>{const f=makeFixture();f.now='2026-10-01T21:40:59Z';expectBlocked(f,'SCENARIO_NOT_STARTED');});
  it('formats IANA zones and DST correctly',()=>{expect(DateTime.fromISO('2026-10-02T08:30:00',{zone:'America/New_York'}).toUTC().toISO()).toBe('2026-10-02T12:30:00.000Z');expect(DateTime.fromISO('2026-10-02T12:30:00Z').setZone('America/Mexico_City').hour).toBe(6);});
  it('unverified data blocks even in demo',()=>{const f=makeFixture();f.snapshot.employment!.provenance.verified=false;expectBlocked(f,'UNVERIFIED_SOURCE');});
  it('source conflicts are not arbitrarily resolved',()=>{const f=makeFixture();f.snapshot.employment!.provenance.conflicts=['different release'];expectBlocked(f,'SOURCE_CONFLICT');});
  it('provider failure is explicit and cannot reuse last good signal',()=>{const f=makeFixture();expect(run(f).decision).toBe('LONG');f.snapshot.providerErrors=['timeout treasury'];expectBlocked(f,'PROVIDER_FAILURE');});
  it('rejects testnet/mainnet mixing',()=>{const f=makeFixture();f.snapshot.quote!.environment='mainnet';expectBlocked(f,'ENVIRONMENT_MISMATCH');});
  it('demo and unvalidated labels do not block live when substantive checks pass or invent validation',()=>{
    const f=makeFixture();Object.assign(f.config,{tradingMode:'live',environment:'mainnet'});
    // Model non-synthetic provider input only inside this unit test; no fixture is sent to an exchange.
    f.snapshot=JSON.parse(JSON.stringify(f.snapshot,(key,value)=>key==='synthetic'?false:value));
    f.snapshot.environment='mainnet';f.snapshot.quote!.environment='mainnet';
    const result=run(f);expect(result.decision).toBe('LONG');expect(result.validationStatus).toBe('UNVALIDATED');
    expect(f.config.demo).toBe(true);expect(f.config.sourcesValidated).toBe(false);
    f.snapshot.employment!.provenance.verified=false;expectBlocked(f,'UNVERIFIED_SOURCE');
  });
  it('synthetic snapshot cannot produce a live signal',()=>{const f=makeFixture();Object.assign(f.config,{demo:false,tradingMode:'live',environment:'mainnet',validationStatus:'VALIDATED',sourcesValidated:true});expectBlocked(f,'DEMO_NOT_LIVE');});
  it('synthetic provenance cannot hide behind snapshot.synthetic=false',()=>{const f=makeFixture();Object.assign(f.config,{demo:false,tradingMode:'live',environment:'mainnet',validationStatus:'VALIDATED',sourcesValidated:true});f.snapshot.synthetic=false;f.snapshot.environment='mainnet';f.snapshot.quote!.environment='mainnet';expectBlocked(f,'DEMO_NOT_LIVE');});
  it('schema rejects extra fields and malformed timestamps',()=>{const f=makeFixture();expect(snapshotSchema.safeParse({...f.snapshot,unexpected:1}).success).toBe(false);expect(scenarioConfigSchema.safeParse({...f.config,expiresAtUtc:'today'}).success).toBe(false);});
});

describe('decimal net risk and conversion',()=>{
  const risk=(overrides:Partial<Parameters<typeof calculateRisk>[0]>={})=>{
    const f=makeFixture();return calculateRisk({direction:'LONG',entryUsdt:'84000',usdPerUsdt:'1',levels:f.config.levels.LONG,costs:f.config.costs,minRewardRisk:'1.5',...overrides});
  };
  it('uses exact decimal fee and loss arithmetic',()=>{const r=risk();expect(r.grossProfitPerBtc).toBe('3400');expect(r.grossLossPerBtc).toBe('1100');expect(r.costToTpPerBtc).toBe('121.75');expect(r.costToSlPerBtc).toBe('118.375');expect(r.netProfitPerBtc).toBe('3278.25');expect(r.netLossPerBtc).toBe('1218.375');});
  it('converts USD levels with USD per one USDT',()=>{const r=risk({usdPerUsdt:'0.98'});expect(r.takeProfitUsdt).toBe(new Decimal('87400').div('0.98').toFixed());});
  it('quantizes TP and SL inward for long',()=>{const r=risk({levels:{takeProfitUsd:'87400.19',stopLossUsd:'82900.11'},tickSize:'0.1'});expect(r.takeProfitUsdt).toBe('87400.1');expect(r.stopLossUsdt).toBe('82900.2');});
  it('quantizes TP and SL inward for short',()=>{const r=risk({direction:'SHORT',entryUsdt:'85000',levels:{takeProfitUsd:'82000.11',stopLossUsd:'86000.19'},tickSize:'0.1'});expect(r.takeProfitUsdt).toBe('82000.2');expect(r.stopLossUsdt).toBe('86000.1');});
  it('zero gross loss is invalid even when costs produce positive loss',()=>{expect(risk({entryUsdt:'82900'}).reasonCodes).toContain('INVALID_TP_SL');});
  it('costs can invalidate otherwise positive gross profit',()=>{expect(risk({entryUsdt:'87399'}).reasonCodes).toContain('RR_BELOW_MINIMUM');});
  it('returns no RR when net loss is nonpositive',()=>{const f=makeFixture();expect(risk({entryUsdt:'82000',costs:{...f.config.costs,entryFeeBps:'0',exitFeeBps:'0',exitSlippageBps:'0',fundingToTpPerBtcUsdt:'0',fundingToSlPerBtcUsdt:'0'}}).rewardRisk).toBeNull();});
  it('RR exactly 1.5 is sufficient after explicit zero costs',()=>{const f=makeFixture();const r=risk({levels:{takeProfitUsd:'87000',stopLossUsd:'82000'},costs:{...f.config.costs,entryFeeBps:'0',exitFeeBps:'0',exitSlippageBps:'0',fundingToTpPerBtcUsdt:'0',fundingToSlPerBtcUsdt:'0'}});expect(r.rewardRisk).toBe('1.5');expect(r.valid).toBe(true);});
  it('a caller cannot bypass the 1.5 floor by lowering the helper argument',()=>{const f=makeFixture();const r=risk({levels:{takeProfitUsd:'86000',stopLossUsd:'82000'},minRewardRisk:'0.5',costs:{...f.config.costs,entryFeeBps:'0',exitFeeBps:'0',exitSlippageBps:'0',fundingToTpPerBtcUsdt:'0',fundingToSlPerBtcUsdt:'0'}});expect(r.rewardRisk).toBe('1');expect(r.valid).toBe(false);});
});

import Decimal from 'decimal.js';
