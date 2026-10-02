import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import type { ExecutorStore, Intent, Lease } from '../../../packages/execution/bybit/types';
import { hash, jsonValue } from './audit-store';

export class FirestoreExecutorStore implements ExecutorStore {
  constructor(private readonly db: Firestore, private readonly enqueue: (scope: string, dueUtc: string) => Promise<void> = async () => {}, private readonly now = Date.now) {}
  private lock(scope: string) { return this.db.collection('executionScopes').doc(hash(scope)); }
  private check(doc: DocumentSnapshot, lease: Lease, now: number): void {
    const data = doc.data();
    if (!data || data.owner !== lease.owner || data.fence !== lease.fence || Number(data.expiresAtMs) <= now) throw new Error('LEASE_LOST');
  }
  async acquire(scope: string, owner: string, nowMs: number, ttlMs: number): Promise<Lease | null> {
    const ref = this.lock(scope);
    return this.db.runTransaction(async tx => {
      const doc = await tx.get(ref); const data = doc.data();
      if (data && Number(data.expiresAtMs) > nowMs) return null;
      const lease = {scope, owner, fence: Number(data?.fence ?? 0) + 1, expiresAtMs: nowMs + ttlMs};
      tx.set(ref, lease); return lease;
    });
  }
  async assertLease(lease: Lease, nowMs: number): Promise<void> { this.check(await this.lock(lease.scope).get(), lease, nowMs); }
  async readIntents(lease: Lease): Promise<Intent[]> {
    await this.assertLease(lease, this.now());
    return (await this.lock(lease.scope).collection('intents').get()).docs.map(d => d.data() as Intent);
  }
  private writeIntent(tx: Transaction, lease: Lease, intent: Intent): void {
    if (intent.scope !== lease.scope) throw new Error('SCOPE_MISMATCH');
    const ref = this.lock(lease.scope).collection('intents').doc(hash(intent.scenarioId));
    const data = jsonValue(intent);
    tx.set(ref, data);
    tx.set(ref.collection('revisions').doc(hash(data)), data);
    // Atomic outbox survives a crash between Firestore and Cloud Tasks.
    tx.set(this.db.collection('reconciliationOutbox').doc(hash(lease.scope)), {
      scope: lease.scope, dueUtc: intent.nextReconcileAtUtc ?? null,
      updatedAtUtc: intent.updatedAtUtc, scenarioId: intent.scenarioId,
    });
  }
  async createIntent(lease: Lease, intent: Intent): Promise<boolean> {
    const ref = this.lock(lease.scope).collection('intents').doc(hash(intent.scenarioId));
    const created = await this.db.runTransaction(async tx => {
      const [lock, old] = await Promise.all([tx.get(this.lock(lease.scope)), tx.get(ref)]);
      this.check(lock, lease, this.now());
      if (old.exists) return false;
      this.writeIntent(tx, lease, intent); return true;
    });
    if (created && intent.nextReconcileAtUtc) await this.enqueue(lease.scope, intent.nextReconcileAtUtc);
    return created;
  }
  async saveIntent(lease: Lease, intent: Intent): Promise<void> {
    await this.db.runTransaction(async tx => {
      const [lock, old] = await Promise.all([tx.get(this.lock(lease.scope)), tx.get(this.lock(lease.scope).collection('intents').doc(hash(intent.scenarioId)))]);
      this.check(lock, lease, this.now());
      if (!old.exists || old.data()?.id !== intent.id) throw new Error('INTENT_MISMATCH');
      this.writeIntent(tx, lease, intent);
    });
    if (intent.nextReconcileAtUtc) {
      // Protective exchange actions must continue even while Cloud Tasks is down.
      // The atomic outbox plus the independent minute recovery job retain the work.
      try { await this.enqueue(lease.scope, intent.nextReconcileAtUtc); }
      catch {
        try { await this.db.collection('reconciliationOutbox').doc(hash(lease.scope)).set({dispatchError:'RECONCILIATION_QUEUE_UNAVAILABLE',dispatchFailedAtUtc:new Date(this.now()).toISOString()},{merge:true}); } catch { /* the original intent/outbox commit already succeeded */ }
      }
    }
  }
  async release(lease: Lease): Promise<void> {
    const ref = this.lock(lease.scope);
    await this.db.runTransaction(async tx => {
      const doc = await tx.get(ref); const data = doc.data();
      if (data?.owner === lease.owner && data.fence === lease.fence) tx.update(ref, { expiresAtMs: 0 });
    });
  }
}
