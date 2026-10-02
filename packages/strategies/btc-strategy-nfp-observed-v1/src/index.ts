import Decimal from 'decimal.js';
import { DateTime } from 'luxon';
import {
  Evaluation, NumericDatum, Provenance, PUBLIC_NFP_STRATEGY_ID, STRATEGY_VERSION,
  EXECUTOR_ID, EXECUTOR_VERSION, evaluationSchema, publicNfpScenarioConfigSchema,
  snapshotSchema, sha256,
} from '../../../shared/src';
import { calculateRisk } from '../../btc-strategy-nfp-etf-v1/src/risk';

const ms=(value:string):number=>Date.parse(value);
const explanations:Record<string,string>={
  CONFIG_INVALID:'La configuración de la estrategia de empleo observado no es válida.',
  SNAPSHOT_INVALID:'El snapshot no cumple el contrato de datos.',
  SCENARIO_EXPIRED:'El escenario ha vencido; no autoriza nuevas entradas.',
  SCENARIO_NOT_STARTED:'La vigencia del escenario todavía no comienza.',
  DEMO_NOT_LIVE:'Los datos sintéticos no habilitan señales live.',
  ENVIRONMENT_MISMATCH:'Los datos y la ejecución pertenecen a entornos diferentes de Bybit.',
  PROVIDER_FAILURE:'Falló un proveedor requerido; no se reutiliza una señal anterior.',
  CALENDAR_MISSING:'Falta el calendario oficial del evento.', CALENDAR_STALE:'El calendario del evento necesita actualizarse.',
  WAITING_FOR_NFP:'No se ha confirmado la publicación efectiva del reporte laboral de este periodo.',
  WAITING_FOR_CONFIRMATION:'Se esperan 15 minutos desde la detección inicial del reporte BLS.',
  NFP_PERIOD_MISMATCH:'Los datos laborales no corresponden al evento y periodo configurados.',
  UNVERIFIED_SOURCE:'Una fuente requerida carece de verificación.', SOURCE_CONFLICT:'Hay contradicciones de fuentes sin resolver.',
  FUTURE_DATA:'Un dato o una revisión aún no estaba disponible en el momento de evaluar.',
  INVALID_PROVENANCE:'Los tiempos de procedencia son contradictorios.',
  INVALID_PUBLICATION_TIME:'La disponibilidad o detección de la versión precede la detección inicial del reporte.',
  REPORT_REVISION_MISMATCH:'Los valores laborales no pertenecen a la versión del reporte indicada.',
  UNIT_MISMATCH:'Una unidad no coincide con la magnitud requerida.', SERIES_MISMATCH:'Una serie no coincide con la magnitud requerida.',
  NFP_VALUE_INVALID:'El cambio mensual de empleo debe expresarse como un número entero de personas.',
  UNEMPLOYMENT_VALUE_INVALID:'La tasa de desempleo debe estar entre 0 y 100 por ciento.',
  MISSING_DATA:'Faltan datos críticos; no se sustituyen por cero.',
  MACRO_UNKNOWN:'Los datos desconocidos impiden resolver la dirección y descartar un conflicto.',
  CONFLICTING_MACRO:'Desempleo y NFP habilitan direcciones opuestas al mismo tiempo.',
  CONDITIONS_NOT_MET:'Ninguna de las dos condiciones de empleo observado habilita una dirección.',
  QUOTE_MISSING:'Falta la cotización actual del instrumento.', QUOTE_STALE:'La cotización actual está obsoleta.',
  CROSSED_BOOK:'El bid supera al ask y el libro no es válido.',
  FX_MISSING:'Falta la tasa USD por USDT.', FX_STALE:'La tasa USD por USDT está obsoleta.',
  CURRENCY_MISMATCH:'La conversión USD por USDT es inválida o incompatible.',
  FX_SERIES_MISMATCH:'La tasa de cambio no corresponde a la serie USD por USDT requerida.',
  INVALID_TP_SL:'La entrada no queda entre los niveles TP y SL definidos.',
  RR_BELOW_MINIMUM:'La relación beneficio/riesgo neta no alcanza el mínimo requerido.',
  SIGNAL_CONFIRMED:'Una única condición de empleo observado habilita la dirección y el riesgo neto cumple el mínimo.',
};

/**
 * Pure observed-employment variant. LONG uses unemployment >= threshold; SHORT uses NFP > threshold.
 * Consensus, wages, Treasury and ETF fields are optional context and never enter these predicates.
 * releasedAtUtc is the persisted initial BLS detection time; revisions do not restart its 15-minute wait.
 */
export function evaluateScenario(snapshotInput:unknown,configInput:unknown,now:Date|string):Evaluation {
  const instant=now instanceof Date?now:new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Injected evaluation time must be valid');
  const nowMs=instant.getTime(),nowUtc=instant.toISOString();
  const configParse=publicNfpScenarioConfigSchema.safeParse(configInput);
  const snapshotParse=snapshotSchema.safeParse(snapshotInput);
  const raw=configInput&&typeof configInput==='object'?configInput as Record<string,unknown>:{};
  const configHash=sha256(configInput),snapshotHash=sha256(snapshotInput);
  const mode=raw.tradingMode==='live'||raw.tradingMode==='testnet'?raw.tradingMode:'dry_run';
  const result:Evaluation={
    strategyId:PUBLIC_NFP_STRATEGY_ID,strategyVersion:STRATEGY_VERSION,
    scenarioId:typeof raw.scenarioId==='string'?raw.scenarioId:'invalid-public-scenario',
    configHash,evaluationId:sha256({configHash,snapshotHash,nowUtc}),mode,
    evaluatedAtUtc:nowUtc,evaluatedAtLocal:DateTime.fromJSDate(instant).setZone('America/Mexico_City').toISO()!,
    validUntilUtc:nowUtc,decision:'NO_TRADE',status:'BLOCKED',reasonCodes:[],explanation:'',conditions:[],
    validationStatus:'UNVALIDATED',instrument:{exchange:'BYBIT',symbol:'BTCUSDT',marketType:'LINEAR_PERPETUAL',category:'linear',quoteCurrency:'USDT'},
    risk:null,candidateEntryUsdt:null,dataQuality:'INVALID',missingData:[],staleData:[],sources:[],
    etfSession:null,employmentPublication:null,treasuryWindow:null,
    snapshot:{hash:snapshotHash,location:snapshotParse.success?snapshotParse.data.location??'inline':'inline',snapshotId:snapshotParse.success?snapshotParse.data.snapshotId:'invalid'},
    execution:{tradingMode:mode,executorId:EXECUTOR_ID,executorVersion:EXECUTOR_VERSION,status:'NOT_REQUESTED',
      environment:raw.environment==='mainnet'?'mainnet':'testnet',leverage:'1',qtyFilled:'0',tpSlConfirmed:false},
  };
  const finish=(codes:string[],status:Evaluation['status']='BLOCKED'):Evaluation=>{
    result.reasonCodes=[...new Set(codes)];
    result.status=codes.includes('PROVIDER_FAILURE')?'ERROR':status;
    result.explanation=result.reasonCodes.map(code=>explanations[code]??code).join(' ');
    if (result.decision==='NO_TRADE'&&result.status!=='WAITING') {
      result.validUntilUtc=nowUtc;
      if (result.missingData.length) result.dataQuality='INCOMPLETE';
    }
    return evaluationSchema.parse(result);
  };
  if (!configParse.success) return finish(['CONFIG_INVALID']);
  const config=configParse.data;
  result.validationStatus=config.validationStatus;
  if (nowMs>=ms(config.expiresAtUtc)) return finish(['SCENARIO_EXPIRED']);
  if (nowMs<ms(config.validFromUtc)) return finish(['SCENARIO_NOT_STARTED'],'WAITING');
  // Demo and validation labels remain audit metadata; actual source and risk checks govern eligibility.
  if (!snapshotParse.success) return finish(['SNAPSHOT_INVALID']);
  const snapshot=snapshotParse.data;
  if (config.tradingMode==='live'&&snapshot.synthetic) return finish(['DEMO_NOT_LIVE']);
  if (snapshot.environment!==config.environment||(snapshot.quote&&snapshot.quote.environment!==config.environment)) return finish(['ENVIRONMENT_MISMATCH']);
  if (snapshot.providerErrors.length) return finish(['PROVIDER_FAILURE']);
  result.dataQuality='VALID';
  const intervalMs=config.nextEvaluationSeconds*1000;
  result.validUntilUtc=new Date(Math.min(ms(config.expiresAtUtc),(Math.floor(nowMs/intervalMs)+1)*intervalMs)).toISOString();
  const problems:string[]=[];
  const checkProvenance=(p:Provenance):void=>{
    result.sources.push(p);
    if (config.tradingMode==='live'&&p.synthetic) problems.push('DEMO_NOT_LIVE');
    if (!p.verified) problems.push('UNVERIFIED_SOURCE');
    if (p.conflicts.length) problems.push('SOURCE_CONFLICT');
    if ([p.observedAt,p.firstSeenAt,p.availableAt,p.fetchedAt,...(p.publishedAt?[p.publishedAt]:[])].some(t=>ms(t)>nowMs)) problems.push('FUTURE_DATA');
    if (ms(p.availableAt)<ms(p.firstSeenAt)||ms(p.fetchedAt)<ms(p.availableAt)||ms(p.fetchedAt)<ms(p.observedAt)||
      (p.publishedAt!==null&&ms(p.publishedAt)>ms(p.availableAt))) problems.push('INVALID_PROVENANCE');
  };
  const freshness=(name:string,p:Provenance,ttl:number):void=>{
    const expires=ms(p.observedAt)+ttl*1000;
    if (nowMs>=expires) {result.staleData.push(name);problems.push(`${name.toUpperCase()}_STALE`);}
    result.validUntilUtc=new Date(Math.min(ms(result.validUntilUtc),Math.max(nowMs,expires))).toISOString();
  };
  const rejectProblems=():Evaluation=>{
    result.dataQuality=result.missingData.length?'INCOMPLETE':'INVALID';return finish(problems);
  };
  if (!snapshot.calendar) {result.missingData.push('calendar');return finish(['CALENDAR_MISSING']);}
  checkProvenance(snapshot.calendar.provenance);
  freshness('calendar',snapshot.calendar.provenance,config.freshness.calendarSeconds);
  if (snapshot.calendar.eventId!==config.event.eventId||snapshot.calendar.period!==config.event.period) problems.push('NFP_PERIOD_MISMATCH');
  if (problems.length) return rejectProblems();
  // The current official calendar can reschedule the release. A scheduled time never proves publication.
  if (nowMs<ms(snapshot.calendar.scheduledAtUtc)||!snapshot.employment) return finish(['WAITING_FOR_NFP'],'WAITING');
  const report=snapshot.employment;
  checkProvenance(report.provenance);
  result.employmentPublication={period:report.period,releasedAtUtc:report.releasedAtUtc,revision:report.provenance.revision};
  if (report.eventId!==config.event.eventId||report.period!==config.event.period) problems.push('NFP_PERIOD_MISMATCH');
  if (ms(report.releasedAtUtc)>nowMs) return finish(['WAITING_FOR_NFP'],'WAITING');
  if (ms(report.provenance.firstSeenAt)<ms(report.releasedAtUtc)||ms(report.provenance.availableAt)<ms(report.releasedAtUtc)) problems.push('INVALID_PUBLICATION_TIME');
  const read=(name:string,datum:NumericDatum|null,unit:string,seriesId:string):Decimal|null=>{
    if (!datum) {result.missingData.push(name);return null;}
    checkProvenance(datum.provenance);
    if (datum.unit!==unit) problems.push('UNIT_MISMATCH');
    if (datum.seriesId!==seriesId) problems.push('SERIES_MISMATCH');
    if (datum.period!==config.event.period) problems.push('NFP_PERIOD_MISMATCH');
    if (datum.provenance.revision!==report.provenance.revision) problems.push('REPORT_REVISION_MISMATCH');
    if (ms(datum.provenance.firstSeenAt)<ms(report.releasedAtUtc)||ms(datum.provenance.availableAt)<ms(report.releasedAtUtc)) problems.push('INVALID_PUBLICATION_TIME');
    return new Decimal(datum.value);
  };
  const nfp=read('nfpActual',report.nfp,'persons','US_NFP_CHANGE');
  const unemployment=read('unemploymentActualPct',report.unemployment,'percent','US_UNEMPLOYMENT_RATE');
  if (nfp!==null&&!nfp.isInteger()) problems.push('NFP_VALUE_INVALID');
  if (unemployment!==null&&(unemployment.lt(0)||unemployment.gt(100))) problems.push('UNEMPLOYMENT_VALUE_INVALID');
  const longMacro=unemployment===null?'unknown':unemployment.gte(config.thresholds.unemploymentLongPct);
  const shortMacro=nfp===null?'unknown':nfp.gt(config.thresholds.nfpShortPersons);
  const delayComplete=nowMs>=ms(report.releasedAtUtc)+config.confirmationMinutes*60000;
  result.conditions.push(
    {name:'macroLong',values:{unemployment:unemployment?.toFixed()??null},thresholds:{unemploymentLongPct:config.thresholds.unemploymentLongPct},result:longMacro},
    {name:'macroShort',values:{nfp:nfp?.toFixed()??null},thresholds:{nfpShortPersons:config.thresholds.nfpShortPersons},result:shortMacro},
    {name:'publicationWait',values:{initialDetectionUtc:report.releasedAtUtc},thresholds:{minutes:String(config.confirmationMinutes)},result:delayComplete},
  );
  if (result.missingData.length) problems.push('MISSING_DATA');
  if (longMacro==='unknown'||shortMacro==='unknown') problems.push('MACRO_UNKNOWN');
  if (problems.length) return rejectProblems();
  if (!delayComplete) return finish(['WAITING_FOR_CONFIRMATION'],'WAITING');
  if (longMacro===true&&shortMacro===true) return finish(['CONFLICTING_MACRO']);
  if (longMacro===false&&shortMacro===false) return finish(['CONDITIONS_NOT_MET']);
  if (!snapshot.quote) {result.missingData.push('quote');problems.push('QUOTE_MISSING');}
  else {
    checkProvenance(snapshot.quote.provenance);
    freshness('quote',snapshot.quote.provenance,config.freshness.quoteSeconds);
    if (new Decimal(snapshot.quote.bid).gt(snapshot.quote.ask)) problems.push('CROSSED_BOOK');
  }
  if (!snapshot.usdPerUsdt) {result.missingData.push('usdPerUsdt');problems.push('FX_MISSING');}
  else {
    checkProvenance(snapshot.usdPerUsdt.provenance);
    freshness('fx',snapshot.usdPerUsdt.provenance,config.freshness.fxSeconds);
    if (snapshot.usdPerUsdt.unit!=='USD_PER_USDT'||!new Decimal(snapshot.usdPerUsdt.value).gt(0)) problems.push('CURRENCY_MISMATCH');
    if (snapshot.usdPerUsdt.seriesId!=='USD_USDT') problems.push('FX_SERIES_MISMATCH');
  }
  if (problems.length) return rejectProblems();
  const direction=longMacro===true?'LONG':'SHORT';
  result.candidateEntryUsdt=direction==='LONG'?snapshot.quote!.ask:snapshot.quote!.bid;
  result.risk=calculateRisk({direction,entryUsdt:result.candidateEntryUsdt,usdPerUsdt:snapshot.usdPerUsdt!.value,
    levels:config.levels[direction],costs:config.costs,minRewardRisk:config.minRewardRisk});
  if (!result.risk.valid) return finish(result.risk.reasonCodes);
  result.decision=direction;
  return finish(['SIGNAL_CONFIRMED'],'SIGNAL');
}

export const evaluateBtcNfpObservedV1=evaluateScenario;
