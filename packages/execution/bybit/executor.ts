import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { calculateRisk } from '../../strategies/btc-strategy-nfp-etf-v1/src/risk';
import { BybitError } from './client';
import { ceilStep, ExecutionBlocked, floorStep, planEntry } from './sizing';
import { EXECUTOR_ID, EXECUTOR_VERSION, ExecutionRequestSchema, ExecutorSettingsSchema, systemClock } from './types';
import type { Clock, EntryPayload, ExchangeClient, ExecutionRequest, ExecutionResult, ExecutorSettings, ExecutorStore, Fill, Intent, Lease, Order, Position, ProtectionPayload, SizingPlan } from './types';

const terminal = (order: Order): boolean => ['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled'].includes(order.orderStatus);
const finished = (intent: Intent): boolean => ['CLOSED', 'REJECTED', 'CANCELLED'].includes(intent.state);
const iso = (ms: number): string => new Date(ms).toISOString();
const errorCode = (error: unknown): string => error instanceof ExecutionBlocked || error instanceof BybitError ? error.code : 'EXECUTION_INFRASTRUCTURE_ERROR';
export function stableOrderLinkId(scope: string, scenarioId: string): string {
  return 'bnfp-' + createHash('sha256').update(scope + ':' + scenarioId).digest('hex').slice(0, 30);
}
export class BybitExecutor {
  readonly settings: ExecutorSettings;
  readonly scope: string;
  constructor(private readonly client: ExchangeClient, private readonly store: ExecutorStore, settings: zSettings, private readonly clock: Clock = systemClock) {
    this.settings = ExecutorSettingsSchema.parse(settings);
    this.scope = `${this.settings.environment}:${this.settings.expectedAccountId}:BTCUSDT`;
    if (client.environment !== this.settings.environment) throw new ExecutionBlocked('CLIENT_ENVIRONMENT_MISMATCH');
  }
  private result(status: ExecutionResult['status'], reasonCodes: string[] = [], intent?: Intent): ExecutionResult {
    return {
      tradingMode: this.settings.tradingMode, executorId: EXECUTOR_ID, executorVersion: EXECUTOR_VERSION,
      environment: this.settings.environment, accountId: this.settings.expectedAccountId, status, reasonCodes, leverage: this.settings.leverage,
      ...(intent ? {
        orderLinkId: intent.orderLinkId, ...(intent.orderId ? { orderId: intent.orderId } : {}), qtyRequested: intent.plan.qty,
        qtyFilled: intent.qtyFilled, qtyRemaining: intent.qtyRemaining, ...(intent.avgFillPrice ? { avgFillPrice: intent.avgFillPrice } : {}),
        notionalPlannedUsd: intent.plan.notionalPlannedUsd, notionalFilledUsd: intent.notionalFilledUsd,
        protectionConfirmed: intent.protectionConfirmed, feesUsdt: intent.feesUsdt, feesByCurrency: intent.feesByCurrency,
        takeProfitUsdt: intent.plan.takeProfitUsdt, stopLossUsdt: intent.plan.stopLossUsdt,
        ...(intent.nextReconcileAtUtc ? { nextReconcileAtUtc: intent.nextReconcileAtUtc } : {}),
      } : {}),
    };
  }
  private async save(lease: Lease, intent: Intent): Promise<void> {
    intent.updatedAtUtc = iso(this.clock.now());
    if (finished(intent)) delete intent.nextReconcileAtUtc;
    else intent.nextReconcileAtUtc = iso(this.clock.now() + (intent.state === 'PROTECTED' ? 20000 : 1000));
    await this.store.saveIntent(lease, intent);
  }
  private async mutate(lease: Lease, action: () => Promise<void>): Promise<void> {
    await this.store.assertLease(lease, this.clock.now());
    if (lease.expiresAtMs - this.clock.now() < 10000) throw new ExecutionBlocked('LEASE_TOO_CLOSE_TO_EXPIRY');
    await action();
  }
  private async withLease(action: (lease: Lease) => Promise<ExecutionResult>): Promise<ExecutionResult> {
    const lease = await this.store.acquire(this.scope, randomUUID(), this.clock.now(), this.settings.leaseTtlMs);
    if (!lease) return this.result('LOCKED', ['ACCOUNT_SYMBOL_LOCKED']);
    try { return await action(lease); }
    finally { await this.store.release(lease); }
  }
  private async confirmIdentity(): Promise<void> {
    // Managing an existing position must not depend on a working wallet-balance endpoint.
    const account = await (this.client.getAccountIdentity ? this.client.getAccountIdentity() : this.client.getAccount());
    if (account.uid !== this.settings.expectedAccountId) throw new ExecutionBlocked('ACCOUNT_IDENTITY_MISMATCH');
  }
  /** Called before macro/provider work by the host. All nonterminal intents for the account are reconciled. */
  async reconcile(): Promise<ExecutionResult> {
    if (this.settings.tradingMode === 'dry_run') return this.result('NO_ENTRY', ['DRY_RUN_NO_EXCHANGE_MUTATIONS']);
    try {
      return await this.withLease(async lease => {
        await this.confirmIdentity();
        const intents = await this.store.readIntents(lease);
        const active = intents.filter(i => !finished(i));
        for (const intent of active) await this.reconcileSafely(lease, intent);
        const current = active[active.length - 1];
        return { ...(current ? this.result(current.state, [current.blockReason ?? current.closeReason].filter((x): x is string => Boolean(x)), current) : this.result('NO_ENTRY')), reconciled: active.map(i => ({ scenarioId: i.scenarioId, state: i.state, ...(i.blockReason || i.closeReason ? { reason: i.blockReason ?? i.closeReason } : {}) })) };
      });
    } catch (error) { return this.result('BLOCKED', [errorCode(error)]); }
  }
  async execute(input: ExecutionRequest): Promise<ExecutionResult> {
    const parsed = ExecutionRequestSchema.safeParse(input);
    if (!parsed.success) return this.result('BLOCKED', ['EXECUTION_INPUT_INVALID']);
    const request = parsed.data;
    if (this.settings.tradingMode === 'dry_run') return this.dryRun(request);
    try {
      return await this.withLease(async lease => {
        await this.confirmIdentity();
        const intents = await this.store.readIntents(lease);
        // A waiting, expired or opposite signal cannot interrupt existing protection or ownership checks.
        for (const existing of intents.filter(i => !finished(i))) await this.reconcileSafely(lease, existing);
        const same = intents.find(i => i.scenarioId === request.scenarioId);
        if (same) return this.result(same.state, [same.blockReason ?? same.closeReason ?? 'SCENARIO_INTENT_ALREADY_EXISTS'], same);
        if (intents.some(i => !finished(i))) return this.result('BLOCKED', ['OTHER_INTENT_UNRESOLVED']);
        const blocked = this.entryGate(request);
        if (blocked) return this.result(request.decision === 'NO_TRADE' ? 'NO_ENTRY' : 'BLOCKED', [blocked]);
        const account = await this.client.getAccount();
        if (account.uid !== this.settings.expectedAccountId) throw new ExecutionBlocked('ACCOUNT_IDENTITY_MISMATCH');
        if (!this.settings.dedicatedAccountConfirmed || account.readOnly || !account.canTrade || account.canWithdraw) throw new ExecutionBlocked('ACCOUNT_PERMISSIONS_OR_DEDICATION_INVALID');
        if (!['ISOLATED_MARGIN', 'REGULAR_MARGIN'].includes(account.marginMode)) throw new ExecutionBlocked('MARGIN_MODE_INCOMPATIBLE');
        const [positions, orders, instrument] = await Promise.all([this.client.getPositions(), this.client.getOpenOrders(), this.client.getInstrument()]);
        const realPositions = positions.filter(p => p.symbol === 'BTCUSDT' && (p.seq === undefined || p.seq !== -1));
        if (realPositions.length !== 1 || realPositions[0]?.positionIdx !== 0) throw new ExecutionBlocked('POSITION_MODE_INCOMPATIBLE');
        if (realPositions.some(p => new Decimal(p.size).gt(0))) throw new ExecutionBlocked('FOREIGN_POSITION_EXISTS');
        if (realPositions.some(p => !new Decimal(p.leverage || '0').eq(this.settings.leverage))) throw new ExecutionBlocked('LEVERAGE_INCOMPATIBLE');
        if (orders.length) throw new ExecutionBlocked('FOREIGN_ORDERS_EXIST');
        // Book is refreshed last, immediately before durable submission preparation.
        const book = await this.client.getBook();
        const plan = planEntry(request, this.settings, instrument, book, this.clock.now());
        if (new Decimal(account.availableUsdt).lt(plan.requiredFundsUsdt)) throw new ExecutionBlocked('INSUFFICIENT_AVAILABLE_BALANCE');
        const link = stableOrderLinkId(this.scope, request.scenarioId);
        const payload = this.payload(request, plan, link);
        const intent: Intent = {
          id: link, scenarioId: request.scenarioId, evaluationId: request.evaluationId, configHash: request.configHash,
          scope: this.scope, environment: this.settings.environment, accountId: account.uid, state: 'PREPARED', side: payload.side,
          createdAtUtc: iso(this.clock.now()), updatedAtUtc: iso(this.clock.now()), expiresAtUtc: request.expiresAtUtc,
          closeOnScenarioExpiry: request.closeOnScenarioExpiry, orderLinkId: link, payload, plan, instrument,
          usdPerUsdt: request.usdPerUsdt!.value, costs: request.costs!, minRewardRisk: Decimal.max(request.minRewardRisk, '1.5').toFixed(),
          qtyFilled: '0', qtyRemaining: plan.qty, notionalFilledUsd: '0', feesUsdt: '0', feesByCurrency: {}, executionFills: [], protectionConfirmed: false,
          protectionDeadlineUtc: iso(this.clock.now() + this.settings.protectionDeadlineMs), ownedOrderIds: [], closeAttempts: [],
          nextReconcileAtUtc: iso(this.clock.now() + 1000),
        };
        if (!await this.store.createIntent(lease, intent)) return this.result('BLOCKED', ['SCENARIO_INTENT_ALREADY_EXISTS']);
        const lastGate = this.entryGate(request);
        if (lastGate) { intent.state = 'CANCELLED'; intent.blockReason = lastGate; await this.save(lease, intent); return this.result(intent.state, [lastGate], intent); }
        // Commit SUBMITTING before any network side effect. A crash after this point is always reconciled, never resent.
        intent.state = 'SUBMITTING'; await this.save(lease, intent);
        try {
          await this.mutate(lease, async () => {
            // Persistence/task dispatch can take time. A final local freshness check is mandatory after it.
            const sendGate = this.entryGate(request);
            if (sendGate) throw new ExecutionBlocked(sendGate);
            planEntry(request, this.settings, instrument, book, this.clock.now());
            const ack = await this.client.createOrder(payload);
            intent.orderId = ack.orderId; intent.ownedOrderIds.push(ack.orderId);
          });
        } catch (error) {
          intent.state = error instanceof ExecutionBlocked ? 'CANCELLED' : error instanceof BybitError && !error.ambiguous ? 'REJECTED' : 'UNKNOWN';
          intent.blockReason = errorCode(error); await this.save(lease, intent);
          if (finished(intent)) return this.result(intent.state, [intent.blockReason], intent);
        }
        await this.save(lease, intent);
        // Acknowledgement is not execution. Poll for fills and native full-position protection.
        for (let round = 0; round < 18; round++) {
          await this.reconcileSafely(lease, intent);
          if (finished(intent) || ['PROTECTED', 'EMERGENCY_CLOSE_PENDING'].includes(intent.state) || intent.blockReason === 'OWNERSHIP_CONFLICT') break;
          if (this.clock.now() > Date.parse(intent.protectionDeadlineUtc) + 3000) break;
          await this.clock.sleep(this.settings.pollIntervalMs);
        }
        return this.result(intent.state, [intent.blockReason ?? intent.closeReason].filter((x): x is string => Boolean(x)), intent);
      });
    } catch (error) { return this.result('BLOCKED', [errorCode(error)]); }
  }
  private entryGate(request: ExecutionRequest): string | undefined {
    if (request.decision === 'NO_TRADE') return 'NO_TRADE';
    if (!this.settings.allowNewEntries) return 'NEW_ENTRIES_PAUSED';
    if (this.clock.now() >= Date.parse(request.expiresAtUtc)) return 'SCENARIO_EXPIRED';
    if (this.clock.now() >= Date.parse(request.validUntilUtc)) return 'SIGNAL_EXPIRED';
    if (request.environment !== this.settings.environment) return 'ENVIRONMENT_MISMATCH';
    // Administrative labels and optional historical testnet evidence do not gate a live entry.
    // Native TP/SL must still be confirmed against the actual fill during reconciliation.
    if (this.settings.tradingMode === 'live' && request.snapshotSynthetic) return 'LIVE_SYNTHETIC_INPUT';
    return undefined;
  }
  private payload(request: ExecutionRequest, plan: SizingPlan, orderLinkId: string): EntryPayload {
    return { category: 'linear', symbol: 'BTCUSDT', side: request.decision === 'LONG' ? 'Buy' : 'Sell',
      orderType: 'Limit', timeInForce: 'IOC', positionIdx: 0, qty: plan.qty, price: plan.limitPrice,
      orderLinkId, reduceOnly: false, takeProfit: plan.takeProfitUsdt, stopLoss: plan.stopLossUsdt,
      tpslMode: 'Full', tpOrderType: 'Market', slOrderType: 'Market', tpTriggerBy: 'LastPrice', slTriggerBy: 'LastPrice' };
  }
  private async dryRun(request: ExecutionRequest): Promise<ExecutionResult> {
    const blocked = this.entryGate(request);
    if (blocked) return this.result(request.decision === 'NO_TRADE' ? 'NO_ENTRY' : 'BLOCKED', [blocked]);
    try {
      const instrument = await this.client.getInstrument();
      const plan = planEntry(request, this.settings, instrument, await this.client.getBook(), this.clock.now());
      const payload = this.payload(request, plan, stableOrderLinkId('dry:' + this.scope, request.scenarioId));
      return { ...this.result('DRY_RUN', ['SIMULATED_NOT_SUBMITTED']), payload, orderLinkId: payload.orderLinkId, qtyRequested: plan.qty, qtyFilled: '0', notionalPlannedUsd: plan.notionalPlannedUsd, notionalFilledUsd: '0', protectionConfirmed: false, takeProfitUsdt: plan.takeProfitUsdt, stopLossUsdt: plan.stopLossUsdt };
    } catch (error) { return this.result('BLOCKED', [errorCode(error)]); }
  }
  private async reconcileSafely(lease: Lease, intent: Intent): Promise<void> {
    try { await this.reconcileIntent(lease, intent); }
    catch (error) {
      intent.blockReason = errorCode(error);
      if (intent.state === 'CLOSING' || intent.state === 'EMERGENCY_CLOSE_PENDING') intent.state = 'EMERGENCY_CLOSE_PENDING';
      else if (!finished(intent)) intent.state = 'UNKNOWN';
      await this.save(lease, intent);
    }
  }
  private async reconcileIntent(lease: Lease, intent: Intent): Promise<void> {
    if (finished(intent)) return;
    if (intent.scope !== this.scope || intent.accountId !== this.settings.expectedAccountId || intent.environment !== this.client.environment) throw new ExecutionBlocked('INTENT_ACCOUNT_ENVIRONMENT_MISMATCH');
    if (intent.state === 'PREPARED') {
      // No side effect was committed. Conservatively consume the one scenario intent after a preparing worker crashed.
      intent.state = 'CANCELLED'; intent.blockReason = 'PREPARED_INTENT_INTERRUPTED'; await this.save(lease, intent); return;
    }
    const start = Date.parse(intent.createdAtUtc);
    const [entry, positions, open, history, fillsRaw] = await Promise.all([
      this.client.findOrder(intent.orderLinkId, start), this.client.getPositions(), this.client.getOpenOrders(),
      this.client.getOrdersSince(start), this.client.getFills(start),
    ]);
    const fills = [...new Map(fillsRaw.filter(f => f.execType === 'Trade').map(f => [f.execId, f])).values()];
    const orders = [...new Map([...history, ...open, ...(entry ? [entry] : [])].map(o => [o.orderId, o])).values()];
    if (entry) { intent.orderId = entry.orderId; intent.qtyRemaining = entry.leavesQty; }
    const links = new Set([intent.orderLinkId, ...intent.closeAttempts.map(c => c.orderLinkId)]);
    const ownedIds = new Set(intent.ownedOrderIds);
    if (intent.orderId) ownedIds.add(intent.orderId);
    for (const order of orders) if (links.has(order.orderLinkId) || order.parentOrderLinkId === intent.orderLinkId) ownedIds.add(order.orderId);
    intent.ownedOrderIds = [...ownedIds];
    intent.executionFills = fills.filter(f => ownedIds.has(f.orderId) || links.has(f.orderLinkId));
    intent.feesByCurrency = {};
    for (const fill of intent.executionFills) intent.feesByCurrency[fill.feeCurrency || 'UNKNOWN'] = new Decimal(intent.feesByCurrency[fill.feeCurrency || 'UNKNOWN'] ?? 0).plus(fill.execFee).toFixed();
    const entryFills = fills.filter(f => f.orderLinkId === intent.orderLinkId || f.orderId === intent.orderId);
    const qty = entryFills.reduce((a, f) => a.plus(f.execQty), new Decimal(0));
    const value = entryFills.reduce((a, f) => a.plus(new Decimal(f.execQty).mul(f.execPrice)), new Decimal(0));
    // Order cumulative quantities cannot replace execution evidence for attribution or average fill accounting.
    if (qty.gt(0)) {
      intent.qtyFilled = qty.toFixed(); intent.avgFillPrice = value.div(qty).toFixed(); intent.notionalFilledUsd = value.mul(intent.usdPerUsdt).toFixed();
      intent.feesUsdt = fills.filter(f => ownedIds.has(f.orderId) && f.feeCurrency === 'USDT').reduce((a, f) => a.plus(f.execFee), new Decimal(0)).toFixed();
      if (!intent.closeReason) intent.state = qty.lt(intent.plan.qty) ? 'PARTIALLY_FILLED' : 'FILLED';
    }
    const position = positions.find(p => p.positionIdx === 0);
    const flat = positions.length > 0 && positions.every(p => new Decimal(p.size).eq(0));
    if (flat && entry && terminal(entry)) {
      if (qty.eq(0) && new Decimal(entry.cumExecQty).eq(0)) {
        intent.state = entry.orderStatus === 'Rejected' ? 'REJECTED' : 'CANCELLED'; intent.protectionConfirmed = false;
        await this.save(lease, intent); return;
      }
      if (qty.gt(0)) {
        if (!intent.firstFlatAtUtc) intent.firstFlatAtUtc = iso(this.clock.now());
        if (this.clock.now() - Date.parse(intent.firstFlatAtUtc) >= 2000) {
          // Two fresh flat observations plus terminal entry evidence. Do not erase stops before this point.
          intent.state = 'CLOSED'; intent.protectionConfirmed = false; intent.qtyRemaining = '0';
          for (const order of open.filter(o => ownedIds.has(o.orderId))) await this.mutate(lease, () => this.client.cancelOrder(order.orderId));
          await this.save(lease, intent); return;
        }
      }
    } else { delete intent.firstFlatAtUtc; }
    if (!position || flat || qty.eq(0)) {
      if (intent.closeReason) intent.state = 'EMERGENCY_CLOSE_PENDING'; else intent.state = 'UNKNOWN';
      intent.blockReason = 'AWAITING_EXCHANGE_EVIDENCE';
      if (this.clock.now() >= Date.parse(intent.expiresAtUtc) && intent.closeOnScenarioExpiry && entry && !terminal(entry)) await this.mutate(lease, () => this.client.cancelOrder(entry.orderId));
      await this.save(lease, intent); return;
    }
    const foreignFills = fills.some(f => !ownedIds.has(f.orderId) && !links.has(f.orderLinkId));
    const signedOwnedQty = fills.filter(f => ownedIds.has(f.orderId) || links.has(f.orderLinkId)).reduce((a, f) => a.plus(new Decimal(f.execQty).mul(f.side === intent.side ? 1 : -1)), new Decimal(0));
    const averageMatches = position.avgPrice && new Decimal(position.avgPrice).minus(intent.avgFillPrice!).abs().lte(intent.instrument.tickSize);
    if (foreignFills || !averageMatches || position.side !== intent.side || positions.some(p => p.positionIdx !== 0 && new Decimal(p.size).gt(0)) || !signedOwnedQty.eq(position.size) || open.some(o => !ownedIds.has(o.orderId))) {
      intent.state = 'UNKNOWN'; intent.blockReason = 'OWNERSHIP_CONFLICT'; await this.save(lease, intent); return;
    }
    delete intent.blockReason;
    const remainingEntryValueUsd = new Decimal(position.size).mul(intent.avgFillPrice!).mul(intent.usdPerUsdt);
    if (intent.closeReason === 'ACTUAL_ENTRY_NOTIONAL_ABOVE_BUDGET' && remainingEntryValueUsd.lte(new Decimal(this.settings.targetPositionNotionalUsd).plus(this.settings.monetaryPrecisionUsd))) delete intent.closeReason;
    if (intent.closeOnScenarioExpiry && this.clock.now() >= Date.parse(intent.expiresAtUtc)) intent.closeReason = 'SCENARIO_EXPIRED';
    if (entryFills.some(f => f.feeCurrency !== 'USDT')) intent.closeReason = 'ACTUAL_FEE_CURRENCY_UNSUPPORTED';
    const paidEntryFees = entryFills.filter(f => f.feeCurrency === 'USDT').reduce((sum, f) => sum.plus(f.execFee), new Decimal(0));
    const actualCosts = { ...intent.costs, entryFeeBps: Decimal.max(intent.costs.entryFeeBps, paidEntryFees.div(value).mul(10000)).toFixed() };
    const actualRisk = calculateRisk({ direction: intent.side === 'Buy' ? 'LONG' : 'SHORT', entryUsdt: intent.avgFillPrice!, usdPerUsdt: '1',
      tickSize: intent.instrument.tickSize, levels: { takeProfitUsd: intent.plan.takeProfitUsdt, stopLossUsd: intent.plan.stopLossUsdt }, costs: actualCosts, minRewardRisk: intent.minRewardRisk });
    if (!actualRisk.valid) intent.closeReason = 'ACTUAL_FILL_RR_BELOW_MINIMUM';
    if (!intent.closeReason && remainingEntryValueUsd.gt(new Decimal(this.settings.targetPositionNotionalUsd).plus(this.settings.monetaryPrecisionUsd))) intent.closeReason = 'ACTUAL_ENTRY_NOTIONAL_ABOVE_BUDGET';
    if (intent.closeReason) { await this.closeOwned(lease, intent, position, entry, orders); return; }
    const protection = this.protectionConfirmed(intent, position, open);
    if (protection) {
      if (!intent.protectionReconciliationAttempted) intent.initialProtectionConfirmed = true;
      intent.protectionConfirmed = true; intent.state = 'PROTECTED'; await this.save(lease, intent); return;
    }
    intent.protectionConfirmed = false;
    if (this.clock.now() >= Date.parse(intent.protectionDeadlineUtc)) {
      intent.closeReason = 'NATIVE_PROTECTION_UNCONFIRMED'; await this.closeOwned(lease, intent, position, entry, orders); return;
    }
    // Record a persistent retry before reconciling native stops; both legs always stay bound to the stored levels.
    intent.protectionReconciliationAttempted = true;
    await this.save(lease, intent);
    try { await this.mutate(lease, () => this.client.setTradingStop(this.protectionPayload(intent))); }
    catch (error) { intent.blockReason = errorCode(error); await this.save(lease, intent); }
  }
  private protectionPayload(intent: Intent): ProtectionPayload {
    return { category: 'linear', symbol: 'BTCUSDT', positionIdx: 0, tpslMode: 'Full', takeProfit: intent.plan.takeProfitUsdt,
      stopLoss: intent.plan.stopLossUsdt, tpOrderType: 'Market', slOrderType: 'Market', tpTriggerBy: 'LastPrice', slTriggerBy: 'LastPrice' };
  }
  private protectionConfirmed(intent: Intent, position: Position, orders: Order[]): boolean {
    if (!new Decimal(position.takeProfit || 0).eq(intent.plan.takeProfitUsdt) || !new Decimal(position.stopLoss || 0).eq(intent.plan.stopLossUsdt)) return false;
    return (['TakeProfit', 'StopLoss'] as const).every(kind => orders.some(o =>
      o.parentOrderLinkId === intent.orderLinkId && o.stopOrderType === kind && o.tpslMode === 'Full' &&
      o.orderType === 'Market' && o.triggerBy === 'LastPrice' && o.positionIdx === 0 &&
      new Decimal(o.triggerPrice || 0).eq(kind === 'TakeProfit' ? intent.plan.takeProfitUsdt : intent.plan.stopLossUsdt) && new Decimal(o.qty).gte(position.size)));
  }
  private async closeOwned(lease: Lease, intent: Intent, position: Position, entry: Order | undefined, orders: Order[]): Promise<void> {
    intent.state = 'CLOSING'; await this.save(lease, intent);
    if (entry && !terminal(entry)) await this.mutate(lease, () => this.client.cancelOrder(entry.orderId));
    const previous = intent.closeAttempts[intent.closeAttempts.length - 1];
    if (previous && previous.status !== 'TERMINAL') {
      const order = orders.find(o => o.orderLinkId === previous.orderLinkId || o.orderId === previous.orderId);
      if (!order || !terminal(order)) {
        intent.state = 'EMERGENCY_CLOSE_PENDING'; intent.blockReason = 'CLOSE_RESULT_UNKNOWN'; await this.save(lease, intent); return;
      }
      previous.status = 'TERMINAL';
    }
    let closeQty = new Decimal(position.size);
    if (intent.closeReason === 'ACTUAL_ENTRY_NOTIONAL_ABOVE_BUDGET') {
      const allowed = floorStep(new Decimal(this.settings.targetPositionNotionalUsd).div(intent.usdPerUsdt).div(intent.avgFillPrice!), intent.instrument.qtyStep);
      const excess = ceilStep(closeQty.minus(allowed), intent.instrument.qtyStep);
      if (excess.gt(0) && excess.gte(intent.instrument.minOrderQty) && excess.mul(intent.avgFillPrice!).gte(intent.instrument.minNotionalValue) && allowed.gte(intent.instrument.minOrderQty)) closeQty = excess;
      // Otherwise close our entire position: never round an entry up to meet an exchange minimum.
    }
    closeQty = Decimal.min(closeQty, intent.instrument.maxMktOrderQty);
    const link = 'bnc-' + createHash('sha256').update(intent.id + ':' + intent.closeAttempts.length).digest('hex').slice(0, 30);
    const attempt: Intent['closeAttempts'][number] = { orderLinkId: link, qty: closeQty.toFixed(), status: 'SUBMITTING' };
    intent.closeAttempts.push(attempt); await this.save(lease, intent);
    try {
      await this.mutate(lease, async () => {
        const ack = await this.client.createOrder({ category: 'linear', symbol: 'BTCUSDT', side: intent.side === 'Buy' ? 'Sell' : 'Buy',
          orderType: 'Market', timeInForce: 'IOC', positionIdx: 0, qty: closeQty.toFixed(), orderLinkId: link, reduceOnly: true });
        attempt.orderId = ack.orderId; intent.ownedOrderIds.push(ack.orderId);
      });
    } catch (error) {
      attempt.status = error instanceof BybitError && !error.ambiguous ? 'TERMINAL' : 'UNKNOWN';
      intent.blockReason = errorCode(error);
    }
    intent.state = 'EMERGENCY_CLOSE_PENDING'; await this.save(lease, intent);
  }
}
type zSettings = import('zod').input<typeof ExecutorSettingsSchema>;
