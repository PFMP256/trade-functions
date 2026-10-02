import Decimal from 'decimal.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_NFP_STRATEGY_ID, evaluationSchema, type Evaluation, type Snapshot } from '../../../packages/shared/src';
import { makePublicFixture } from '../../../fixtures/public';
import { BybitExecutor } from '../../../packages/execution/bybit/executor';
import { ExecutionRequestSchema, ExecutionResultSchema, type ExecutionResult } from '../../../packages/execution/bybit/types';
import { FakeBybitClient, FakeClock, MemoryExecutorStore } from '../../../packages/execution/bybit/testing';
import { executionRequest, runEvaluation, type OrchestratorDeps } from '../src/orchestrator';
import { hash, type EvaluationLease } from '../src/audit-store';

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Integration tests must never contact an exchange or source'); })));
afterEach(() => vi.unstubAllGlobals());

/** Actual dispatcher, orchestrator and executor; only source data, exchange and persistence are synthetic. */
function harness(direction: 'LONG' | 'SHORT' = 'LONG', tradingMode: 'dry_run' | 'testnet' | 'live' = 'dry_run') {
  const fixture = makePublicFixture(direction); fixture.config.tradingMode = tradingMode;
  const environment = tradingMode === 'live' ? 'mainnet' : 'testnet';
  fixture.config.environment = environment; fixture.snapshot.environment = environment; fixture.snapshot.quote!.environment = environment;
  const clock = new FakeClock(Date.parse(fixture.now));
  const client = new FakeBybitClient(environment, clock);
  client.book = { environment, bid: fixture.snapshot.quote!.bid, ask: fixture.snapshot.quote!.ask, observedAtMs: Date.parse(fixture.snapshot.quote!.provenance.observedAt) };
  const store = new MemoryExecutorStore(() => clock.now());
  const executor = new BybitExecutor(client, store, { tradingMode, environment, expectedAccountId: 'fake-account', dedicatedAccountConfirmed: true, allowNewEntries: true }, clock);
  const sequence: string[] = [];
  const final = new Map<string, Evaluation>();
  const frozen = new Map<string, { evaluation: Evaluation; snapshot: Snapshot; lease: EvaluationLease }>();
  const deps: OrchestratorDeps = {
    now: () => new Date(clock.now()),
    reconcile: vi.fn(async () => { sequence.push('reconcile'); return executor.reconcile(); }),
    execute: vi.fn(async request => {
      sequence.push('execute');
      const canonical = frozen.get(request.evaluationId);
      expect(canonical?.evaluation.strategyId).toBe(PUBLIC_NFP_STRATEGY_ID);
      expect(canonical?.evaluation.decision).toBe(request.decision);
      expect(canonical?.evaluation.configHash).toBe(request.configHash);
      return executor.execute(ExecutionRequestSchema.parse(request));
    }),
    loadSnapshot: vi.fn(async () => { sequence.push('providers'); return structuredClone(fixture.snapshot); }),
    saveSnapshot: async snapshot => { sequence.push('snapshot'); return { hash: hash(snapshot), location: 'snapshots/synthetic-public-integration' }; },
    readEvaluation: async id => final.get(id),
    prepareEvaluation: async input => {
      sequence.push('prepare');
      const complete = final.get(input.evaluation.evaluationId);
      if (complete) return { status: 'COMPLETE', evaluation: structuredClone(complete) };
      const prior = frozen.get(input.evaluation.evaluationId);
      if (prior) return { status: 'BUSY', evaluation: structuredClone(prior.evaluation) };
      const lease = { evaluationId: input.evaluation.evaluationId, owner: input.owner, fence: 1, expiresAtMs: input.nowMs + 240000 };
      const value = { evaluation: structuredClone(input.evaluation), snapshot: structuredClone(input.snapshot), lease };
      frozen.set(input.evaluation.evaluationId, value);
      return { status: 'ACQUIRED', ...structuredClone(value), recovered: false };
    },
    finalizeEvaluation: async (record, _schedule, lease, nowMs) => {
      sequence.push('finalize');
      const canonical = frozen.get(record.evaluationId)!;
      expect(canonical.lease.owner).toBe(lease.owner); expect(lease.expiresAtMs).toBeGreaterThan(nowMs);
      expect(hash({ ...record, execution: {} })).toBe(hash({ ...canonical.evaluation, execution: {} }));
      const validated = evaluationSchema.parse(record); final.set(record.evaluationId, structuredClone(validated)); return validated;
    },
  };
  return { fixture, clock, client, store, executor, sequence, final, frozen, deps };
}

describe('public NFP strategy -> canonical orchestration -> existing Bybit executor', () => {
  it.each(['LONG', 'SHORT'] as const)('%s runs without consensus, Treasury, ETF or wages while preserving 100 USD / 1x sizing', async direction => {
    const t = harness(direction);
    expect(t.fixture.snapshot).toMatchObject({ consensus: null, treasury: [], etf: null, marketCalendar: null, employment: { wages: null } });
    const result = await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    expect(result.strategyId).toBe(PUBLIC_NFP_STRATEGY_ID); expect(result.decision).toBe(direction);
    expect(result.dataQuality).toBe('VALID');
    const execution = ExecutionResultSchema.parse(result.execution);
    expect(execution.status).toBe('DRY_RUN'); expect(execution.leverage).toBe('1');
    expect(new Decimal(execution.notionalPlannedUsd!).lte(100)).toBe(true);
    expect(new Decimal(execution.qtyRequested!).lt('0.01')).toBe(true);
    expect(execution.payload).toMatchObject({ side: direction === 'LONG' ? 'Buy' : 'Sell', orderType: 'Limit', timeInForce: 'IOC', tpslMode: 'Full', tpTriggerBy: 'LastPrice', slTriggerBy: 'LastPrice' });
    expect(t.sequence).toEqual(['reconcile', 'providers', 'snapshot', 'prepare', 'execute', 'finalize']);
    expect(t.client.submitted).toHaveLength(0); expect(t.client.privateReads).toBe(0); expect(t.store.intents.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('testnet simulation protects the position and retry reuses its single durable scenario intent', async () => {
    const t = harness('LONG', 'testnet');
    const first = await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    expect(first.execution.status).toBe('PROTECTED'); expect(t.client.submitted).toHaveLength(1);
    const retry = await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    expect(retry.execution.status).toBe('PROTECTED'); expect(t.client.submitted).toHaveLength(1);
    expect(t.deps.execute).toHaveBeenCalledTimes(1);
    const intent = [...t.store.intents.values()][0]!;
    expect(intent.scenarioId).toBe(t.fixture.config.scenarioId); expect(intent.evaluationId).toBe(first.evaluationId);
    expect(intent.configHash).toBe(first.configHash); expect(intent.protectionConfirmed).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('new strategy signal stays LONG when an incompatible account blocks execution', async () => {
    const t = harness('LONG', 'testnet'); t.client.account.marginMode = 'PORTFOLIO_MARGIN';
    const result = await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    expect(result.decision).toBe('LONG'); expect(result.execution.status).toBe('BLOCKED');
    expect(result.execution.reasonCodes).toContain('MARGIN_MODE_INCOMPATIBLE'); expect(t.client.submitted).toHaveLength(0);
  });
  it('live simulation accepts demo/unvalidated labels without testnet evidence and preserves their audit status', async () => {
    const t = harness('LONG', 'live');
    // Model non-synthetic provider metadata only in this isolated test; global fetch remains disabled.
    t.fixture.snapshot = JSON.parse(JSON.stringify(t.fixture.snapshot, (key, value) => key === 'synthetic' ? false : value));
    const result = await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    expect(result.decision).toBe('LONG'); expect(result.validationStatus).toBe('UNVALIDATED');
    expect(result.execution.status).toBe('PROTECTED'); expect(result.execution.protectionConfirmed).toBe(true);
    expect(t.deps.execute).toHaveBeenCalledWith(expect.objectContaining({ isDemo: true, sourcesValidated: false, snapshotSynthetic: false }));
    expect(t.executor.settings.compatibilityAttestation).toBeUndefined();
    expect(t.client.submitted).toHaveLength(1); expect(fetch).not.toHaveBeenCalled();
  });
  it('a book changed before submission can reject RR without changing the frozen macro decision', async () => {
    const t = harness(); t.client.book.ask = '86000'; t.client.book.bid = '85999';
    const result = await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    expect(result.decision).toBe('LONG'); expect(result.execution.status).toBe('BLOCKED');
    expect(result.execution.reasonCodes).toContain('RR_BELOW_MINIMUM'); expect(t.client.submitted).toHaveLength(0);
  });
  it('provider failure yields a fresh NO_TRADE while the previously owned position remains protected', async () => {
    const t = harness('LONG', 'testnet'); await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    t.deps.loadSnapshot = async () => { t.sequence.push('provider-failure'); throw new Error('Synthetic BLS unavailable'); };
    t.sequence.length = 0;
    const result = await runEvaluation(t.fixture.config, '2026-10-02T12:50:00.000Z', t.deps);
    expect(result.decision).toBe('NO_TRADE'); expect(result.status).toBe('ERROR'); expect(result.execution.status).toBe('PROTECTED');
    expect(t.sequence[0]).toBe('reconcile'); expect(t.client.submitted).toHaveLength(1); expect(t.client.cancelled).toHaveLength(0);
    expect(t.deps.execute).toHaveBeenCalledTimes(1);
  });
  it('new bridge preserves synthetic provenance, so a mainnet executor still blocks it', async () => {
    const t = harness(); const evaluation = await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    const request = executionRequest(evaluation, { ...t.fixture.config, environment: 'mainnet', tradingMode: 'live', demo: false, sourcesValidated: true, validationStatus: 'VALIDATED' }, { ...t.fixture.snapshot, environment: 'mainnet', synthetic: false });
    expect(request.snapshotSynthetic).toBe(true);
    const client = new FakeBybitClient('mainnet', t.clock);
    const executor = new BybitExecutor(client, t.store, { environment: 'mainnet', tradingMode: 'live', expectedAccountId: 'fake-account', dedicatedAccountConfirmed: true, allowNewEntries: true }, t.clock);
    const result: ExecutionResult = await executor.execute(request);
    expect(result.status).toBe('BLOCKED'); expect(result.reasonCodes).toContain('LIVE_SYNTHETIC_INPUT');
    expect(client.submitted).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
  });
  it('paused new entries retain reconciliation and cannot bypass the executor through the new strategy', async () => {
    const t = harness('LONG', 'testnet');
    const paused = new BybitExecutor(t.client, t.store, { environment: 'testnet', tradingMode: 'testnet', expectedAccountId: 'fake-account', dedicatedAccountConfirmed: true, allowNewEntries: false }, t.clock);
    t.deps.execute = request => paused.execute(request);
    const result = await runEvaluation(t.fixture.config, t.fixture.now, t.deps);
    expect(result.decision).toBe('LONG'); expect(result.execution.reasonCodes).toContain('NEW_ENTRIES_PAUSED');
    expect(t.deps.reconcile).toHaveBeenCalledTimes(1); expect(t.client.submitted).toHaveLength(0);
  });
});
