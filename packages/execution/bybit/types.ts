import { z } from 'zod';

export const EXECUTOR_ID = 'bybit-linear-executor-v1' as const;
export const EXECUTOR_VERSION = '1.0.0' as const;
const positive = z.string().regex(/^\d+(\.\d+)?$/).refine(v => Number(v) > 0 && Number.isFinite(Number(v)));
const nonnegative = z.string().regex(/^\d+(\.\d+)?$/);
export const CostsSchema = z.object({
  entryFeeBps: nonnegative, exitFeeBps: nonnegative, exitSlippageBps: nonnegative,
  fundingToTpPerBtcUsdt: nonnegative, fundingToSlPerBtcUsdt: nonnegative, description: z.string().min(1),
});
export type ExecutionCosts = z.infer<typeof CostsSchema>;
export const ExecutorSettingsSchema = z.object({
  tradingMode: z.enum(['dry_run', 'testnet', 'live']),
  environment: z.enum(['testnet', 'mainnet']), expectedAccountId: z.string().min(1),
  dedicatedAccountConfirmed: z.boolean(), allowNewEntries: z.boolean(),
  targetPositionNotionalUsd: z.enum(['100', '2000']).default('100'), leverage: z.enum(['1', '20']).default('1'),
  entrySlippageBps: nonnegative.default('10'), monetaryPrecisionUsd: positive.default('0.01'),
  protectionDeadlineMs: z.number().int().min(1000).max(15000).default(15000),
  quoteMaxAgeMs: z.number().int().min(1).max(60000).default(60000),
  fxMaxAgeMs: z.number().int().positive().default(60000),
  leaseTtlMs: z.number().int().min(240000).default(240000),
  pollIntervalMs: z.number().int().min(1).max(2000).default(1000),
  compatibilityAttestation: z.object({
    evidenceId: z.string().min(1), verifiedAtUtc: z.string().datetime(),
    executorVersion: z.literal(EXECUTOR_VERSION), environment: z.literal('testnet'),
    combination: z.literal('BTCUSDT:Limit:IOC:Full:Market:LastPrice'),
    initialProtectionConfirmed: z.literal(true), partialFillProtectionConfirmed: z.literal(true),
  }).optional(),
}).superRefine((v, ctx) => {
  if (v.tradingMode === 'live' && v.environment !== 'mainnet' || v.tradingMode === 'testnet' && v.environment !== 'testnet')
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MODE_ENVIRONMENT_MISMATCH' });
});
export type ExecutorSettings = z.infer<typeof ExecutorSettingsSchema>;
export const ExecutionRequestSchema = z.object({
  decision: z.enum(['LONG', 'SHORT', 'NO_TRADE']), scenarioId: z.string().min(1),
  evaluationId: z.string().min(1), configHash: z.string().min(1),
  validUntilUtc: z.string().datetime(), expiresAtUtc: z.string().datetime(),
  isDemo: z.boolean(), sourcesValidated: z.boolean(), snapshotSynthetic: z.boolean(),
  environment: z.enum(['testnet', 'mainnet']), closeOnScenarioExpiry: z.boolean(),
  usdPerUsdt: z.object({ value: positive, observedAtUtc: z.string().datetime(), verified: z.boolean() }).optional(),
  levels: z.object({ takeProfitUsd: positive, stopLossUsd: positive }).optional(),
  costs: CostsSchema.optional(), minRewardRisk: positive.default('1.5'),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;
export type Environment = 'testnet' | 'mainnet';
export type Side = 'Buy' | 'Sell';
export type IntentState = 'PREPARED' | 'SUBMITTING' | 'UNKNOWN' | 'REJECTED' | 'CANCELLED' |
  'PARTIALLY_FILLED' | 'FILLED' | 'PROTECTED' | 'CLOSING' | 'CLOSED' | 'EMERGENCY_CLOSE_PENDING';
export interface Lease { scope: string; owner: string; fence: number; expiresAtMs: number }
export interface Instrument {
  symbol: 'BTCUSDT'; status: string; baseCoin: string; quoteCoin: string; settleCoin: string;
  contractType: string; tickSize: string; minPrice: string; maxPrice: string;
  qtyStep: string; minOrderQty: string; minNotionalValue: string; maxOrderQty: string; maxMktOrderQty: string;
}
export interface Book { environment: Environment; bid: string; ask: string; observedAtMs: number }
export interface Position {
  symbol: string; positionIdx: number; side: string; size: string; avgPrice: string; leverage: string;
  takeProfit: string; stopLoss: string; seq?: number;
}
export interface Order {
  orderId: string; orderLinkId: string; parentOrderLinkId?: string; symbol: string; side: string;
  orderStatus: string; qty: string; cumExecQty: string; leavesQty: string; avgPrice: string;
  reduceOnly: boolean; positionIdx: number; stopOrderType?: string; triggerPrice?: string;
  triggerBy?: string; tpslMode?: string; orderType?: string; createdTime: string;
}
export interface Fill {
  execId: string; orderId: string; orderLinkId: string; side: string; execQty: string;
  execPrice: string; execFee: string; feeCurrency: string; execTime: string; execType: string;
}
export interface Account {
  uid: string; marginMode: string; unifiedMarginStatus: number; readOnly: boolean;
  canTrade: boolean; canWithdraw: boolean; availableUsdt: string;
}
export interface EntryPayload {
  category: 'linear'; symbol: 'BTCUSDT'; side: Side; orderType: 'Limit'; timeInForce: 'IOC';
  positionIdx: 0; qty: string; price: string; orderLinkId: string; reduceOnly: false;
  takeProfit: string; stopLoss: string; tpslMode: 'Full'; tpOrderType: 'Market'; slOrderType: 'Market';
  tpTriggerBy: 'LastPrice'; slTriggerBy: 'LastPrice';
}
export interface ClosePayload {
  category: 'linear'; symbol: 'BTCUSDT'; side: Side; orderType: 'Market'; timeInForce: 'IOC';
  positionIdx: 0; qty: string; orderLinkId: string; reduceOnly: true;
}
export interface ProtectionPayload {
  category: 'linear'; symbol: 'BTCUSDT'; positionIdx: 0; tpslMode: 'Full';
  takeProfit: string; stopLoss: string; tpOrderType: 'Market'; slOrderType: 'Market';
  tpTriggerBy: 'LastPrice'; slTriggerBy: 'LastPrice';
}
export interface ExchangeClient {
  readonly environment: Environment;
  getAccountIdentity?(): Promise<{ uid: string }>;
  getAccount(): Promise<Account>;
  getInstrument(): Promise<Instrument>;
  getBook(): Promise<Book>;
  getPositions(): Promise<Position[]>;
  getOpenOrders(): Promise<Order[]>;
  getOrdersSince(startMs: number): Promise<Order[]>;
  findOrder(orderLinkId: string, startMs: number): Promise<Order | undefined>;
  getFills(startMs: number): Promise<Fill[]>;
  createOrder(payload: EntryPayload | ClosePayload): Promise<{ orderId: string }>;
  cancelOrder(orderId: string): Promise<void>;
  setTradingStop(payload: ProtectionPayload): Promise<void>;
}
export interface SizingPlan {
  qty: string; limitPrice: string; sizingPrice: string; targetNotionalUsdt: string;
  notionalPlannedUsd: string; takeProfitUsdt: string; stopLossUsdt: string;
  rewardRisk: string; requiredFundsUsdt: string;
}
export interface CloseAttempt {
  orderLinkId: string; orderId?: string; qty: string; status: 'SUBMITTING' | 'UNKNOWN' | 'TERMINAL';
}
export interface Intent {
  id: string; scenarioId: string; evaluationId: string; configHash: string; scope: string;
  environment: Environment; accountId: string; state: IntentState; side: Side;
  createdAtUtc: string; updatedAtUtc: string; expiresAtUtc: string; closeOnScenarioExpiry: boolean;
  orderLinkId: string; orderId?: string; payload: EntryPayload; plan: SizingPlan; instrument: Instrument;
  usdPerUsdt: string; costs: ExecutionCosts; minRewardRisk: string;
  qtyFilled: string; qtyRemaining: string; avgFillPrice?: string; notionalFilledUsd: string;
  feesUsdt: string; feesByCurrency: Record<string, string>; executionFills: Fill[]; protectionConfirmed: boolean; protectionDeadlineUtc: string;
  ownedOrderIds: string[]; closeAttempts: CloseAttempt[]; closeReason?: string; blockReason?: string;
  nextReconcileAtUtc?: string; firstFlatAtUtc?: string; initialProtectionConfirmed?: boolean; protectionReconciliationAttempted?: boolean;
}
/** Every write checks owner+fence+lease expiration in a transaction. Never call Bybit inside it.
 * createIntent atomically enforces one intent per scenario, regardless of configuration revision.
 * saveIntent must persist nextReconcileAtUtc before returning; the host maintains prompt durable tasks.
 */
export interface ExecutorStore {
  acquire(scope: string, owner: string, nowMs: number, ttlMs: number): Promise<Lease | null>;
  readIntents(lease: Lease): Promise<Intent[]>;
  createIntent(lease: Lease, intent: Intent): Promise<boolean>;
  saveIntent(lease: Lease, intent: Intent): Promise<void>;
  assertLease(lease: Lease, nowMs: number): Promise<void>;
  release(lease: Lease): Promise<void>;
}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const systemClock: Clock = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export interface ExecutionResult {
  tradingMode: ExecutorSettings['tradingMode']; executorId: typeof EXECUTOR_ID; executorVersion: typeof EXECUTOR_VERSION;
  environment: Environment; accountId: string; status: IntentState | 'BLOCKED' | 'DRY_RUN' | 'NO_ENTRY' | 'LOCKED';
  reasonCodes: string[]; leverage: '1' | '20'; orderLinkId?: string; orderId?: string; qtyRequested?: string;
  qtyFilled?: string; qtyRemaining?: string; avgFillPrice?: string; notionalPlannedUsd?: string;
  notionalFilledUsd?: string; protectionConfirmed?: boolean; feesUsdt?: string; feesByCurrency?: Record<string, string>;
  takeProfitUsdt?: string; stopLossUsdt?: string; nextReconcileAtUtc?: string;
  payload?: EntryPayload; reconciled?: Array<{scenarioId: string; state: IntentState; reason?: string}>;
}
const intentStateSchema = z.enum(['PREPARED', 'SUBMITTING', 'UNKNOWN', 'REJECTED', 'CANCELLED', 'PARTIALLY_FILLED', 'FILLED', 'PROTECTED', 'CLOSING', 'CLOSED', 'EMERGENCY_CLOSE_PENDING']);
export const EntryPayloadSchema = z.object({
  category: z.literal('linear'), symbol: z.literal('BTCUSDT'), side: z.enum(['Buy', 'Sell']),
  orderType: z.literal('Limit'), timeInForce: z.literal('IOC'), positionIdx: z.literal(0), qty: positive,
  price: positive, orderLinkId: z.string().min(1).max(36), reduceOnly: z.literal(false),
  takeProfit: positive, stopLoss: positive, tpslMode: z.literal('Full'), tpOrderType: z.literal('Market'), slOrderType: z.literal('Market'),
  tpTriggerBy: z.literal('LastPrice'), slTriggerBy: z.literal('LastPrice'),
}).strict();
export const ExecutionResultSchema = z.object({
  tradingMode: z.enum(['dry_run', 'testnet', 'live']), executorId: z.literal(EXECUTOR_ID), executorVersion: z.literal(EXECUTOR_VERSION),
  environment: z.enum(['testnet', 'mainnet']), accountId: z.string(), status: z.union([intentStateSchema, z.enum(['BLOCKED', 'DRY_RUN', 'NO_ENTRY', 'LOCKED'])]),
  reasonCodes: z.array(z.string()), leverage: z.enum(['1', '20']), orderLinkId: z.string().max(36).optional(), orderId: z.string().optional(),
  qtyRequested: nonnegative.optional(), qtyFilled: nonnegative.optional(), qtyRemaining: nonnegative.optional(), avgFillPrice: positive.optional(),
  notionalPlannedUsd: nonnegative.optional(), notionalFilledUsd: nonnegative.optional(), protectionConfirmed: z.boolean().optional(),
  feesUsdt: z.string().regex(/^-?\d+(\.\d+)?$/).optional(), takeProfitUsdt: positive.optional(), stopLossUsdt: positive.optional(),
  feesByCurrency: z.record(z.string(), z.string().regex(/^-?\d+(\.\d+)?$/)).optional(),
  nextReconcileAtUtc: z.string().datetime().optional(), payload: EntryPayloadSchema.optional(),
  reconciled: z.array(z.object({ scenarioId: z.string(), state: intentStateSchema, reason: z.string().optional() }).strict()).optional(),
}).strict();
