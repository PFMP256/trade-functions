import { createHash } from 'node:crypto';
import { z } from 'zod';
import Decimal from 'decimal.js';

export const STRATEGY_ID = 'btc-strategy-nfp-etf-v1' as const;
export const STRATEGY_VERSION = '1.0.0' as const;
export const PUBLIC_NFP_STRATEGY_ID = 'btc-strategy-nfp-observed-v1' as const;
export const EXECUTOR_ID = 'bybit-linear-executor-v1' as const;
export const EXECUTOR_VERSION = '1.0.0' as const;
export const utcSchema = z.string().datetime();
export const decimalSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const positiveDecimalSchema = decimalSchema.refine(v => Number(v) > 0 && Number.isFinite(Number(v)), 'Must be positive and finite');
export const nonnegativeDecimalSchema = decimalSchema.refine(v => Number(v) >= 0 && Number.isFinite(Number(v)), 'Must be nonnegative and finite');
export const environmentSchema = z.enum(['testnet', 'mainnet']);
export const tradingModeSchema = z.enum(['dry_run', 'testnet', 'live']);
export const provenanceSchema = z.object({
  sourceId: z.string().min(1), sourceUrl: z.string().url(), observedAt: utcSchema,
  publishedAt: utcSchema.nullable(), firstSeenAt: utcSchema, availableAt: utcSchema,
  fetchedAt: utcSchema, revision: z.string().min(1), verified: z.boolean(),
  synthetic: z.boolean(), conflicts: z.array(z.string()), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type Provenance = z.infer<typeof provenanceSchema>;
export const numericDatumSchema = z.object({
  value: decimalSchema, unit: z.string().min(1), period: z.string().min(1),
  seriesId: z.string().min(1), provenance: provenanceSchema,
}).strict();
export type NumericDatum = z.infer<typeof numericDatumSchema>;
export const quoteSchema = z.object({
  exchange: z.literal('BYBIT'), symbol: z.literal('BTCUSDT'), category: z.literal('linear'),
  quoteCurrency: z.literal('USDT'), environment: environmentSchema,
  bid: positiveDecimalSchema, ask: positiveDecimalSchema, last: positiveDecimalSchema,
  mark: positiveDecimalSchema, provenance: provenanceSchema,
}).strict();
export type Quote = z.infer<typeof quoteSchema>;
export const eventCalendarSchema = z.object({
  eventId: z.string(), period: z.string(), scheduledAtUtc: utcSchema,
  provenance: provenanceSchema,
}).strict();
export type EventCalendar = z.infer<typeof eventCalendarSchema>;
export const employmentReportSchema = z.object({
  eventId: z.string(), period: z.string(), releasedAtUtc: utcSchema,
  nfp: numericDatumSchema.nullable(), unemployment: numericDatumSchema.nullable(),
  wages: numericDatumSchema.nullable(), provenance: provenanceSchema,
}).strict();
export type EmploymentReport = z.infer<typeof employmentReportSchema>;
export const consensusSchema = z.object({
  eventId: z.string(), period: z.string(), frozenAtUtc: utcSchema,
  nfp: numericDatumSchema.nullable(), wages: numericDatumSchema.nullable(),
}).strict();
export type Consensus = z.infer<typeof consensusSchema>;
export const treasuryObservationSchema = numericDatumSchema.extend({ frequency: z.enum(['intraday', 'daily']) }).strict();
export type TreasuryObservation = z.infer<typeof treasuryObservationSchema>;
export const marketCalendarSchema = z.object({
  calendarId: z.string(), coverageFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  coverageTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessions: z.array(z.object({ sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), closeAtUtc: utcSchema }).strict()),
  provenance: provenanceSchema,
}).strict();
export type MarketCalendar = z.infer<typeof marketCalendarSchema>;
export const etfReportSchema = z.object({
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), expectedFunds: z.array(z.string()).min(1),
  funds: z.array(z.object({ fund: z.string(), netFlowUsd: decimalSchema.nullable(), rawValue: z.string() }).strict()),
  totalUsd: decimalSchema.nullable(), complete: z.boolean(), unit: z.literal('USD'),
  provenance: provenanceSchema,
}).strict();
export type EtfReport = z.infer<typeof etfReportSchema>;
export const snapshotSchema = z.object({
  snapshotId: z.string().min(1), location: z.string().optional(), environment: environmentSchema,
  synthetic: z.boolean(), quote: quoteSchema.nullable(), usdPerUsdt: numericDatumSchema.nullable(),
  calendar: eventCalendarSchema.nullable(), employment: employmentReportSchema.nullable(),
  consensus: consensusSchema.nullable(), treasury: z.array(treasuryObservationSchema),
  etf: etfReportSchema.nullable(), marketCalendar: marketCalendarSchema.nullable(),
  providerErrors: z.array(z.string()),
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const costAssumptionsSchema = z.object({
  entryFeeBps: nonnegativeDecimalSchema, exitFeeBps: nonnegativeDecimalSchema,
  exitSlippageBps: nonnegativeDecimalSchema,
  fundingToTpPerBtcUsdt: nonnegativeDecimalSchema, fundingToSlPerBtcUsdt: nonnegativeDecimalSchema,
  description: z.string().min(1),
}).strict();
export type CostAssumptions = z.infer<typeof costAssumptionsSchema>;
export const levelSchema = z.object({ takeProfitUsd: positiveDecimalSchema, stopLossUsd: positiveDecimalSchema }).strict();
export const instrumentSchema = z.object({
  exchange: z.literal('BYBIT'), symbol: z.literal('BTCUSDT'), marketType: z.literal('LINEAR_PERPETUAL'),
  category: z.literal('linear'), quoteCurrency: z.literal('USDT'),
}).strict();
export const scenarioConfigSchema = z.object({
  strategyId: z.literal(STRATEGY_ID), strategyVersion: z.literal(STRATEGY_VERSION), scenarioId: z.string().min(1),
  validFromUtc: utcSchema, expiresAtUtc: utcSchema, timezone: z.literal('America/Mexico_City'),
  demo: z.boolean(), validationStatus: z.enum(['UNVALIDATED', 'VALIDATED']),
  sourcesValidated: z.boolean(), tradingMode: tradingModeSchema, environment: environmentSchema,
  allowNewEntries: z.boolean(), closeOnScenarioExpiry: z.boolean(),
  instrument: instrumentSchema,
  event: z.object({ eventId: z.string(), period: z.string(), scheduledAtUtc: utcSchema,
    calendarSourceUrl: z.string().url(), verifiedAtUtc: utcSchema,
  }).strict(),
  thresholds: z.object({ unemploymentLongPct: decimalSchema, nfpShortPersons: decimalSchema,
    treasuryLongBelowPct: decimalSchema, treasuryShortAbovePct: decimalSchema,
  }).strict(),
  confirmationMinutes: z.number().int().min(1), minTreasuryObservations: z.number().int().min(2),
  maxTreasuryGapSeconds: z.number().int().positive(), conflictingMacroPolicy: z.enum(['BLOCK', 'REQUIRE_UNIQUE_DIRECTION']),
  freshness: z.object({ quoteSeconds: z.number().int().positive(), treasurySeconds: z.number().int().positive(),
    fxSeconds: z.number().int().positive(), calendarSeconds: z.number().int().positive(),
  }).strict(),
  nextEvaluationSeconds: z.number().int().positive(), minRewardRisk: positiveDecimalSchema.refine(v => Number(v) >= 1.5, 'RR must be at least 1.5'),
  levels: z.object({ LONG: levelSchema, SHORT: levelSchema }).strict(),
  costs: costAssumptionsSchema,
  execution: z.object({ targetPositionNotionalUsd: z.enum(['100', '2000']).default('100'), leverage: z.enum(['1', '20']).default('1'),
    marginMode: z.enum(['ISOLATED', 'REGULAR']).default('ISOLATED'), positionMode: z.literal('ONE_WAY'), positionIdx: z.literal(0),
    maxOpenPositionsPerSymbol: z.literal(1), maxEntryIntentsPerScenario: z.literal(1),
    entrySlippageBps: nonnegativeDecimalSchema, entryOrderType: z.literal('Limit'), timeInForce: z.literal('IOC'),
    tpslMode: z.literal('Full'), tpOrderType: z.literal('Market'), slOrderType: z.literal('Market'),
    tpTriggerBy: z.literal('LastPrice'), slTriggerBy: z.literal('LastPrice'),
    monetaryPrecisionUsd: positiveDecimalSchema, protectionTimeoutSeconds: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((v, ctx) => {
  if (Date.parse(v.validFromUtc) >= Date.parse(v.expiresAtUtc)) ctx.addIssue({code:'custom',message:'Invalid scenario validity window'});
  if (v.tradingMode === 'live' && v.environment !== 'mainnet') ctx.addIssue({code:'custom',message:'Live requires mainnet'});
  if (v.tradingMode === 'testnet' && v.environment !== 'testnet') ctx.addIssue({code:'custom',message:'Testnet requires testnet environment'});
});
export type ScenarioConfig = z.infer<typeof scenarioConfigSchema>;
/** Separate strategy: observed BLS employment only. Legacy schema remains unchanged. */
export const publicNfpScenarioConfigSchema = scenarioConfigSchema.innerType()
  .omit({minTreasuryObservations:true,maxTreasuryGapSeconds:true})
  .extend({
    strategyId:z.literal(PUBLIC_NFP_STRATEGY_ID),
    thresholds:z.object({
      unemploymentLongPct:decimalSchema.refine(v=>new Decimal(v).gte(0)&&new Decimal(v).lte(100),'Unemployment threshold must be 0..100 percent'),
      nfpShortPersons:decimalSchema.refine(v=>new Decimal(v).isInteger(),'NFP threshold must be integer persons'),
    }).strict(),
    confirmationMinutes:z.literal(15), conflictingMacroPolicy:z.literal('BLOCK'),
    freshness:z.object({quoteSeconds:z.number().int().positive(),fxSeconds:z.number().int().positive(),calendarSeconds:z.number().int().positive()}).strict(),
  }).strict().superRefine((v,ctx)=>{
    if (Date.parse(v.validFromUtc)>=Date.parse(v.expiresAtUtc)) ctx.addIssue({code:'custom',message:'Invalid scenario validity window'});
    if (v.tradingMode==='live'&&v.environment!=='mainnet') ctx.addIssue({code:'custom',message:'Live requires mainnet'});
    if (v.tradingMode==='testnet'&&v.environment!=='testnet') ctx.addIssue({code:'custom',message:'Testnet requires testnet environment'});
  });
export type PublicNfpScenarioConfig = z.infer<typeof publicNfpScenarioConfigSchema>;
export const anyScenarioConfigSchema = z.union([scenarioConfigSchema,publicNfpScenarioConfigSchema]);
export type AnyScenarioConfig = z.infer<typeof anyScenarioConfigSchema>;
export type TriState = true | false | 'unknown';
export const conditionSchema = z.object({ name: z.string(), values: z.record(z.string(), z.string().nullable()),
  thresholds: z.record(z.string(), z.string()), result: z.union([z.boolean(), z.literal('unknown')]),
}).strict();
export const riskResultSchema = z.object({ valid: z.boolean(), reasonCodes: z.array(z.string()),
  direction: z.enum(['LONG','SHORT']), entryUsdt: decimalSchema, takeProfitUsdt: decimalSchema,
  stopLossUsdt: decimalSchema, grossProfitPerBtc: decimalSchema, grossLossPerBtc: decimalSchema,
  costToTpPerBtc: decimalSchema, costToSlPerBtc: decimalSchema, netProfitPerBtc: decimalSchema,
  netLossPerBtc: decimalSchema, rewardRisk: decimalSchema.nullable(), costs: costAssumptionsSchema,
}).strict();
export type RiskResult = z.infer<typeof riskResultSchema>;
export const evaluationSchema = z.object({
  strategyId: z.enum([STRATEGY_ID,PUBLIC_NFP_STRATEGY_ID]), strategyVersion: z.literal(STRATEGY_VERSION), scenarioId: z.string(),
  configHash: z.string(), evaluationId: z.string(), mode: tradingModeSchema,
  evaluatedAtUtc: utcSchema, evaluatedAtLocal: z.string(), validUntilUtc: utcSchema,
  decision: z.enum(['LONG','SHORT','NO_TRADE']), status: z.enum(['SIGNAL','WAITING','BLOCKED','ERROR']),
  reasonCodes: z.array(z.string()), explanation: z.string(), conditions: z.array(conditionSchema),
  validationStatus: z.enum(['UNVALIDATED','VALIDATED']), instrument: instrumentSchema,
  risk: riskResultSchema.nullable(), candidateEntryUsdt: decimalSchema.nullable(),
  dataQuality: z.enum(['VALID','INCOMPLETE','INVALID']), missingData: z.array(z.string()), staleData: z.array(z.string()),
  sources: z.array(provenanceSchema), etfSession: z.object({sessionDate:z.string(),complete:z.boolean(),availableAt:utcSchema,
    expectedFunds:z.array(z.string()),coveredFunds:z.array(z.string()),missingFunds:z.array(z.string()),totalMatches:z.boolean().nullable()}).nullable(),
  employmentPublication: z.object({period:z.string(),releasedAtUtc:utcSchema,revision:z.string()}).nullable(),
  treasuryWindow: z.object({fromUtc:utcSchema,toUtc:utcSchema,count:z.number()}).nullable(),
  snapshot: z.object({hash:z.string(),location:z.string(),snapshotId:z.string()}),
  execution: z.record(z.string(), z.unknown()),
}).strict();
export type Evaluation = z.infer<typeof evaluationSchema>;

/** Stable canonical JSON; timestamps/revisions remain part of the audit digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+canonicalJson(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function sha256(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
