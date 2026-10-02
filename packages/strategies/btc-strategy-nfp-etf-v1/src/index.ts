import Decimal from 'decimal.js';
import { DateTime } from 'luxon';
import {
  Evaluation, NumericDatum, Provenance, ScenarioConfig, Snapshot, TriState,
  STRATEGY_ID, STRATEGY_VERSION, EXECUTOR_ID, EXECUTOR_VERSION,
  evaluationSchema, scenarioConfigSchema, snapshotSchema, sha256,
} from '../../../shared/src';
import { calculateRisk } from './risk';
export { calculateRisk } from './risk';

export function triOr(a: TriState, b: TriState): TriState {
  return a === true || b === true ? true : a === 'unknown' || b === 'unknown' ? 'unknown' : false;
}
const ms = (s: string): number => Date.parse(s);
const explanations: Record<string, string> = {
  CONFIG_INVALID: 'La configuración no supera la validación.', SNAPSHOT_INVALID: 'El snapshot no cumple el contrato.',
  SCENARIO_EXPIRED: 'El escenario ha vencido; no autoriza nuevas entradas.', SCENARIO_NOT_STARTED: 'La vigencia del escenario todavía no comienza.',
  DEMO_NOT_LIVE: 'Los datos sintéticos no habilitan operaciones live.',
  WAITING_FOR_NFP: 'No se ha confirmado la publicación efectiva del reporte laboral.', WAITING_FOR_CONFIRMATION: 'Aún no transcurre la ventana de confirmación posterior al reporte.',
  CONFLICTING_MACRO: 'Las condiciones macro alcista y bajista son verdaderas al mismo tiempo.', MACRO_UNKNOWN: 'La información disponible no permite resolver los predicados macro y su conflicto.',
  ETF_INCOMPLETE: 'El reporte ETF de la última sesión cerrada está incompleto.', ETF_SESSION_MISMATCH: 'El reporte ETF no corresponde a la última sesión cerrada.',
  CONDITIONS_NOT_MET: 'No se cumple una dirección completa con confirmación de bonos y ETFs.',
  SIGNAL_CONFIRMED: 'Se cumple una única dirección y la relación beneficio/riesgo después de costes.',
  PROVIDER_FAILURE: 'Uno o más proveedores no están disponibles.',
  ENVIRONMENT_MISMATCH: 'Los datos y la ejecución no pertenecen al mismo entorno de Bybit.',
  UNVERIFIED_SOURCE: 'Una fuente crítica carece de verificación.', SOURCE_CONFLICT: 'Hay contradicciones de fuentes sin resolver.',
  FUTURE_DATA: 'Un dato o revisión todavía no estaba disponible al evaluar.', INVALID_PROVENANCE: 'Los tiempos de procedencia son contradictorios.',
  CALENDAR_MISSING: 'Falta el calendario oficial del evento.', CALENDAR_STALE: 'El calendario del evento necesita actualizarse.',
  NFP_PERIOD_MISMATCH: 'Los datos laborales no corresponden al evento y periodo configurados.',
  INVALID_PUBLICATION_TIME: 'La disponibilidad declarada precede la publicación efectiva.',
  CONSENSUS_MISSING: 'Falta el consenso congelado previo al evento.', CONSENSUS_PERIOD_MISMATCH: 'El consenso corresponde a otro reporte.',
  CONSENSUS_AFTER_EVENT: 'El consenso no quedó disponible y congelado antes del evento.',
  UNIT_MISMATCH: 'Una unidad no coincide con la magnitud requerida.', SERIES_MISMATCH: 'La serie observada y la esperada no coinciden.',
  MISSING_DATA: 'Faltan datos críticos; no se sustituyen por cero.', MARKET_CALENDAR_UNAVAILABLE: 'No hay calendario bursátil verificado que cubra esta fecha.',
  ETF_TOTAL_MISMATCH: 'La suma de fondos ETF no coincide con el total declarado.', ETF_AVAILABLE_BEFORE_CLOSE: 'El reporte ETF declara disponibilidad antes de cerrar la sesión.',
  TREASURY_INSUFFICIENT_OBSERVATIONS: 'Faltan observaciones del bono que cubran la ventana requerida.', TREASURY_NOT_INTRADAY: 'El rendimiento del bono es diario y no sustituye datos intradía.',
  UNIT_OR_SERIES_MISMATCH: 'El bono no corresponde a la serie nominal o unidad requerida.', TREASURY_DUPLICATE_OBSERVATION: 'Hay observaciones repetidas del bono.',
  TREASURY_STALE: 'La última observación del bono está obsoleta.', TREASURY_GAP_TOO_LARGE: 'La separación entre observaciones del bono supera el máximo permitido.',
  QUOTE_MISSING: 'Falta una cotización del instrumento.', QUOTE_STALE: 'La cotización del instrumento está obsoleta.', CROSSED_BOOK: 'El bid supera el ask y el libro no es válido.',
  FX_MISSING: 'Falta la tasa USD por USDT.', FX_STALE: 'La tasa USD por USDT está obsoleta.', CURRENCY_MISMATCH: 'La conversión de monedas es inválida o incompatible.',
  INVALID_TP_SL: 'La entrada queda fuera de los niveles de TP y SL permitidos.', RR_BELOW_MINIMUM: 'La relación beneficio/riesgo neta no alcanza el mínimo requerido.',
};

/** Pure evaluation: no clocks, network, Firebase, storage mutations, or order submission. */
export function evaluateScenario(snapshotInput: unknown, configInput: unknown, now: Date | string): Evaluation {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Injected evaluation time must be valid');
  const nowMs = instant.getTime();
  const nowUtc = instant.toISOString();
  const configParse = scenarioConfigSchema.safeParse(configInput);
  const snapshotParse = snapshotSchema.safeParse(snapshotInput);
  const raw = configInput && typeof configInput === 'object' ? configInput as Record<string, unknown> : {};
  const configHash = sha256(configInput);
  const snapshotHash = sha256(snapshotInput);
  const result: Evaluation = {
    strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION,
    scenarioId: typeof raw.scenarioId === 'string' ? raw.scenarioId : 'invalid-scenario',
    configHash, evaluationId: sha256({configHash,snapshotHash,nowUtc}),
    mode: raw.tradingMode === 'live' || raw.tradingMode === 'testnet' ? raw.tradingMode : 'dry_run',
    evaluatedAtUtc: nowUtc, evaluatedAtLocal: DateTime.fromJSDate(instant).setZone('America/Mexico_City').toISO()!,
    validUntilUtc: nowUtc, decision:'NO_TRADE', status:'BLOCKED', reasonCodes:[], explanation:'',
    conditions:[], validationStatus:'UNVALIDATED',
    instrument:{exchange:'BYBIT',symbol:'BTCUSDT',marketType:'LINEAR_PERPETUAL',category:'linear',quoteCurrency:'USDT'},
    risk:null, candidateEntryUsdt:null, dataQuality:'INVALID', missingData:[], staleData:[], sources:[],
    etfSession:null, employmentPublication:null, treasuryWindow:null,
    snapshot:{hash:snapshotHash,location:snapshotParse.success ? snapshotParse.data.location ?? 'inline' : 'inline',
      snapshotId:snapshotParse.success ? snapshotParse.data.snapshotId : 'invalid'},
    execution:{tradingMode:raw.tradingMode === 'live' || raw.tradingMode === 'testnet' ? raw.tradingMode : 'dry_run',executorId:EXECUTOR_ID,executorVersion:EXECUTOR_VERSION,
      status:'NOT_REQUESTED',environment:raw.environment === 'mainnet' ? 'mainnet' : 'testnet',leverage:'1',qtyFilled:'0',tpSlConfirmed:false},
  };
  const finish = (codes: string[], status: Evaluation['status'] = 'BLOCKED'): Evaluation => {
    result.reasonCodes = [...new Set(codes)]; result.status = codes.includes('PROVIDER_FAILURE') ? 'ERROR' : status;
    result.explanation = result.reasonCodes.map(c => explanations[c] ?? c).join(' ');
    return evaluationSchema.parse(result);
  };
  if (!configParse.success) return finish(['CONFIG_INVALID']);
  const config = configParse.data;
  result.validationStatus = config.validationStatus;
  if (nowMs >= ms(config.expiresAtUtc)) return finish(['SCENARIO_EXPIRED']);
  if (nowMs < ms(config.validFromUtc)) return finish(['SCENARIO_NOT_STARTED'],'WAITING');
  // Demo and validation labels remain audit metadata; actual source and risk checks govern eligibility.
  if (!snapshotParse.success) return finish(['SNAPSHOT_INVALID']);
  const snapshot = snapshotParse.data;
  if (config.tradingMode === 'live' && snapshot.synthetic) return finish(['DEMO_NOT_LIVE']);
  if (snapshot.environment !== config.environment || (snapshot.quote && snapshot.quote.environment !== config.environment)) return finish(['ENVIRONMENT_MISMATCH']);
  result.dataQuality = 'VALID';
  const intervalMs=config.nextEvaluationSeconds*1000;
  const nextScheduledBoundary=(Math.floor(nowMs/intervalMs)+1)*intervalMs;
  result.validUntilUtc = new Date(Math.min(ms(config.expiresAtUtc),nextScheduledBoundary)).toISOString();
  const problems: string[] = [];
  const checkProvenance = (name: string, p: Provenance): void => {
    result.sources.push(p);
    if (config.tradingMode === 'live' && p.synthetic) problems.push('DEMO_NOT_LIVE');
    if (!p.verified) problems.push('UNVERIFIED_SOURCE');
    if (p.conflicts.length) problems.push('SOURCE_CONFLICT');
    if ([p.observedAt,p.availableAt,p.firstSeenAt,p.fetchedAt,...(p.publishedAt ? [p.publishedAt] : [])].some(t => ms(t)>nowMs)) problems.push('FUTURE_DATA');
    if (ms(p.availableAt)<ms(p.firstSeenAt) || ms(p.fetchedAt)<ms(p.availableAt) || ms(p.fetchedAt)<ms(p.observedAt)) problems.push('INVALID_PROVENANCE');
    if (p.publishedAt && (ms(p.publishedAt)>ms(p.availableAt))) problems.push('INVALID_PROVENANCE');
    if (!p.revision || !p.sourceUrl) problems.push(`UNVERIFIABLE_${name.toUpperCase()}`);
  };
  const freshness = (name:string,p:Provenance,ttl:number):void => {
    const expiry=ms(p.observedAt)+ttl*1000;
    if (nowMs >= expiry) { result.staleData.push(name); problems.push(`${name.toUpperCase()}_STALE`); }
    result.validUntilUtc = new Date(Math.min(ms(result.validUntilUtc),Math.max(nowMs,expiry))).toISOString();
  };
  if (!snapshot.calendar) return finish(['CALENDAR_MISSING']);
  checkProvenance('calendar',snapshot.calendar.provenance);
  freshness('calendar',snapshot.calendar.provenance,config.freshness.calendarSeconds);
  if (snapshot.calendar.period!==config.event.period || snapshot.calendar.eventId!==config.event.eventId) return finish(['NFP_PERIOD_MISMATCH']);
  // The fresh calendar is authoritative if BLS reschedules. A scheduled time is never proof of release.
  if (nowMs < ms(snapshot.calendar.scheduledAtUtc) || !snapshot.employment) return finish(problems.length ? problems : ['WAITING_FOR_NFP'],'WAITING');
  const employment = snapshot.employment;
  checkProvenance('employment',employment.provenance);
  result.employmentPublication={period:employment.period,releasedAtUtc:employment.releasedAtUtc,revision:employment.provenance.revision};
  if (employment.period!==config.event.period || employment.eventId!==config.event.eventId) return finish(['NFP_PERIOD_MISMATCH']);
  if (ms(employment.releasedAtUtc)>nowMs) return finish(['WAITING_FOR_NFP'],'WAITING');
  if (ms(employment.provenance.availableAt)<ms(employment.releasedAtUtc)) problems.push('INVALID_PUBLICATION_TIME');
  if (nowMs < ms(employment.releasedAtUtc)+config.confirmationMinutes*60000) return finish(['WAITING_FOR_CONFIRMATION'],'WAITING');
  if (!snapshot.consensus) problems.push('CONSENSUS_MISSING');
  if (snapshot.consensus && (snapshot.consensus.period!==config.event.period || snapshot.consensus.eventId!==config.event.eventId)) problems.push('CONSENSUS_PERIOD_MISMATCH');
  const consensusDeadline = Math.min(ms(employment.releasedAtUtc),ms(snapshot.calendar.scheduledAtUtc));
  if (snapshot.consensus && ms(snapshot.consensus.frozenAtUtc)>=consensusDeadline) problems.push('CONSENSUS_AFTER_EVENT');
  const read = (name:string,datum:NumericDatum|null|undefined,unit:string,series:string,isConsensus=false):Decimal|null => {
    if (!datum) { result.missingData.push(name); return null; }
    checkProvenance(name,datum.provenance);
    if (datum.unit!==unit) problems.push('UNIT_MISMATCH');
    if (datum.seriesId!==series) problems.push('SERIES_MISMATCH');
    if (datum.period!==config.event.period) problems.push('NFP_PERIOD_MISMATCH');
    if (isConsensus && snapshot.consensus && [datum.provenance.firstSeenAt,datum.provenance.availableAt,datum.provenance.observedAt,
      ...(datum.provenance.publishedAt?[datum.provenance.publishedAt]:[])].some(t => ms(t)>ms(snapshot.consensus!.frozenAtUtc) || ms(t)>=consensusDeadline)) problems.push('CONSENSUS_AFTER_EVENT');
    if (!isConsensus && ms(datum.provenance.availableAt)<ms(employment.releasedAtUtc)) problems.push('INVALID_PUBLICATION_TIME');
    return new Decimal(datum.value);
  };
  const nfp=read('nfpActual',employment.nfp,'persons','US_NFP_CHANGE');
  const unemployment=read('unemploymentActualPct',employment.unemployment,'percent','US_UNEMPLOYMENT_RATE');
  const wages=read('wagesActualMoMPct',employment.wages,'percent_mom','US_AHE_MOM');
  const nfpConsensus=read('nfpConsensus',snapshot.consensus?.nfp,'persons','US_NFP_CHANGE',true);
  const wagesConsensus=read('wagesConsensusMoMPct',snapshot.consensus?.wages,'percent_mom','US_AHE_MOM',true);
  const longMacro=triOr(nfp&&nfpConsensus?nfp.lte(nfpConsensus):'unknown',unemployment?unemployment.gte(config.thresholds.unemploymentLongPct):'unknown');
  const shortMacro=triOr(nfp?nfp.gt(config.thresholds.nfpShortPersons):'unknown',wages&&wagesConsensus?wages.gt(wagesConsensus):'unknown');
  result.conditions.push({name:'macroLong',values:{nfp:nfp?.toFixed()??null,nfpConsensus:nfpConsensus?.toFixed()??null,unemployment:unemployment?.toFixed()??null},
    thresholds:{unemploymentLongPct:config.thresholds.unemploymentLongPct},result:longMacro},
    {name:'macroShort',values:{nfp:nfp?.toFixed()??null,wages:wages?.toFixed()??null,wagesConsensus:wagesConsensus?.toFixed()??null},
      thresholds:{nfpShortPersons:config.thresholds.nfpShortPersons},result:shortMacro});
  if (snapshot.providerErrors.length) problems.push('PROVIDER_FAILURE');
  if (result.missingData.length) problems.push('MISSING_DATA');
  if (longMacro==='unknown'||shortMacro==='unknown') problems.push('MACRO_UNKNOWN');
  if (problems.length) {result.dataQuality=result.missingData.length?'INCOMPLETE':'INVALID';return finish(problems);}
  if (longMacro===true && shortMacro===true && config.conflictingMacroPolicy==='BLOCK') return finish(['CONFLICTING_MACRO']);

  const latestSession = resolveLatestClosedSession(snapshot,nowMs);
  if (snapshot.marketCalendar) checkProvenance('marketCalendar',snapshot.marketCalendar.provenance);
  if (!latestSession) problems.push('MARKET_CALENDAR_UNAVAILABLE');
  const etf=snapshot.etf;
  if (!etf) {result.missingData.push('etf');problems.push('ETF_INCOMPLETE');}
  let etfValue:Decimal|null=null;
  if (etf) {
    checkProvenance('etf',etf.provenance);
    result.etfSession={sessionDate:etf.sessionDate,complete:false,availableAt:etf.provenance.availableAt,
      expectedFunds:[...etf.expectedFunds],coveredFunds:etf.funds.filter(f=>f.netFlowUsd!==null).map(f=>f.fund),
      missingFunds:etf.expectedFunds.filter(f=>!etf.funds.some(v=>v.fund===f&&v.netFlowUsd!==null)),totalMatches:null};
    if (latestSession!==etf.sessionDate) problems.push('ETF_SESSION_MISMATCH');
    const expected=new Set(etf.expectedFunds); const seen=new Set(etf.funds.map(f=>f.fund));
    if (!etf.complete || expected.size!==etf.expectedFunds.length || seen.size!==etf.funds.length || seen.size!==expected.size ||
      [...expected].some(f=>!seen.has(f)) || etf.funds.some(f=>f.netFlowUsd===null) || etf.totalUsd===null) problems.push('ETF_INCOMPLETE');
    else {
      const sum=etf.funds.reduce((acc,f)=>acc.plus(f.netFlowUsd!),new Decimal(0));
      result.etfSession.totalMatches=sum.eq(etf.totalUsd!);
      if (!result.etfSession.totalMatches) problems.push('ETF_TOTAL_MISMATCH');
      else {etfValue=sum;result.etfSession.complete=true;}
    }
    const sessionClose=snapshot.marketCalendar?.sessions.find(s=>s.sessionDate===etf.sessionDate)?.closeAtUtc;
    if (sessionClose && ms(etf.provenance.availableAt)<ms(sessionClose)) problems.push('ETF_AVAILABLE_BEFORE_CLOSE');
  }
  const treasury = [...snapshot.treasury].sort((a,b)=>ms(a.provenance.observedAt)-ms(b.provenance.observedAt));
  if (!treasury.length) problems.push('TREASURY_INSUFFICIENT_OBSERVATIONS');
  const times=new Set<string>();
  for (const t of treasury) {
    checkProvenance('treasury',t.provenance);
    if (t.frequency!=='intraday') problems.push('TREASURY_NOT_INTRADAY');
    if (t.unit!=='percent' || t.seriesId!=='US10Y_NOMINAL') problems.push('UNIT_OR_SERIES_MISMATCH');
    if (times.has(t.provenance.observedAt)) problems.push('TREASURY_DUPLICATE_OBSERVATION');
    times.add(t.provenance.observedAt);
  }
  // Pre-event samples never count toward confirmation. A feed may retain its full historical window.
  const postEvent=treasury.filter(t=>ms(t.provenance.observedAt)>ms(employment.releasedAtUtc));
  const last=postEvent.at(-1);
  let window=postEvent;
  if (last) {
    freshness('treasury',last.provenance,config.freshness.treasurySeconds);
    const boundary=ms(last.provenance.observedAt)-config.confirmationMinutes*60000;
    const start=postEvent.reduce((index,t,i)=>ms(t.provenance.observedAt)<=boundary?i:index,-1);
    window=start>=0?postEvent.slice(start):postEvent;
    result.treasuryWindow={fromUtc:window[0]!.provenance.observedAt,toUtc:last.provenance.observedAt,count:window.length};
  }
  if (window.length<config.minTreasuryObservations || !last || ms(last.provenance.observedAt)-ms(window[0]!.provenance.observedAt)<config.confirmationMinutes*60000) problems.push('TREASURY_INSUFFICIENT_OBSERVATIONS');
  if (window.some((t,i)=>i>0&&ms(t.provenance.observedAt)-ms(window[i-1]!.provenance.observedAt)>config.maxTreasuryGapSeconds*1000)) problems.push('TREASURY_GAP_TOO_LARGE');
  const bondLong=window.length>0&&window.every(t=>new Decimal(t.value).lt(config.thresholds.treasuryLongBelowPct));
  const bondShort=window.length>0&&window.every(t=>new Decimal(t.value).gt(config.thresholds.treasuryShortAbovePct));
  result.conditions.push({name:'treasuryLong',values:{latest:last?.value??null},thresholds:{strictlyBelow:config.thresholds.treasuryLongBelowPct},result:window.length?bondLong:'unknown'},
    {name:'treasuryShort',values:{latest:last?.value??null},thresholds:{strictlyAbove:config.thresholds.treasuryShortAbovePct},result:window.length?bondShort:'unknown'},
    {name:'etfPositive',values:{netFlowUsd:etfValue?.toFixed()??null},thresholds:{strictlyAbove:'0'},result:etfValue?etfValue.gt(0):'unknown'},
    {name:'etfNegative',values:{netFlowUsd:etfValue?.toFixed()??null},thresholds:{strictlyBelow:'0'},result:etfValue?etfValue.lt(0):'unknown'});
  if (!snapshot.quote) {result.missingData.push('quote');problems.push('QUOTE_MISSING');}
  else {
    checkProvenance('quote',snapshot.quote.provenance);freshness('quote',snapshot.quote.provenance,config.freshness.quoteSeconds);
    if (new Decimal(snapshot.quote.bid).gt(snapshot.quote.ask)) problems.push('CROSSED_BOOK');
  }
  if (!snapshot.usdPerUsdt) {result.missingData.push('usdPerUsdt');problems.push('FX_MISSING');}
  else {
    checkProvenance('fx',snapshot.usdPerUsdt.provenance);freshness('fx',snapshot.usdPerUsdt.provenance,config.freshness.fxSeconds);
    if (snapshot.usdPerUsdt.unit!=='USD_PER_USDT' || !new Decimal(snapshot.usdPerUsdt.value).gt(0)) problems.push('CURRENCY_MISMATCH');
  }
  if (problems.length) {result.dataQuality=result.missingData.length?'INCOMPLETE':'INVALID';return finish(problems);}
  const long=longMacro===true&&bondLong&&!!etfValue?.gt(0);
  const short=shortMacro===true&&bondShort&&!!etfValue?.lt(0);
  if (long===short) return finish(['CONDITIONS_NOT_MET']);
  const direction=long?'LONG':'SHORT';
  result.candidateEntryUsdt=direction==='LONG'?snapshot.quote!.ask:snapshot.quote!.bid;
  result.risk=calculateRisk({direction,entryUsdt:result.candidateEntryUsdt,usdPerUsdt:snapshot.usdPerUsdt!.value,
    levels:config.levels[direction],costs:config.costs,minRewardRisk:config.minRewardRisk});
  if (!result.risk.valid) return finish(result.risk.reasonCodes);
  result.decision=direction;
  return finish(['SIGNAL_CONFIRMED'],'SIGNAL');
}

function resolveLatestClosedSession(snapshot:Snapshot,now:number):string|null {
  const calendar=snapshot.marketCalendar;
  if (!calendar) return null;
  const date=DateTime.fromMillis(now).setZone('America/New_York').toISODate()!;
  if (date<calendar.coverageFrom||date>calendar.coverageTo) return null;
  return [...calendar.sessions].filter(s=>ms(s.closeAtUtc)<=now).sort((a,b)=>ms(b.closeAtUtc)-ms(a.closeAtUtc))[0]?.sessionDate??null;
}

export const evaluateBtcNfpEtfV1 = evaluateScenario;
