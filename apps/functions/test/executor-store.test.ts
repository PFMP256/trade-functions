import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { FirestoreExecutorStore } from '../src/executor-store';
import { hash } from '../src/audit-store';
import { BybitExecutor } from '../../../packages/execution/bybit/executor';
import { FakeBybitClient, FakeClock, MemoryExecutorStore } from '../../../packages/execution/bybit/testing';
import type { Intent } from '../../../packages/execution/bybit/types';

/** Small atomic Firestore model for the outbox fault boundary. Emulator tests cover the real SDK. */
class TransactionDatabase {
  readonly documents = new Map<string, Record<string, unknown>>();
  activeTransactions = 0;
  failDispatchMarker = false;
  collection(path: string) { return { doc: (id: string) => this.ref(path + '/' + id), get: async () => ({ docs: [...this.documents.entries()].filter(([p]) => p.startsWith(path + '/') && p.split('/').length === path.split('/').length + 1).map(([p]) => this.snapshot(p)) }) }; }
  private snapshot(path: string) { const data = this.documents.get(path); return { exists: Boolean(data), data: () => data ? structuredClone(data) : undefined }; }
  private ref(path: string): { path: string; get: () => Promise<ReturnType<TransactionDatabase['snapshot']>>; collection: (name: string) => ReturnType<TransactionDatabase['collection']>; set: (data: Record<string, unknown>, options?: {merge?: boolean}) => Promise<void> } {
    return { path, get: async () => this.snapshot(path), collection: name => this.collection(path + '/' + name), set: async (data, options) => {
      if (this.failDispatchMarker && data.dispatchError) throw new Error('marker unavailable');
      this.documents.set(path, structuredClone(options?.merge ? { ...this.documents.get(path), ...data } : data));
    } };
  }
  async runTransaction<T>(callback: (tx: { get: (ref: {path: string}) => Promise<ReturnType<TransactionDatabase['snapshot']>>; set: (ref: {path: string}, data: Record<string, unknown>) => void; update: (ref: {path: string}, data: Record<string, unknown>) => void }) => Promise<T>): Promise<T> {
    const staged = new Map<string, Record<string, unknown>>();
    this.activeTransactions++;
    try {
      const output = await callback({ get: async ref => this.snapshot(ref.path), set: (ref, data) => { staged.set(ref.path, structuredClone(data)); }, update: (ref, data) => { staged.set(ref.path, { ...this.documents.get(ref.path), ...structuredClone(data) }); } });
      for (const [path, value] of staged) this.documents.set(path, value);
      return output;
    } finally { this.activeTransactions--; }
  }
  firestore(): Firestore { return this as unknown as Firestore; }
}
async function sampleIntent(): Promise<{ intent: Intent; clock: FakeClock }> {
  const clock = new FakeClock(); const client = new FakeBybitClient('testnet', clock); const memory = new MemoryExecutorStore(() => clock.now());
  const executor = new BybitExecutor(client, memory, { tradingMode: 'testnet', environment: 'testnet', expectedAccountId: 'fake-account', dedicatedAccountConfirmed: true, allowNewEntries: true }, clock);
  await executor.execute({ decision: 'LONG', scenarioId: 'test-outbox', evaluationId: 'test-evaluation', configHash: 'test',
    validUntilUtc: new Date(clock.now() + 60000).toISOString(), expiresAtUtc: new Date(clock.now() + 86400000).toISOString(),
    isDemo: true, sourcesValidated: false, snapshotSynthetic: true, environment: 'testnet', closeOnScenarioExpiry: true,
    usdPerUsdt: { value: '1', observedAtUtc: new Date(clock.now()).toISOString(), verified: true }, levels: { takeProfitUsd: '87400', stopLossUsd: '82900' },
    costs: { entryFeeBps: '5.5', exitFeeBps: '5.5', exitSlippageBps: '5', fundingToTpPerBtcUsdt: '1', fundingToSlPerBtcUsdt: '1', description: 'Synthetic store fixture' }, minRewardRisk: '1.5' });
  return { intent: [...memory.intents.values()][0]!, clock };
}
describe('execution store durable outbox boundaries without a production database', () => {
  it('creation commits PREPARED and outbox before queue failure; retry cannot create another intent', async () => {
    const { intent, clock } = await sampleIntent(); intent.state = 'PREPARED';
    const db = new TransactionDatabase();
    const enqueue = vi.fn(async () => { expect(db.activeTransactions).toBe(0); throw new Error('queue down'); });
    const store = new FirestoreExecutorStore(db.firestore(), enqueue, () => clock.now());
    const lease = (await store.acquire(intent.scope, 'worker', clock.now(), 240000))!;
    await expect(store.createIntent(lease, intent)).rejects.toThrow('queue down');
    expect((await store.readIntents(lease))[0]?.state).toBe('PREPARED');
    expect(db.documents.get('reconciliationOutbox/' + hash(intent.scope))?.dueUtc).toBe(intent.nextReconcileAtUtc);
    expect(await store.createIntent(lease, { ...intent, configHash: 'changed' })).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it('saving a protective state remains successful after queue failure and records recovery metadata', async () => {
    const { intent, clock } = await sampleIntent(); const db = new TransactionDatabase(); let queueDown = false;
    const enqueue = vi.fn(async () => { expect(db.activeTransactions).toBe(0); if (queueDown) throw new Error('queue down'); });
    const store = new FirestoreExecutorStore(db.firestore(), enqueue, () => clock.now());
    const lease = (await store.acquire(intent.scope, 'worker', clock.now(), 240000))!;
    await store.createIntent(lease, intent); queueDown = true; intent.state = 'CLOSING'; intent.closeReason = 'NATIVE_PROTECTION_UNCONFIRMED';
    await expect(store.saveIntent(lease, intent)).resolves.toBeUndefined();
    expect((await store.readIntents(lease))[0]?.state).toBe('CLOSING');
    expect(db.documents.get('reconciliationOutbox/' + hash(intent.scope))).toMatchObject({ dueUtc: intent.nextReconcileAtUtc, dispatchError: 'RECONCILIATION_QUEUE_UNAVAILABLE' });
    expect([...db.documents.keys()].filter(path => path.includes('/revisions/')).length).toBe(2);
  });
  it('secondary dispatch-error logging failure cannot erase an already committed emergency state', async () => {
    const { intent, clock } = await sampleIntent(); const db = new TransactionDatabase(); let queueDown = false;
    const store = new FirestoreExecutorStore(db.firestore(), async () => { if (queueDown) throw new Error('queue down'); }, () => clock.now());
    const lease = (await store.acquire(intent.scope, 'worker', clock.now(), 240000))!;
    await store.createIntent(lease, intent); queueDown = true; db.failDispatchMarker = true; intent.state = 'EMERGENCY_CLOSE_PENDING';
    await expect(store.saveIntent(lease, intent)).resolves.toBeUndefined();
    expect((await store.readIntents(lease))[0]?.state).toBe('EMERGENCY_CLOSE_PENDING');
    expect(db.documents.get('reconciliationOutbox/' + hash(intent.scope))?.dueUtc).toBeTruthy();
  });
  it('expired fences reject intent writes before enqueue and cannot release a replacement worker', async () => {
    const { intent, clock } = await sampleIntent(); const db = new TransactionDatabase(); const enqueue = vi.fn(async () => {});
    const store = new FirestoreExecutorStore(db.firestore(), enqueue, () => clock.now());
    const first = (await store.acquire(intent.scope, 'first', clock.now(), 10))!;
    await store.createIntent(first, intent); clock.time += 11;
    const second = (await store.acquire(intent.scope, 'second', clock.now(), 1000))!;
    await expect(store.saveIntent(first, intent)).rejects.toThrow('LEASE_LOST');
    expect(enqueue).toHaveBeenCalledTimes(1); await store.release(first); await expect(store.assertLease(second, clock.now())).resolves.toBeUndefined();
  });
});
