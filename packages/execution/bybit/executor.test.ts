import { describe, expect, it } from 'vitest';
import { BybitExecutor, stableOrderLinkId } from './executor';
import { planEntry } from './sizing';
import { ExecutionRequest, ExecutorSettingsSchema, Intent, Lease } from './types';
import { FakeBybitClient, FakeClock, MemoryExecutorStore } from './testing';

const costs = { entryFeeBps: '5.5', exitFeeBps: '5.5', exitSlippageBps: '5', fundingToTpPerBtcUsdt: '1', fundingToSlPerBtcUsdt: '1', description: 'Synthetic explicit costs' };
function setup(mode: 'dry_run' | 'testnet' | 'live' = 'testnet') {
  const clock = new FakeClock();
  const client = new FakeBybitClient(mode === 'live' ? 'mainnet' : 'testnet', clock);
  const store = new MemoryExecutorStore(() => clock.now());
  const settings = ExecutorSettingsSchema.parse({ tradingMode: mode, environment: client.environment, expectedAccountId: 'fake-account', dedicatedAccountConfirmed: true, allowNewEntries: true });
  const request: ExecutionRequest = {
    decision: 'LONG', scenarioId: 'synthetic-scenario', evaluationId: 'synthetic-evaluation', configHash: 'test-config',
    validUntilUtc: new Date(clock.now() + 60000).toISOString(), expiresAtUtc: '2026-10-02T21:41:00Z',
    isDemo: false, sourcesValidated: true, snapshotSynthetic: mode !== 'live', environment: client.environment,
    closeOnScenarioExpiry: true, usdPerUsdt: { value: '1', observedAtUtc: new Date(clock.now()).toISOString(), verified: true },
    levels: { takeProfitUsd: '87400', stopLossUsd: '82900' }, costs, minRewardRisk: '1.5',
  };
  return { clock, client, store, settings, request, executor: new BybitExecutor(client, store, settings, clock) };
}
describe('decimal sizing, conservative entry limit and currency', () => {
  it('plans at most 100 USD and submits BTC quantities at 1x', () => {
    const t = setup(); const plan = planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now());
    expect(Number(plan.qty)).toBeLessThan(.002);
    expect(Number(plan.notionalPlannedUsd)).toBeLessThanOrEqual(100);
    expect(Number(plan.requiredFundsUsdt)).toBeGreaterThan(Number(plan.notionalPlannedUsd));
    expect(plan.limitPrice).toBe('84085');
  });
  it('converts USD to USDT before sizing and levels; rounding never raises nominal', () => {
    const t = setup(); t.request.usdPerUsdt!.value = '0.98'; t.request.levels = { takeProfitUsd: '87400', stopLossUsd: '81000' };
    const p = planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now());
    expect(Number(p.targetNotionalUsdt)).toBeCloseTo(100 / .98);
    expect(Number(p.notionalPlannedUsd)).toBeLessThanOrEqual(100);
    expect(Number(p.takeProfitUsdt)).toBeCloseTo(87400 / .98, 0);
  });
  it('blocks exchange minimum rather than rounding up', () => {
    const t = setup(); t.client.instrument.qtyStep = '.01'; t.client.instrument.minOrderQty = '.01';
    expect(() => planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now())).toThrow('SIZE_BELOW_EXCHANGE_MINIMUM');
  });
  it('checks max quantity, status, stale quote and stale FX', () => {
    const t = setup(); t.client.instrument.maxOrderQty = '.0001';
    expect(() => planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now())).toThrow('SIZE_ABOVE_EXCHANGE_MAXIMUM');
    t.client.instrument.maxOrderQty = '100'; t.client.instrument.status = 'Settling';
    expect(() => planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now())).toThrow('INSTRUMENT_INCOMPATIBLE');
    t.client.instrument.status = 'Trading'; t.client.book.observedAtMs -= 60001;
    expect(() => planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now())).toThrow('QUOTE_STALE_OR_INVALID');
    t.client.book.observedAtMs = t.clock.now(); t.request.usdPerUsdt!.observedAtUtc = new Date(t.clock.now() - 60001).toISOString();
    expect(() => planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now())).toThrow('FX_STALE_OR_UNVERIFIED');
  });
  it('does not widen a short limit and uses conservative sizing price', () => {
    const t = setup(); t.request.decision = 'SHORT'; t.request.levels = { takeProfitUsd: '82000', stopLossUsd: '86000' }; t.client.book.bid = '85000.04'; t.client.book.ask = '85001';
    const p = planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now());
    expect(p.limitPrice).toBe('84915.1'); expect(p.sizingPrice).toBe('85001');
  });
  it('enforces net RR again at the worst permitted entry', () => {
    const t = setup(); t.request.levels!.takeProfitUsd = '85000';
    expect(() => planEntry(t.request, t.settings, t.client.instrument, t.client.book, t.clock.now())).toThrow('RR_BELOW_MINIMUM');
    expect(() => ExecutorSettingsSchema.parse({ ...t.settings, leverage: '10' })).toThrow();
  });
});
describe('entry/account gates', () => {
  it('dry run has payload but zero private reads, persistence and exchange writes', async () => {
    const t = setup('dry_run'); const result = await t.executor.execute(t.request);
    expect(result.status).toBe('DRY_RUN'); expect(result.payload?.qty).not.toBe('100');
    expect(t.client.submitted).toHaveLength(0); expect(t.client.privateReads).toBe(0); expect(t.store.intents.size).toBe(0);
  });
  it('protects full and partial fills through attached native Full TP/SL', async () => {
    for (const ratio of ['1', '.5']) {
      const t = setup(); t.client.fillRatio = ratio; const result = await t.executor.execute(t.request);
      expect(result.status).toBe('PROTECTED'); expect(result.protectionConfirmed).toBe(true); expect(t.client.stopWrites).toBe(0);
      expect(t.client.submitted[0]).toMatchObject({ orderType: 'Limit', timeInForce: 'IOC', tpslMode: 'Full', tpTriggerBy: 'LastPrice', slTriggerBy: 'LastPrice', reduceOnly: false });
      expect(Number(result.qtyFilled)).toBe(Number(result.qtyRequested) * Number(ratio));
    }
  });
  it.each(['margin', 'leverage', 'mode', 'funds', 'withdraw', 'identity', 'position', 'orders'])('blocks incompatible %s without mutation', async condition => {
    const t = setup();
    if (condition === 'margin') t.client.account.marginMode = 'PORTFOLIO_MARGIN';
    if (condition === 'leverage') t.client.positions[0]!.leverage = '2';
    if (condition === 'mode') t.client.positions[0]!.positionIdx = 1;
    if (condition === 'funds') t.client.account.availableUsdt = '1';
    if (condition === 'withdraw') t.client.account.canWithdraw = true;
    if (condition === 'identity') t.client.account.uid = 'another';
    if (condition === 'position') t.client.positions[0]!.size = '.1';
    if (condition === 'orders') t.client.orders.push({ orderId: 'foreign', orderLinkId: '', symbol: 'BTCUSDT', side: 'Buy', orderStatus: 'New', qty: '1', cumExecQty: '0', leavesQty: '1', avgPrice: '', reduceOnly: false, positionIdx: 0, createdTime: '0' });
    expect((await t.executor.execute(t.request)).status).toBe('BLOCKED'); expect(t.client.submitted).toHaveLength(0);
  });
  it('allows live without historical testnet evidence or validated scenario labels and confirms native TP/SL', async () => {
    const t = setup('live'); t.request.isDemo = true; t.request.sourcesValidated = false;
    expect(t.settings.compatibilityAttestation).toBeUndefined();
    const result = await t.executor.execute(t.request);
    expect(result.status).toBe('PROTECTED'); expect(result.protectionConfirmed).toBe(true);
    expect(t.client.submitted).toHaveLength(1); expect(t.client.stopWrites).toBe(0);
    expect(t.request.isDemo).toBe(true); expect(t.request.sourcesValidated).toBe(false);
    expect(t.settings.compatibilityAttestation).toBeUndefined();
  });
  it('allows live with REGULAR_MARGIN, leverage 20 and 2000 USD notional', async () => {
    const t = setup('live');
    const settings = ExecutorSettingsSchema.parse({
      ...t.settings,
      targetPositionNotionalUsd: '2000',
      leverage: '20',
    });
    t.client.account.marginMode = 'REGULAR_MARGIN';
    t.client.positions[0]!.leverage = '20';
    const executor = new BybitExecutor(t.client, t.store, settings, t.clock);
    const result = await executor.execute(t.request);
    expect(result.status).toBe('PROTECTED');
    expect(result.leverage).toBe('20');
    expect(Number(result.notionalPlannedUsd)).toBeLessThanOrEqual(2000);
    expect(Number(result.notionalPlannedUsd)).toBeGreaterThan(1500);
  });
  it('separates environments and still blocks synthetic live input before submission', async () => {
    const t = setup('live');
    t.request.snapshotSynthetic = true;
    expect((await t.executor.execute(t.request)).reasonCodes).toContain('LIVE_SYNTHETIC_INPUT');
    expect(() => new BybitExecutor(t.client, t.store, { ...t.settings, environment: 'testnet' }, t.clock)).toThrow();
    expect(t.client.submitted).toHaveLength(0); expect(t.store.intents.size).toBe(0);
  });
});
describe('durable intent and concurrency', () => {
  it('concurrent invocations produce one entry and persist SUBMITTING before sending', async () => {
    const t = setup(); t.client.onCreate = () => expect([...t.store.intents.values()][0]?.state).toBe('SUBMITTING');
    const results = await Promise.all([t.executor.execute(t.request), t.executor.execute(t.request)]);
    expect(t.client.submitted).toHaveLength(1); expect(results.map(r => r.status)).toContain('LOCKED');
    expect(stableOrderLinkId(t.executor.scope, t.request.scenarioId).length).toBeLessThanOrEqual(36);
  });
  it('ambiguous acceptance is investigated, never blindly resent', async () => {
    const t = setup(); t.client.entryAmbiguousAfterAccept = true;
    expect((await t.executor.execute(t.request)).status).toBe('PROTECTED');
    await t.executor.execute(t.request); expect(t.client.submitted).toHaveLength(1);
  });
  it('no recent/history evidence stays UNKNOWN and cannot open another scenario', async () => {
    const t = setup(); t.client.entryAmbiguousWithoutEvidence = true;
    expect((await t.executor.execute(t.request)).status).toBe('UNKNOWN');
    expect((await t.executor.execute({ ...t.request, scenarioId: 'second' })).reasonCodes).toContain('OTHER_INTENT_UNRESOLVED');
    expect(t.client.submitted).toHaveLength(1);
  });
  it('recovers a crash after submission before saving acknowledgment without duplication', async () => {
    const t = setup(); const save = t.store.saveIntent.bind(t.store); let crash = true;
    t.store.saveIntent = async (lease: Lease, intent: Intent) => {
      if (t.client.submitted.length && crash) { crash = false; throw new Error('SIMULATED_PERSISTENCE_CRASH'); }
      return save(lease, intent);
    };
    expect((await t.executor.execute(t.request)).status).toBe('BLOCKED');
    expect([...t.store.intents.values()][0]?.state).toBe('SUBMITTING');
    expect((await t.executor.execute(t.request)).status).toBe('PROTECTED'); expect(t.client.submitted).toHaveLength(1);
  });
  it.each(['rejected', 'cancelled'])('consumes a %s IOC and never reenters even with a changed config', async condition => {
    const t = setup(); if (condition === 'rejected') t.client.entryReject = true; else t.client.fillRatio = '0';
    expect((await t.executor.execute(t.request)).status).toBe(condition === 'rejected' ? 'REJECTED' : 'CANCELLED');
    await t.executor.execute({ ...t.request, configHash: 'changed' }); expect(t.client.submitted).toHaveLength(1);
  });
  it('persistence failure blocks submission', async () => {
    const t = setup(); t.store.createIntent = async () => { throw new Error('Firestore unavailable'); };
    expect((await t.executor.execute(t.request)).status).toBe('BLOCKED'); expect(t.client.submitted).toHaveLength(0);
  });
  it('rechecks quote and FX after slow persistence and never sends an expired plan', async () => {
    const t = setup(); t.request.validUntilUtc = new Date(t.clock.now() + 300000).toISOString();
    const save = t.store.saveIntent.bind(t.store);
    t.store.saveIntent = async (lease, intent) => { await save(lease, intent); if (intent.state === 'SUBMITTING') t.clock.time += 60001; };
    const result = await t.executor.execute(t.request);
    expect(result.status).toBe('CANCELLED'); expect(result.reasonCodes).toContain('QUOTE_STALE_OR_INVALID'); expect(t.client.submitted).toHaveLength(0);
  });
  it('stale fencing cannot mutate or overwrite another lease', async () => {
    const t = setup(); const lease = (await t.store.acquire(t.executor.scope, 'worker-1', t.clock.now(), 10))!;
    t.clock.time += 11; const replacement = await t.store.acquire(t.executor.scope, 'worker-2', t.clock.now(), 100);
    await expect(t.store.assertLease(lease, t.clock.now())).rejects.toThrow();
    await t.store.release(lease); expect(await t.store.acquire(t.executor.scope, 'worker-3', t.clock.now(), 100)).toBeNull(); expect(replacement?.fence).toBeGreaterThan(lease.fence);
  });
});
describe('protective management and ownership', () => {
  it('reconciles missing stops natively before confirming protection', async () => {
    const t = setup(); t.client.initialProtection = false;
    expect((await t.executor.execute(t.request)).status).toBe('PROTECTED'); expect(t.client.stopWrites).toBe(1);
  });
  it.each(['testnet', 'live'] as const)('missing/rejected native protection in %s triggers reduceOnly emergency and confirms flat', async mode => {
    const t = setup(mode); t.client.initialProtection = false; t.client.protectionWritesFail = true;
    const result = await t.executor.execute(t.request);
    expect(result.status).toBe('EMERGENCY_CLOSE_PENDING'); expect(result.reasonCodes).toContain('NATIVE_PROTECTION_UNCONFIRMED');
    expect(t.client.submitted[1]).toMatchObject({ reduceOnly: true, orderType: 'Market' });
    expect((await t.executor.reconcile()).status).toBe('EMERGENCY_CLOSE_PENDING');
    t.clock.time += 2000; expect((await t.executor.reconcile()).status).toBe('CLOSED');
    await t.executor.execute(t.request); expect(t.client.submitted.filter(p => !p.reduceOnly)).toHaveLength(1);
  });
  it('failed emergency is durably pending, then a later reconciliation completes the close', async () => {
    const t = setup(); t.client.initialProtection = false; t.client.protectionWritesFail = true; t.client.closeReject = true;
    expect((await t.executor.execute(t.request)).status).toBe('EMERGENCY_CLOSE_PENDING');
    expect(Number(t.client.positions[0]!.size)).toBeGreaterThan(0); expect([...t.store.intents.values()][0]?.nextReconcileAtUtc).toBeTruthy();
    t.client.closeReject = false; await t.executor.reconcile(); await t.executor.reconcile(); t.clock.time += 2000;
    expect((await t.executor.reconcile()).status).toBe('CLOSED');
  });
  it('ambiguous reduceOnly acknowledgement never proves CLOSED', async () => {
    const t = setup(); await t.executor.execute(t.request); t.clock.time = Date.parse(t.request.expiresAtUtc) + 1; t.client.closeAmbiguousAfterAccept = true;
    expect((await t.executor.reconcile()).status).toBe('EMERGENCY_CLOSE_PENDING');
    await t.executor.reconcile(); t.clock.time += 2000; expect((await t.executor.reconcile()).status).toBe('CLOSED'); expect(t.client.submitted).toHaveLength(2);
  });
  it('NO_TRADE/opposite signal/paused entries keep native protection', async () => {
    const t = setup(); await t.executor.execute(t.request);
    expect((await t.executor.execute({ ...t.request, decision: 'NO_TRADE' })).status).toBe('PROTECTED');
    const paused = new BybitExecutor(t.client, t.store, { ...t.settings, allowNewEntries: false }, t.clock);
    expect((await paused.execute({ ...t.request, decision: 'SHORT' })).status).toBe('PROTECTED'); expect(t.client.submitted).toHaveLength(1); expect(t.client.cancelled).toHaveLength(0);
  });
  it('wallet failure cannot block reconciliation when account identity remains verifiable', async () => {
    const t = setup(); await t.executor.execute(t.request);
    const client = t.client as FakeBybitClient & { getAccountIdentity: () => Promise<{uid: string}> };
    client.getAccountIdentity = async () => ({ uid: 'fake-account' });
    client.getAccount = async () => { throw new Error('wallet outage'); };
    expect((await t.executor.reconcile()).status).toBe('PROTECTED');
  });
  it('expiry closes only its position, while a disabled expiry policy keeps protection', async () => {
    for (const close of [true, false]) {
      const t = setup(); t.request.closeOnScenarioExpiry = close; await t.executor.execute(t.request); t.clock.time = Date.parse(t.request.expiresAtUtc) + 1;
      expect((await t.executor.reconcile()).status).toBe(close ? 'EMERGENCY_CLOSE_PENDING' : 'PROTECTED');
      expect(t.client.submitted.filter(p => p.reduceOnly).length).toBe(close ? 1 : 0);
    }
  });
  it('manual position changes block ownership and never close unrelated volume', async () => {
    const t = setup(); await t.executor.execute(t.request); t.client.positions[0]!.size = '0.3'; t.clock.time = Date.parse(t.request.expiresAtUtc) + 1;
    expect((await t.executor.reconcile()).reasonCodes).toContain('OWNERSHIP_CONFLICT'); expect(t.client.submitted).toHaveLength(1);
  });
  it('retains fees in their actual currency and closes when net RR cannot be checked in USDT', async () => {
    const t = setup(); await t.executor.execute(t.request); t.client.fills[0]!.feeCurrency = 'MNT';
    const result = await t.executor.reconcile();
    expect(result.reasonCodes).toContain('ACTUAL_FEE_CURRENCY_UNSUPPORTED'); expect(result.feesByCurrency).toHaveProperty('MNT');
    expect(t.client.submitted[1]).toMatchObject({ reduceOnly: true, qty: t.client.submitted[0]?.qty });
  });
  it('actual entry nominal over budget reduces excess and does not rebalance later market gains', async () => {
    const t = setup(); t.request.decision = 'SHORT'; t.request.levels = { takeProfitUsd: '82000', stopLossUsd: '86000' };
    t.client.book.bid = '85000'; t.client.book.ask = '85001'; t.client.fillPrice = '85500';
    t.client.instrument.qtyStep = '0.000001'; t.client.instrument.minOrderQty = '0.000001'; t.client.instrument.minNotionalValue = '0.1';
    expect((await t.executor.execute(t.request)).status).toBe('EMERGENCY_CLOSE_PENDING');
    expect(t.client.submitted[1]?.qty).toBe('0.000007');
    expect((await t.executor.reconcile()).status).toBe('PROTECTED');
    t.client.book.ask = '95000'; t.client.book.bid = '94999'; await t.executor.reconcile(); expect(t.client.submitted).toHaveLength(2);
  });
  it('closes whole own position if an excess reduction cannot meet exchange minimum', async () => {
    const t = setup(); t.client.fillPrice = '94000'; t.request.levels = { takeProfitUsd: '120000', stopLossUsd: '82000' }; t.client.instrument.minNotionalValue = '20';
    expect((await t.executor.execute(t.request)).status).toBe('EMERGENCY_CLOSE_PENDING');
    expect(t.client.submitted[1]?.qty).toBe(t.client.submitted[0]?.qty);
  });
});
