import Decimal from 'decimal.js';
import { DateTime } from 'luxon';
import {
  Evaluation, Provenance, FUNDAMENTAL_TRIGGER_STRATEGY_ID, STRATEGY_VERSION,
  EXECUTOR_ID, EXECUTOR_VERSION, evaluationSchema, fundamentalTriggerScenarioConfigSchema,
  snapshotSchema, sha256,
} from '../../../shared/src';
import { calculateRisk } from '../../btc-strategy-nfp-etf-v1/src/risk';

const ms = (value: string): number => Date.parse(value);
const explanations: Record<string, string> = {
  CONFIG_INVALID: 'La configuración de la estrategia de disparo fundamental no es válida.',
  SNAPSHOT_INVALID: 'El snapshot no cumple el contrato de datos.',
  SCENARIO_EXPIRED: 'El escenario ha vencido; no autoriza nuevas entradas.',
  SCENARIO_NOT_STARTED: 'La vigencia del escenario todavía no comienza.',
  DEMO_NOT_LIVE: 'Los datos sintéticos no habilitan señales live.',
  ENVIRONMENT_MISMATCH: 'Los datos y la ejecución pertenecen a entornos diferentes de Bybit.',
  PROVIDER_FAILURE: 'Falló un proveedor requerido; no se reutiliza una señal anterior.',
  QUOTE_MISSING: 'Falta la cotización actual del instrumento.',
  QUOTE_STALE: 'La cotización actual está obsoleta.',
  CROSSED_BOOK: 'El bid supera al ask y el libro no es válido.',
  FX_MISSING: 'Falta la tasa USD por USDT.',
  FX_STALE: 'La tasa USD por USDT está obsoleta.',
  CURRENCY_MISMATCH: 'La conversión USD por USDT es inválida o incompatible.',
  FX_SERIES_MISMATCH: 'La tasa de cambio no corresponde a la serie USD por USDT requerida.',
  STALE_DATA: 'La cotización o la tasa de cambio están obsoletas.',
  PRE_ENTRY_INVALIDATED: 'El precio tocó el Take Profit o Stop Loss antes de entrar; escenario invalidado.',
  WAITING_FOR_ENTRY_ZONE: 'El precio actual está fuera de la zona de entrada válida.',
  INVALID_TP_SL: 'La entrada no queda entre los niveles TP y SL definidos.',
  RR_BELOW_MINIMUM: 'La relación beneficio/riesgo neta no alcanza el mínimo requerido.',
  SIGNAL_CONFIRMED: 'El precio ejecutable está dentro de la zona, sin invalidación previa y con RR neto válido.',
};

/**
 * Pure fundamental-trigger strategy engine.
 * Decides LONG/SHORT strictly based on price within valid entry zone, validity window, fresh quote and FX,
 * pre-entry invalidation (no TP/SL touch since validFromUtc), and net RR >= 1.5.
 */
export function evaluateScenario(snapshotInput: unknown, configInput: unknown, now: Date | string): Evaluation {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Injected evaluation time must be valid');
  const nowMs = instant.getTime(), nowUtc = instant.toISOString();
  const configParse = fundamentalTriggerScenarioConfigSchema.safeParse(configInput);
  const snapshotParse = snapshotSchema.safeParse(snapshotInput);
  const raw = configInput && typeof configInput === 'object' ? configInput as Record<string, unknown> : {};
  const configHash = sha256(configInput), snapshotHash = sha256(snapshotInput);
  const mode = raw.tradingMode === 'live' || raw.tradingMode === 'testnet' ? raw.tradingMode : 'dry_run';
  const executionRaw = raw.execution && typeof raw.execution === 'object' ? raw.execution as Record<string, unknown> : {};
  const leverage = (executionRaw.leverage as '1' | '20') ?? '20';

  const result: Evaluation = {
    strategyId: FUNDAMENTAL_TRIGGER_STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    scenarioId: typeof raw.scenarioId === 'string' ? raw.scenarioId : 'invalid-fundamental-scenario',
    configHash,
    evaluationId: sha256({ configHash, snapshotHash, nowUtc }),
    mode,
    evaluatedAtUtc: nowUtc,
    evaluatedAtLocal: DateTime.fromJSDate(instant).setZone('America/Mexico_City').toISO()!,
    validUntilUtc: nowUtc,
    decision: 'NO_TRADE',
    status: 'BLOCKED',
    reasonCodes: [],
    explanation: '',
    conditions: [],
    validationStatus: 'UNVALIDATED',
    instrument: { exchange: 'BYBIT', symbol: 'BTCUSDT', marketType: 'LINEAR_PERPETUAL', category: 'linear', quoteCurrency: 'USDT' },
    risk: null,
    candidateEntryUsdt: null,
    dataQuality: 'INVALID',
    missingData: [],
    staleData: [],
    sources: [],
    etfSession: null,
    employmentPublication: null,
    treasuryWindow: null,
    snapshot: { hash: snapshotHash, location: snapshotParse.success ? snapshotParse.data.location ?? 'inline' : 'inline', snapshotId: snapshotParse.success ? snapshotParse.data.snapshotId : 'invalid' },
    execution: {
      tradingMode: mode,
      executorId: EXECUTOR_ID,
      executorVersion: EXECUTOR_VERSION,
      status: 'NOT_REQUESTED',
      environment: raw.environment === 'mainnet' ? 'mainnet' : 'testnet',
      leverage,
      qtyFilled: '0',
      tpSlConfirmed: false,
    },
  };

  const finish = (codes: string[], status: Evaluation['status'] = 'BLOCKED'): Evaluation => {
    result.reasonCodes = [...new Set(codes)];
    result.status = codes.includes('PROVIDER_FAILURE') ? 'ERROR' : status;
    result.explanation = result.reasonCodes.map(code => explanations[code] ?? code).join(' ');
    if (result.decision === 'NO_TRADE' && result.status !== 'WAITING') {
      result.validUntilUtc = nowUtc;
      if (result.missingData.length) result.dataQuality = 'INCOMPLETE';
    }
    return evaluationSchema.parse(result);
  };

  if (!configParse.success) return finish(['CONFIG_INVALID']);
  const config = configParse.data;
  result.validationStatus = config.validationStatus;

  if (nowMs >= ms(config.expiresAtUtc)) return finish(['SCENARIO_EXPIRED']);
  if (nowMs < ms(config.validFromUtc)) return finish(['SCENARIO_NOT_STARTED'], 'WAITING');

  if (!snapshotParse.success) return finish(['SNAPSHOT_INVALID']);
  const snapshot = snapshotParse.data;
  if (config.tradingMode === 'live' && snapshot.synthetic) return finish(['DEMO_NOT_LIVE']);
  if (snapshot.environment !== config.environment || (snapshot.quote && snapshot.quote.environment !== config.environment)) return finish(['ENVIRONMENT_MISMATCH']);
  if (snapshot.providerErrors.length) return finish(['PROVIDER_FAILURE']);

  result.dataQuality = 'VALID';
  const intervalMs = config.nextEvaluationSeconds * 1000;
  result.validUntilUtc = new Date(Math.min(ms(config.expiresAtUtc), (Math.floor(nowMs / intervalMs) + 1) * intervalMs)).toISOString();

  const problems: string[] = [];
  const checkProvenance = (p: Provenance): void => {
    result.sources.push(p);
    if (config.tradingMode === 'live' && p.synthetic) problems.push('DEMO_NOT_LIVE');
    if (!p.verified) problems.push('UNVERIFIED_SOURCE');
    if (p.conflicts.length) problems.push('SOURCE_CONFLICT');
    if ([p.observedAt, p.firstSeenAt, p.availableAt, p.fetchedAt, ...(p.publishedAt ? [p.publishedAt] : [])].some(t => ms(t) > nowMs)) problems.push('FUTURE_DATA');
    if (ms(p.availableAt) < ms(p.firstSeenAt) || ms(p.fetchedAt) < ms(p.availableAt) || ms(p.fetchedAt) < ms(p.observedAt) ||
      (p.publishedAt !== null && ms(p.publishedAt) > ms(p.availableAt))) problems.push('INVALID_PROVENANCE');
  };

  const freshness = (name: string, p: Provenance, ttl: number): void => {
    const expires = ms(p.observedAt) + ttl * 1000;
    if (nowMs >= expires) {
      result.staleData.push(name);
      problems.push('STALE_DATA');
    }
    result.validUntilUtc = new Date(Math.min(ms(result.validUntilUtc), Math.max(nowMs, expires))).toISOString();
  };

  if (!snapshot.quote) {
    result.missingData.push('quote');
    problems.push('QUOTE_MISSING');
  } else {
    checkProvenance(snapshot.quote.provenance);
    freshness('quote', snapshot.quote.provenance, config.freshness.quoteSeconds);
    if (new Decimal(snapshot.quote.bid).gt(snapshot.quote.ask)) problems.push('CROSSED_BOOK');
  }

  if (!snapshot.usdPerUsdt) {
    result.missingData.push('usdPerUsdt');
    problems.push('FX_MISSING');
  } else {
    checkProvenance(snapshot.usdPerUsdt.provenance);
    freshness('fx', snapshot.usdPerUsdt.provenance, config.freshness.fxSeconds);
    if (snapshot.usdPerUsdt.unit !== 'USD_PER_USDT' || !new Decimal(snapshot.usdPerUsdt.value).gt(0)) problems.push('CURRENCY_MISMATCH');
    if (snapshot.usdPerUsdt.seriesId !== 'USD_USDT') problems.push('FX_SERIES_MISMATCH');
  }

  if (problems.length) {
    result.dataQuality = result.missingData.length ? 'INCOMPLETE' : 'INVALID';
    return finish(problems);
  }

  const fx = new Decimal(snapshot.usdPerUsdt!.value);
  let tpUsd: string;
  let slUsd: string;
  let tpUsdt: Decimal;
  let slUsdt: Decimal;

  if (config.takeProfitUsdt && config.stopLossUsdt) {
    tpUsdt = new Decimal(config.takeProfitUsdt);
    slUsdt = new Decimal(config.stopLossUsdt);
    tpUsd = tpUsdt.mul(fx).toFixed();
    slUsd = slUsdt.mul(fx).toFixed();
  } else {
    tpUsd = (config.takeProfitUsd ?? (config.levels && ('takeProfitUsd' in config.levels ? config.levels.takeProfitUsd : config.levels[config.direction]?.takeProfitUsd)))!;
    slUsd = (config.stopLossUsd ?? (config.levels && ('stopLossUsd' in config.levels ? config.levels.stopLossUsd : config.levels[config.direction]?.stopLossUsd)))!;
    tpUsdt = new Decimal(tpUsd).div(fx);
    slUsdt = new Decimal(slUsd).div(fx);
  }

  // Pre-entry invalidation check
  const klines = snapshot.klines ?? snapshot.priceRangeSinceValidFrom;
  let preEntryInvalidated = false;
  if (klines) {
    checkProvenance(klines.provenance);
    const klineMin = new Decimal(klines.minPrice);
    const klineMax = new Decimal(klines.maxPrice);
    if (config.direction === 'LONG') {
      if (klineMax.gte(tpUsdt) || klineMin.lte(slUsdt)) preEntryInvalidated = true;
    } else {
      if (klineMin.lte(tpUsdt) || klineMax.gte(slUsdt)) preEntryInvalidated = true;
    }
  }

  // Also check if current quote directly touches TP or SL
  if (config.direction === 'LONG') {
    if (new Decimal(snapshot.quote!.ask).gte(tpUsdt) || new Decimal(snapshot.quote!.bid).lte(slUsdt)) preEntryInvalidated = true;
  } else {
    if (new Decimal(snapshot.quote!.bid).lte(tpUsdt) || new Decimal(snapshot.quote!.ask).gte(slUsdt)) preEntryInvalidated = true;
  }

  result.conditions.push(
    { name: 'preEntryInvalidation', values: { maxPrice: klines?.maxPrice ?? null, minPrice: klines?.minPrice ?? null }, thresholds: { tpUsdt: tpUsdt.toFixed(), slUsdt: slUsdt.toFixed() }, result: preEntryInvalidated },
  );

  if (preEntryInvalidated) {
    return finish(['PRE_ENTRY_INVALIDATED']);
  }

  // Check entry zone with executable price (ask for LONG, bid for SHORT)
  const executablePrice = new Decimal(config.direction === 'LONG' ? snapshot.quote!.ask : snapshot.quote!.bid);
  const [minZone, maxZone] = Array.isArray(config.entryZone)
    ? [new Decimal(config.entryZone[0]), new Decimal(config.entryZone[1])]
    : [new Decimal(config.entryZone.min ?? config.entryZone.minUsdt!), new Decimal(config.entryZone.max ?? config.entryZone.maxUsdt!)];

  const inZone = executablePrice.gte(minZone) && executablePrice.lte(maxZone);
  result.conditions.push(
    { name: 'entryZone', values: { executablePrice: executablePrice.toFixed() }, thresholds: { min: minZone.toFixed(), max: maxZone.toFixed() }, result: inZone },
  );

  if (!inZone) {
    return finish(['WAITING_FOR_ENTRY_ZONE'], 'WAITING');
  }

  // RR calculation
  result.candidateEntryUsdt = config.direction === 'LONG' ? snapshot.quote!.ask : snapshot.quote!.bid;
  result.risk = calculateRisk({
    direction: config.direction,
    entryUsdt: result.candidateEntryUsdt,
    usdPerUsdt: snapshot.usdPerUsdt!.value,
    levels: { takeProfitUsd: tpUsd, stopLossUsd: slUsd },
    costs: config.costs,
    minRewardRisk: config.minRewardRisk,
  });

  const rrMet = result.risk.valid;
  result.conditions.push(
    { name: 'rewardRisk', values: { calculated: result.risk.rewardRisk }, thresholds: { min: config.minRewardRisk }, result: rrMet },
  );

  if (!rrMet) {
    const codes = result.risk.reasonCodes.includes('RR_BELOW_MINIMUM') ? ['RR_BELOW_MINIMUM'] : result.risk.reasonCodes;
    return finish(codes);
  }

  result.decision = config.direction;
  return finish(['SIGNAL_CONFIRMED'], 'SIGNAL');
}

export const evaluateBtcFundamentalTriggerV1 = evaluateScenario;
