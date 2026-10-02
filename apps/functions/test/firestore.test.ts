import { afterAll, describe, expect, it } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { FirestoreExecutorStore } from '../src/executor-store';
import { AuditStore, hash } from '../src/audit-store';
import { makeFixture } from '../../../fixtures';
import { evaluateScenario } from '../../../packages/strategies/btc-strategy-nfp-etf-v1/src';
import type { Evaluation, Snapshot } from '../../../packages/shared/src';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
describe.skipIf(!enabled)('Firestore emulator transactions (never production)', () => {
  const app = enabled ? initializeApp({projectId:'demo-trade-functions'},randomUUID()) : undefined;
  const db = app ? getFirestore(app) : undefined;
  afterAll(async () => { if (app) await deleteApp(app); });
  it('serializes parallel acquisition and rejects stale fencing', async () => {
    const store = new FirestoreExecutorStore(db!,undefined,()=>1000);
    const scope = randomUUID();
    const leases = await Promise.all([store.acquire(scope,'a',1000,100),store.acquire(scope,'b',1000,100)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const first = leases.find(Boolean)!;
    const next = await store.acquire(scope,'c',1101,100);
    expect(next!.fence).toBe(first.fence+1);
    await expect(store.assertLease(first,1101)).rejects.toThrow('LEASE_LOST');
    await store.release(first);
    await store.assertLease(next!,1102);
  });
  it('keeps evaluations immutable and older completions cannot replace latest', async () => {
    const store = new AuditStore(db!); const scenarioId = randomUUID();
    const a = {evaluationId:randomUUID(),scenarioId,configHash:'a',evaluatedAtUtc:'2026-10-02T13:00:00Z',decision:'NO_TRADE'};
    const b = {...a,evaluationId:randomUUID(),evaluatedAtUtc:'2026-10-02T12:55:00Z',decision:'LONG'};
    await store.save(a,a.evaluatedAtUtc); await store.save(b,b.evaluatedAtUtc);
    const {hash} = await import('../src/audit-store');
    expect((await db!.collection('latest').doc(hash(scenarioId)).get()).data()?.decision).toBe('NO_TRADE');
    await store.save({...a,decision:'SHORT'},a.evaluatedAtUtc);
    expect((await store.read(a.evaluationId))?.decision).toBe('NO_TRADE');
  });
  it('freezes exactly one canonical decision before concurrent workers may execute',async()=>{
    const store=new AuditStore(db!);const fixture=makeFixture();const evaluationId=randomUUID();
    const firstSnapshot=fixture.snapshot;const secondSnapshot={...structuredClone(fixture.snapshot),quote:null};
    async function candidate(snapshot:Snapshot):Promise<Evaluation>{
      const saved=await store.snapshot(snapshot);const evaluation=evaluateScenario(snapshot,fixture.config,fixture.now);
      return {...evaluation,evaluationId,snapshot:{...evaluation.snapshot,...saved}};
    }
    const [long,noTrade]=await Promise.all([candidate(firstSnapshot),candidate(secondSnapshot)]);
    const now=Date.parse(fixture.now);
    const claims=await Promise.all([
      store.prepare({evaluation:long,snapshot:firstSnapshot,scheduledAtUtc:fixture.now,owner:'a',nowMs:now}),
      store.prepare({evaluation:noTrade,snapshot:secondSnapshot,scheduledAtUtc:fixture.now,owner:'b',nowMs:now}),
    ]);
    expect(claims.filter(c=>c.status==='ACQUIRED')).toHaveLength(1);
    expect(claims.filter(c=>c.status==='BUSY')).toHaveLength(1);
    const winner=claims.find(c=>c.status==='ACQUIRED')!;
    if(winner.status!=='ACQUIRED')throw new Error('missing winner');
    expect(winner.evaluation.snapshot.hash).toBe(hash(winner.snapshot));
    await expect(store.save({...winner.evaluation,decision:'SHORT'},fixture.now)).rejects.toThrow('REQUIRES_FINALIZE');
    await expect(store.finalize({...winner.evaluation,decision:winner.evaluation.decision==='LONG'?'NO_TRADE':'LONG'},
      fixture.now,winner.lease,now+1)).rejects.toThrow('CANONICAL_DECISION_MISMATCH');
    const final=await store.finalize({...winner.evaluation,execution:{status:'PROTECTED'}},fixture.now,winner.lease,now+2);
    expect(final.snapshot.hash).toBe(winner.evaluation.snapshot.hash);
    expect((await store.read(evaluationId))?.decision).toBe(winner.evaluation.decision);
  });
  it('reclaims a crashed draft using its original snapshot and rejects the old fencing token',async()=>{
    const store=new AuditStore(db!);const fixture=makeFixture();const evaluationId=randomUUID();const now=Date.parse(fixture.now);
    const saved=await store.snapshot(fixture.snapshot);
    const evaluated=evaluateScenario(fixture.snapshot,fixture.config,fixture.now);
    const evaluation={...evaluated,evaluationId,snapshot:{...evaluated.snapshot,...saved}};
    const first=await store.prepare({evaluation,snapshot:fixture.snapshot,scheduledAtUtc:fixture.now,owner:'crashed',nowMs:now});
    if(first.status!=='ACQUIRED')throw new Error('missing initial claim');
    const alternative={...structuredClone(fixture.snapshot),quote:null};const alternateSaved=await store.snapshot(alternative);
    const alternateEvaluated=evaluateScenario(alternative,fixture.config,fixture.now);
    const alternate={...alternateEvaluated,evaluationId,snapshot:{...alternateEvaluated.snapshot,...alternateSaved}};
    const recovered=await store.prepare({evaluation:alternate,snapshot:alternative,scheduledAtUtc:fixture.now,owner:'recovery',nowMs:now+240001});
    if(recovered.status!=='ACQUIRED')throw new Error('missing recovered claim');
    expect(recovered.recovered).toBe(true);expect(recovered.evaluation.decision).toBe('LONG');
    expect(recovered.evaluation.snapshot.hash).toBe(hash(fixture.snapshot));expect(recovered.snapshot).toEqual(fixture.snapshot);
    expect(recovered.lease.fence).toBe(first.lease.fence+1);
    await expect(store.finalize(evaluation,fixture.now,first.lease,now+240002)).rejects.toThrow('CLAIM_LOST');
    await store.finalize(recovered.evaluation,fixture.now,recovered.lease,now+240002);
    expect((await store.read(evaluationId))?.decision).toBe('LONG');
  });
});
